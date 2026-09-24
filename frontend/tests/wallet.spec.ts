import { expect, test, type Page } from "@playwright/test";

async function installWallets(page: Page, mode: "normal" | "delayed" | "reject" = "normal") {
  await page.addInitScript(({ mode }) => {
    const calls: { name: string; method: string }[] = [];
    Reflect.set(window, "walletFixtureCalls", calls);
    for (const [index, name] of ["Fixture Alpha", "Fixture Beta"].entries()) {
      let accounts = [`0x${String(index + 1).repeat(40)}`], chain = "0x1";
      let approve: (() => void) | undefined;
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const provider = {
        request: async ({ method }: { method: string }) => {
          calls.push({ name, method });
          if (method === "eth_requestAccounts" && mode === "reject") throw { code: 4001, message: "Do not expose wc:private-pairing-data" };
          if (method === "eth_requestAccounts" && mode === "delayed") await new Promise<void>(resolve => { approve = resolve; });
          if (["eth_requestAccounts", "eth_accounts"].includes(method)) return accounts;
          if (method === "eth_chainId") return chain;
          throw new Error(`Unexpected wallet operation: ${method}`);
        },
        on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
        removeListener: (event: string) => { listeners.delete(event); },
      };
      const detail = { info: { uuid: `${index ? "b" : "a"}139eb1f-44df-456a-ad70-197939cf0806`, name, rdns: `test.fixture${index}`, icon: "data:image/svg+xml,<svg/>" }, provider };
      window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })));
      window.addEventListener("fixture-wallet-change", event => {
        const data = (event as CustomEvent<{ accounts?: string[]; chain?: string; approve?: boolean }>).detail;
        if (data.approve) approve?.();
        if (data.accounts) { accounts = data.accounts; listeners.get("accountsChanged")?.(accounts); }
        if (data.chain) { chain = data.chain; listeners.get("chainChanged")?.(chain); }
      });
    }
  }, { mode });
}

test("wallet picker opens without account requests and restores keyboard focus", async ({ page }) => {
  await installWallets(page);
  await page.goto("/dashboard");
  const trigger = page.getByRole("button", { name: "Connect wallet", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Connect your wallet" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Fixture Alpha" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "walletFixtureCalls"))).toEqual([]);
  await modal.getByRole("button", { name: "Close wallet dialog" }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.querySelector(".wallet-dialog")?.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible(); await expect(trigger).toBeFocused();
});

test("selected extension connects without signatures, updates account/network and disconnects", async ({ page }) => {
  await installWallets(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByLabel("Search wallets").fill("Beta");
  await expect(page.getByRole("button", { name: "Fixture Alpha" })).toHaveCount(0);
  await page.getByRole("button", { name: "Fixture Beta" }).click();
  await expect(page.locator(".wallet-network")).toHaveText("Fixture Beta · Ethereum");
  await expect(page.getByRole("dialog", { name: "Connect your wallet" })).not.toBeVisible();
  const calls = await page.evaluate(() => Reflect.get(window, "walletFixtureCalls")) as { name: string; method: string }[];
  expect(calls.every(call => call.name === "Fixture Beta" && ["eth_requestAccounts", "eth_accounts", "eth_chainId"].includes(call.method))).toBe(true);
  // Opening and closing account details must not detach the live event handler.
  await page.locator(".wallet-control .wallet-trigger").click();
  await page.getByRole("button", { name: "Close wallet dialog" }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-wallet-change", { detail: { accounts: [`0x${"3".repeat(40)}`], chain: "0x2105" } })));
  await expect(page.locator(".wallet-network")).toHaveText("Fixture Beta · Base");
  await expect(page.locator(".wallet-control .wallet-trigger")).toContainText("0x3333");
  await page.locator(".wallet-control").getByRole("button", { name: "Disconnect wallet" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
});

test("late extension approval cannot reconnect a cancelled request", async ({ page }) => {
  await installWallets(page, "delayed");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Fixture Alpha" }).click();
  await expect(page.getByText("Approve the connection in your wallet…")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-wallet-change", { detail: { approve: true } })));
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
  await expect(page.locator(".wallet-network")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "walletFixtureCalls").length)).toBe(1);
});

test("rejection is readable and never exposes provider error contents", async ({ page }) => {
  await installWallets(page, "reject");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Fixture Alpha" }).click();
  await expect(page.locator(".wallet-error")).toHaveText("Connection declined in your wallet. You can try again.");
  await expect(page.locator(".wallet-dialog")).not.toContainText("private-pairing-data");
  await expect(page.getByRole("button", { name: "Fixture Alpha" })).toBeEnabled();
});

test("wallet picker fits a narrow screen and explains unavailable remote connections", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installWallets(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await expect(page.getByText("Mobile connections and the full wallet directory are not available", { exact: false })).toBeVisible();
  expect(await page.locator(".wallet-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/wallet-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/wallet-desktop.png" });
});
