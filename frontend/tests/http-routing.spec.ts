import { expect, test } from "@playwright/test";
import routes from "../src/enclave/routes.json" with { type: "json" };

test("unknown initial pages have a real 404 status and keep branded navigation", async ({ request }) => {
  for (const path of ["/missing-page", "/technology/missing-page?source=404-check", "/404", "/404/", "/404/index.html"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()["content-type"]).toMatch(/^text\/html\b/);
    const html = await response.text();
    expect(html).toContain("Outside the enclave.");
    expect(html).toContain("Back to Enclave");
    expect(html).toContain('href="/dashboard/"');
    expect(html).toContain("Page not found");
  }
  const head = await request.head("/missing-page");
  expect(head.status()).toBe(404);
  expect(await head.body()).toHaveLength(0);
});

test("known public routes and index.html aliases remain successful", async ({ request }) => {
  for (const path of Object.keys(routes).filter(path => path !== "/404/")) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^text\/html\b/);
  }
  for (const path of ["/index.html", "/technology/index.html", "/dashboard/index.html", "/status", "/verify", "/models"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
  }
});

test("sitemap is valid XML for exactly the canonical public pages and robots links to it", async ({ request, page }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^(?:application|text)\/xml\b/);
  const xml = await response.text();
  expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  const parsed = await page.evaluate(source => {
    const document = new DOMParser().parseFromString(source, "application/xml");
    return {
      errorCount: document.querySelectorAll("parsererror").length,
      namespace: document.documentElement.namespaceURI,
      locations: [...document.querySelectorAll("url > loc")].map(element => element.textContent),
    };
  }, xml);
  expect(parsed.errorCount).toBe(0);
  expect(parsed.namespace).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");
  expect(parsed.locations.sort()).toEqual(Object.keys(routes).filter(path => path !== "/404/")
    .map(path => `https://enclaveagent.tech${path}`).sort());
  const head = await request.head("/sitemap.xml");
  expect(head.status()).toBe(200);
  expect(head.headers()["content-type"]).toMatch(/^(?:application|text)\/xml\b/);
  expect(await head.body()).toHaveLength(0);

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toMatch(/^text\/plain\b/);
  expect(await robots.text()).toMatch(/^Sitemap: https:\/\/enclaveagent\.tech\/sitemap\.xml$/m);
});

test("public assets keep their content types and missing assets are not successful HTML", async ({ request }) => {
  for (const [path, type] of [["/site.js", /(?:java|ecma)script/], ["/enclave.css", /^text\/css\b/], ["/assets/enclave-sphere.png", /^image\/png\b/]] as const) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"]).toMatch(type);
  }
  expect((await request.get("/assets/missing-routing-check.js")).status()).toBe(404);
  expect((await request.get("/sitemap.xml/extra")).status()).toBe(404);
});

test("HTML references successful client modules and stylesheets", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css)(?:\?[^\"]*)?)"/g)].map(match => match[1]!);
  expect(assets.length).toBeGreaterThan(0);
  for (const path of new Set(assets)) {
    expect(path).toMatch(/^\//);
    const stylesheet = path.split("?")[0]!.endsWith(".css");
    // Vite serves CSS module imports as JS unless the request asks for a stylesheet.
    const response = await request.get(path, { headers: { Accept: stylesheet ? "text/css" : "*/*" } });
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toMatch(stylesheet ? /^text\/css\b/ : /(?:java|ecma)script/);
  }
});
