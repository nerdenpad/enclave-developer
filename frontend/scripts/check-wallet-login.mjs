import { chromium, expect as baseExpect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Creates a disposable, unfunded test identity. No chain or inference transaction is requested.
const origin = 'https://enclaveagent.tech', account = privateKeyToAccount(generatePrivateKey());
const expect = baseExpect.configure({ timeout: 30_000 });
let executablePath;
if (!existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(name => path.join(cache, name, 'chrome-win64', 'chrome.exe')).find(existsSync);
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
let token;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let signatures = 0, accountPrompts = 0;
  await page.exposeFunction('countAccountPrompt', () => { accountPrompts++; });
  await page.exposeFunction('signLoginFixture', async raw => {
    const message = hexToString(raw), fields = parseSiweMessage(message);
    if (fields.domain !== 'enclaveagent.tech' || fields.uri !== `${origin}/dashboard` || fields.address !== account.address || fields.chainId !== 5042) throw Error('Unexpected login scope');
    signatures++;
    return account.signMessage({ message });
  });
  await page.addInitScript(({ address }) => {
    let selected = address;
    const listeners = new Map();
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts') await window.countAccountPrompt();
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [selected];
        if (method === 'eth_chainId') return '0x13b2';
        if (method === 'personal_sign') return window.signLoginFixture(params[0]);
        throw Error('No payment or transaction is allowed in this login test');
      },
      on(event, fn) { listeners.set(event, fn); }, removeListener(event) { listeners.delete(event); },
    };
    const detail = { info: { uuid: 'a139eb1f-44df-456a-ad70-197939cf0806', name: 'Login acceptance wallet', rdns: 'test.enclave.login', icon: 'data:image/svg+xml,<svg/>' }, provider };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
    window.addEventListener('login-fixture-change', () => { selected = '0x2222222222222222222222222222222222222222'; listeners.get('accountsChanged')?.([selected]); });
  }, { address: account.address });
  await page.goto(`${origin}/dashboard`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#wallet-login-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Login acceptance wallet', exact: false }).click();
  const verified = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/wallet/verify').catch(() => null);
  await page.getByRole('button', { name: 'Sign in with connected wallet', exact: true }).click();
  await expect(page.locator('#wallet-login-status')).toContainText(/Signed in|was not completed/);
  if ((await page.locator('#wallet-login-status').innerText()).includes('was not completed')) throw Error(await page.locator('#connection-error').innerText());
  const response = await verified; expect(response?.status()).toBe(200);
  token = (await response.json()).token;
  await expect(page.locator('#connection-status')).toContainText('Connected');
  await expect(page.locator('#wallet-login-status')).toContainText('Signed in');
  await expect(page.locator('#metric-calls')).toHaveText('0');
  await expect(page.locator('#run-inference')).toBeDisabled();
  expect(signatures).toBe(1);
  for (const route of ['/', '/dashboard']) await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#wallet-login-status')).toContainText('Signed in');
  await expect(page.getByRole('button', { name: 'Disconnect wallet', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#wallet-login-status')).toContainText('Signed in');
  expect(signatures).toBe(1); expect(accountPrompts).toBe(1);
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === '__Secure-enclave-login')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/v1/auth/wallet' });
  expect(await page.evaluate(() => document.cookie)).not.toContain(token);
  const state = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(state)).not.toContain(token);
  const blocked = await page.request.post(`${origin}/api/v1/x402/settle`, { headers: { 'x-api-key': token }, data: {} });
  expect(blocked.status()).toBe(403);
  if (process.env.WALLET_LOGIN_SCREENSHOT) await page.screenshot({ path: process.env.WALLET_LOGIN_SCREENSHOT });
  await page.evaluate(() => window.dispatchEvent(new Event('login-fixture-change')));
  await expect(page.locator('#connection-status')).toHaveText('Disconnected');
  await expect.poll(async () => (await page.request.get(`${origin}/api/v1/workspace`, { headers: { 'x-api-key': token } })).status()).toBe(401);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ origin, walletLogin: 'passed', navigationAndReload: 'passed', personalSignatures: signatures, accountPrompts, workspaceIsolation: 'passed', pilotSpendingBlocked: true, accountChangeLogout: 'passed', credentialsInStorage: false, paidRequests: 0, runtimeErrors: [] }));
} finally {
  if (token) await fetch(`${origin}/api/v1/auth/wallet/logout`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-api-key': token }, body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => {});
  await browser.close();
}
