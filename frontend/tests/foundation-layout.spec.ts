import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function openFoundation(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } });
    return route.continue();
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const heading = page.getByRole("heading", { name: "Built on trusted hardware", exact: true });
  await expect(heading).toHaveClass(/\bheading-motion\b/);
  await expect(heading.locator(":scope > span")).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  expect(errors).toEqual([]);
  return heading;
}

for (const width of [320, 375, 390, 1440]) {
  test(`Foundation heading fits at ${width}px and retains its word reveal`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const heading = await openFoundation(page, testInfo.project.use.baseURL!);
    const word = heading.locator(":scope > span").first();
    await expect(word).toHaveCSS("opacity", "0");
    await heading.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
    await expect(heading).toHaveClass(/\bin\b/);
    await expect.poll(() => word.evaluate(element => element.getAnimations().some(animation => animation.playState === "running"))).toBe(true);
    const words = heading.locator(":scope > span");
    for (const span of await words.all()) {
      await expect(span).toHaveCSS("opacity", "1");
      await expect(span).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    }
    const geometry = await heading.evaluate(element => {
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        viewport: innerWidth,
        heading: box(element),
        column: box(element.closest(".framer-18xwwhp")!),
        words: Array.from(element.children, box),
        fontSize: getComputedStyle(element).fontSize,
      };
    });
    expect(geometry.heading.left).toBeGreaterThanOrEqual(geometry.column.left - 1);
    expect(geometry.heading.right).toBeLessThanOrEqual(geometry.column.right + 1);
    for (const span of geometry.words) {
      expect(span.left).toBeGreaterThanOrEqual(geometry.column.left - 1);
      expect(span.right).toBeLessThanOrEqual(Math.min(geometry.column.right, width) + 1);
      expect(span.top).toBeGreaterThanOrEqual(geometry.heading.top - 1);
      expect(span.bottom).toBeLessThanOrEqual(geometry.heading.bottom + 1);
    }
    expect(geometry.fontSize).toBe(width < 810 ? "40px" : "64px");
    if (width < 810) expect(geometry.heading.height).toBeGreaterThan(geometry.words[0]!.height);
    else expect(geometry.heading.height).toBe(geometry.words[0]!.height);
    const boundsPath = testInfo.outputPath(`foundation-${width}-bounds.json`);
    await writeFile(boundsPath, JSON.stringify(geometry, null, 2));
    await testInfo.attach("foundation-bounds", { path: boundsPath, contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`foundation-${width}.png`) });
  });
}

test("Foundation stays readable without motion at the smallest mobile width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const heading = await openFoundation(page, testInfo.project.use.baseURL!);
  await heading.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
  const words = heading.locator(":scope > span");
  for (const span of await words.all()) {
    await expect(span).toHaveCSS("opacity", "1");
    expect(await span.evaluate(element => element.getAnimations().length)).toBe(0);
    expect(await span.evaluate(element => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return matrix.isIdentity;
    })).toBe(true);
    const bounds = await span.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
});
