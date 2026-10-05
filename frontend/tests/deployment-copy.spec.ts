import { expect, test } from "@playwright/test";
import routes from "../src/enclave/routes.json" with { type: "json" };

const health = { ok: true, service: "gateway", teeMode: "managed-near", inferenceBackend: "near-verified", inferenceRoute: "near-direct-experimental",
  chainId: 5042, paymentMode: "authorized", servingModel: { id: "glm", name: "GLM", modelHash: `0x${"12".repeat(32)}`, codeHash: `0x${"13".repeat(32)}` },
  receiptSigner: `0x${"14".repeat(20)}`, verifierAddress: `0x${"15".repeat(20)}`, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1,
  deployment: { stage: "production", productionReady: true, gatewayKeyCustody: "software", inferenceTrust: "near-cpu-gpu", releaseProfile: "near-arc" },
  providerPolicy: { sha256: `0x${"16".repeat(32)}`, expiresAt: "2026-10-10T00:00:00Z" } };

test("home uses public gateway status without equating production readiness with enabled checkout", async ({ page }) => {
  const headers: Record<string, string>[] = [];
  await page.route("**/api/**", route => {
    headers.push(route.request().headers());
    return route.fulfill({ json: health });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Release status")).toContainText("Production · reported ready");
  await expect(page.getByLabel("Release status")).toContainText("Arc (chain 5042)");
  await expect(page.getByLabel("Release status")).toContainText("Public checkout blocked");
  await expect(page.locator('[data-runtime-copy="home-details"]')).toContainText("Authorized settlement is configured");
  await expect(page.locator('[data-runtime-copy="home-summary"]')).toContainText("Public checkout blocked");
  await expect(page.locator("#site-document")).not.toContainText("MockUSDC");
  await expect(page.locator("#site-document")).not.toContainText("Arc settlement pending");
  expect(headers.length).toBeGreaterThan(0); expect(headers.every(value => !value["x-api-key"])).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("home keeps status unavailable and checkout blocked when public health cannot be read", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } }));
  await page.goto("/");
  await expect(page.getByLabel("Release status")).toContainText("Deployment status unavailable");
  await expect(page.getByLabel("Release status")).toContainText("Public checkout blocked");
  await expect(page.locator('[data-runtime-copy="home-details"]')).toContainText("status is unavailable");
  await expect(page.locator('[data-runtime-copy="home-summary"]')).not.toContainText("reported ready");
});

test("legacy page footers all follow reported status while public checkout remains blocked", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: health });
    return url.origin === "http://127.0.0.1:5173" ? route.continue() : route.abort();
  });
  const pages = Object.entries(routes).filter(([, meta]) => "file" in meta && meta.file !== "home.html" && meta.file !== "dashboard.html");
  expect(pages).toHaveLength(14);
  for (const [path] of pages) {
    await page.goto(path);
    const footer = page.locator('[data-runtime-copy="home-summary"]');
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText("Production · reported ready");
    await expect(footer).toContainText("Arc (chain 5042)");
    await expect(footer).toContainText("Public checkout blocked");
    await expect(footer).not.toContainText("Development pilot");
    for (const details of await page.locator('[data-runtime-copy="home-details"]').all()) {
      await expect(details).toContainText("Authorized settlement is configured");
      await expect(details).toContainText("Public checkout is blocked");
    }
  }
});

test("status history preserves reviewed acceptance and the approved price when live status is unavailable", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } }));
  await page.goto("/status");
  const history = page.getByLabel("Update history");
  await expect(history).toContainText("2026-10-01");
  await expect(history).toContainText("version 2 is listed, approved and activated");
  await expect(history).toContainText("pinned local NVIDIA SDK is deployed");
  await expect(history).toContainText("paid 0.10 USDC and anchored its receipt on Arc");
  await expect(history).toContainText("one settlement and one usage record");
  await expect(history).toContainText("The commercial price is approved at 0.10 USDC per request");
  await expect(history).toContainText("The receipt's Arc anchor and policy were independently confirmed");
  await expect(history).toContainText("Remaining release scenarios are recorded in the acceptance checklist");
  await expect(history).not.toContainText("pending commercial price approval");
  await expect(history.getByRole("link", { name: "Acceptance payment ↗", exact: true })).toHaveAttribute("href", "https://explorer.arc.io/tx/0xaf1de665791e94a8f87f74e00edfdbf7f1cd56f8ec32bf98e0a57c36cbc73f33");
  await expect(history.getByRole("link", { name: "Receipt anchor ↗", exact: true })).toHaveAttribute("href", "https://explorer.arc.io/tx/0xeefdee7f01fd42a28546db8de2d0052f4b6a7711dd03684b6063b2b30ff33e5a");
  await expect(page.locator(".deployment-badge")).toHaveText("STATUS UNAVAILABLE");
});

test("public pages distinguish released payments and remote evidence from planned privacy features", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const origin = new URL(baseURL!).origin;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503, json: { title: "UNAVAILABLE" } });
    return route.continue();
  });
  const boundaries = [
    ["/", ["The application gateway decrypts", "Payment amounts and addresses are public", "Shielded transfers and Nanopayments are roadmap features"]],
    ["/architecture/", ["Arc payment amounts and addresses are public", "Shielded transfers and sealed agents remain roadmap features"]],
    ["/technology/sealed-agents/", ["A planned runtime", "hosted autonomous-agent runtime is disabled", "Amounts and addresses are public"]],
    ["/insights/private-agent-commerce/", ["Arc settlements currently expose payment amounts and addresses", "Shielded transfers are a roadmap feature"]],
    ["/legal/privacy-policy/", ["application gateway decrypts requests", "software-managed keys", "does not isolate the gateway from its operator"]],
    ["/legal/risk-disclosure/", ["software-managed keys", "Current Arc payments have public amounts and addresses", "Shielded transfers are not enabled"]],
  ] as const;
  for (const [path, statements] of boundaries) {
    await page.goto(path);
    for (const statement of statements) await expect(page.locator("#site-document")).toContainText(statement);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /authorized USDC payments/);
  }
});
