import { expect, test, type Page } from "@playwright/test";

// Animation smoke tests also catch a release that serves new HTML with missing
// hashed JS: an SSR screenshot alone cannot establish client hydration.
async function openHome(page: Page) {
  const scriptFailures: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("response", response => {
    if (response.request().resourceType() === "script") {
      const mime = response.headers()["content-type"] ?? "";
      if (response.status() >= 400 || !/^(?:application|text)\/(?:javascript|ecmascript)\b/i.test(mime)) {
        scriptFailures.push(new URL(response.url()).pathname);
      }
    }
  });
  page.on("requestfailed", request => {
    if (request.resourceType() === "script") scriptFailures.push(new URL(request.url()).pathname);
  });
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } }));
  await page.goto("/");
  await expect(page.locator("main h1.heading-motion")).toHaveCount(1);
  await expect(page.locator('script[src^="/site.js"]')).toHaveCount(1);
  expect(scriptFailures, "Every JS module referenced by published HTML must exist").toEqual([]);
  expect(runtimeErrors, "Client hydration and motion must start without JS errors").toEqual([]);
}

test("published modules hydrate the page and start the original hero video", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  const video = page.locator(".enclave-hero-video");
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThan(1);
  const startedAt = await video.evaluate(element => (element as HTMLVideoElement).currentTime);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(startedAt + 0.15);
  expect(await video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
});

test("replayed page effects share a pending decoration load and initialize it once", async ({ page }) => {
  let releaseScript!: () => void;
  const gate = new Promise<void>(resolve => { releaseScript = resolve; });
  let downloads = 0;
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } }));
  await page.route(/\/site\.js(?:\?|$)/, async route => {
    downloads += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response, body: `window.enclaveDecorationExecutions = (window.enclaveDecorationExecutions || 0) + 1;\n${await response.text()}` });
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => downloads).toBe(1);
    await expect(page.locator('script[src^="/site.js"]')).toHaveCount(1);
  } finally {
    releaseScript();
  }
  await expect(page.locator("main h1.heading-motion")).toHaveCount(1);
  expect(await page.evaluate(() => Reflect.get(window, "enclaveDecorationExecutions"))).toBe(1);
  const decoratedCards = await page.locator(".pain-reveal").count();
  expect(decoratedCards).toBeGreaterThan(0);
  await expect(page.locator(".pain-reveal > .glitch-layer-1")).toHaveCount(decoratedCards);
  await page.reload();
  await expect(page.locator("main h1.heading-motion")).toHaveCount(1);
  await expect(page.locator('script[src^="/site.js"]')).toHaveCount(1);
  expect(downloads).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, "enclaveDecorationExecutions"))).toBe(1);
});

test("scroll triggers change real heading, image and comparison animation states", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  const heading = page.locator("main h2.heading-motion").first();
  const word = heading.locator(":scope > span").first();
  await expect(word).toHaveCSS("opacity", "0");
  await heading.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await expect(heading).toHaveClass(/\bin\b/);
  await expect.poll(() => word.evaluate(element => element.getAnimations().some(animation => animation.playState === "running"))).toBe(true);
  await expect(word).toHaveCSS("opacity", "1");
  await expect(word).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(page.locator(".en-nav")).toHaveClass(/\bscrolled\b/);

  const cover = page.locator(".pixel-cover").first();
  expect(await page.locator(".pixel-cover").count()).toBeGreaterThan(0);
  await cover.evaluate(element => element.parentElement!.scrollIntoView({ behavior: "instant", block: "center" }));
  await expect(cover.locator("i").last()).toHaveCSS("opacity", "0");

  const comparison = page.locator(".framer-mcg4jm");
  const trigger = page.locator("#card-move-trigger");
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => comparison.evaluate(element => element.style.getPropertyValue("--card-progress"))).toBe("0");
  await trigger.evaluate(element => scrollTo({ top: scrollY + element.getBoundingClientRect().bottom, behavior: "instant" }));
  await expect.poll(() => comparison.evaluate(element => element.style.getPropertyValue("--card-progress"))).toBe("1");
  await expect(comparison.locator(".framer-1kwlq3k").first()).toHaveCSS("opacity", "1");
});

test("original scroll scenes and mobile reveals remain active", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  const painCards = page.locator(".pain-reveal");
  expect(await painCards.count()).toBeGreaterThan(0);
  await expect(painCards.first()).not.toHaveClass(/\bvisible\b/);
  await page.locator("#trigger-4").evaluate(element => scrollTo({ top: scrollY + element.getBoundingClientRect().top, behavior: "instant" }));
  await expect.poll(() => page.locator(".pain-reveal.visible").count()).toBe(await painCards.count());
  await expect(painCards.first()).toHaveCSS("opacity", "1");

  const steps = page.locator(".framer-17gr3ut > div");
  await steps.last().evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await expect(page.locator(".framer-1noctq6 p")).toHaveText(String(await steps.count()));
  await expect(page.locator(".framer-st5169-container img")).toHaveAttribute("src", "/assets/network-jordan.jpg");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator("main h1.heading-motion")).toHaveCount(1);
  const mobileHeading = page.locator("main h2.heading-motion").first();
  const mobileWord = mobileHeading.locator(":scope > span").first();
  await expect(mobileWord).toHaveCSS("opacity", "0");
  await mobileHeading.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await expect(mobileHeading).toHaveClass(/\bin\b/);
  await expect.poll(() => mobileWord.evaluate(element => element.getAnimations().some(animation => animation.playState === "running"))).toBe(true);
  await expect(mobileWord).toHaveCSS("opacity", "1");
});

test("native FAQ disclosure animates while reduced motion keeps content accessible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openHome(page);
  const disclosure = page.locator(".faq-list details").first();
  await disclosure.locator("summary").click();
  await expect.poll(() => disclosure.evaluate(element => element.getAnimations().some(animation => animation.playState === "running"))).toBe(true);
  await expect.poll(() => disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
  await expect.poll(() => disclosure.evaluate(element => element.style.overflow)).toBe("");
  await disclosure.locator("summary").click();
  await expect.poll(() => disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator("main h1.heading-motion")).toHaveCount(1);
  const word = page.locator("main h2.heading-motion > span").first();
  await expect(word).toHaveCSS("opacity", "1");
  await expect(word).toHaveCSS("transform", "none");
  await expect(page.locator(".pixel-cover,.page-curtain")).toHaveCount(0);
  expect(await page.locator(".enclave-hero-video").evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await disclosure.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => disclosure.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
  expect(await disclosure.evaluate(element => element.getAnimations().length)).toBe(0);
});
