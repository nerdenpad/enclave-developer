import { chromium, expect } from '@playwright/test';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exportSimulation } from './export-simulation.mjs';

// Real local API, database and Anvil transactions. Only computation/attestation
// use the existing development fixture. Never edits or mocks browser responses.
const origin = 'http://127.0.0.1:5173';
const apiKey = process.env.DEMO_API_KEY;
if (!apiKey) throw Error('Load the private local .env.demo profile.');
const healthResponse = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
const health = await healthResponse.json();
if (!healthResponse.ok || health.chainId !== 31337 || health.teeMode !== 'dev' || health.inferenceBackend !== 'echo' || health.paymentMode !== 'mock') {
  throw Error('Recording requires npm run demo:simulate: local Echo, dev mode, mock payment, chain 31337.');
}
const output = fileURLToPath(new URL(`../recordings/simulation-${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
mkdirSync(output, { recursive: true });
let executablePath;
if (!existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  executablePath = readdirSync(cache).filter(x => /^chromium-\d+$/.test(x)).sort((a,b) => Number(b.split('-')[1])-Number(a.split('-')[1]))
    .map(x => path.join(cache, x, 'chrome-win64', 'chrome.exe')).find(existsSync);
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1920, height: 900 }, reducedMotion: 'reduce', locale: 'en-GB', recordVideo: { dir: output, size: { width: 1920, height: 900 } } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const started = Date.now(), scenes = [], responses = [], errors = [];
let passed = false, durationSeconds;
const redact = s => String(s).split(apiKey).join('[redacted]');
page.on('pageerror', e => errors.push(redact(e.message)));
page.on('response', r => { if (r.url().startsWith(`${origin}/api/`)) responses.push({ path: new URL(r.url()).pathname, method: r.request().method(), status: r.status() }); });
// Fail closed if the browser attempts remote API traffic during this recording.
// Static assets are allowed; no GPU or paid provider is contacted.
await context.route('**/*', route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin && ['fetch', 'xhr', 'websocket'].includes(request.resourceType())) return route.abort();
  return route.continue();
});
const caption = async (title, detail, seconds = 7) => {
  scenes.push({ seconds: (Date.now()-started)/1000, title, detail });
  await page.waitForTimeout(seconds*1000);
};
try {
  scenes.push({ seconds: 0, title: 'Enclave | End-to-end development demo', detail: 'Actual local services. Echo computation, software attestation and test tokens; no GPU or real USDC.' });
  await page.goto(`${origin}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-main[data-workspace-ready=true]').waitFor();
  await page.locator('#api-key').fill(apiKey);
  await page.locator('#connect-gateway').click();
  await expect(page.locator('#connection-status')).toContainText('Connected');
  await expect(page.locator('#environment-badge')).toContainText('LOCAL ECHO');
  const initialCalls = Number(await page.locator('#metric-calls').innerText());
  // Let Chromium emit full-size frames before choosing the public clip start.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot();
  await page.waitForTimeout(1000);
  await caption('Connected to the local backend', 'The dashboard reads model configuration, payment settings and history from the running gateway.');
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await expect(page.locator('#model-cards')).toContainText('SERVING NOW');
  await caption('Development computation provider', 'Echo is a deterministic test fixture. This recording does not demonstrate an LLM or GPU attestation.');
  await page.getByRole('tab', { name: 'Inference', exact: true }).click();
  await page.locator('#prompt').fill('Demonstrate an encrypted request, a test payment and a verifiable receipt.');
  await caption('Prepare an encrypted request', 'The browser encrypts the input. Payment must be confirmed before computation runs.');
  await page.locator('#run-inference').click();
  await expect(page.locator('#payment-dialog')).toBeVisible();
  await expect(page.locator('#payment-mode-note')).toContainText('test USDC');
  await caption('Confirm a test payment', 'HTTP 402 returns an amount and recipient. Settlement uses MockUSDC on local Anvil chain 31337.');
  await page.locator('#confirm-payment').click();
  await expect(page.locator('#output-status')).toHaveText('Response verified', { timeout: 60000 });
  await page.locator('.output-panel').scrollIntoViewIfNeeded();
  await caption('Computation completed', 'The browser decrypted and checked the binary test output. This is a fixture result, not a model answer.', 9);
  await page.screenshot({ path: path.join(output, '01-result.png') });
  await page.locator('#open-last-receipt').click();
  await page.locator('#verify-receipt').click();
  await expect(page.locator('#receipt-integrity')).toContainText('Signature and typed hash verified');
  await caption('Verify the signed receipt', 'Model, code, input and output hashes are bound by an EIP-712 signature. The signer is a software development key.', 9);
  await expect(page.locator('#receipt-notice')).toContainText('ANCHORED', { timeout: 45000 });
  await caption('Receipt anchored on Anvil', 'The worker submitted a local blockchain transaction. This is not an Arc mainnet anchor.', 8);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-receipt').click();
  await (await downloadEvent).saveAs(path.join(output, 'simulation-receipt.json'));
  await page.screenshot({ path: path.join(output, '02-receipt.png') });
  await page.getByRole('button', { name: 'Close receipt', exact: true }).click();
  await page.getByRole('tab', { name: 'USDC usage', exact: true }).click();
  await page.locator('#view-payments h2').scrollIntoViewIfNeeded();
  await expect(page.locator('#usage-rows')).toContainText('consumed');
  await caption('Test payment recorded', 'The backend stores the consumed payment and settlement transaction. No real funds were charged.', 8);
  await page.screenshot({ path: path.join(output, '03-payment.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-main[data-workspace-ready=true]').waitFor();
  await page.locator('#api-key').fill(apiKey);
  await page.locator('#connect-gateway').click();
  await expect(page.locator('#connection-status')).toContainText('Connected');
  await expect(page.locator('#metric-calls')).toHaveText(String(initialCalls + 1));
  await page.getByRole('tab', { name: 'Receipts', exact: true }).click();
  await expect(page.locator('#receipt-rows')).toContainText('anchored');
  await caption('History survives a reload', 'Request, payment and anchored receipt remain in the database. GPU verification and real-USDC launch are still pending.', 8);
  expect(errors).toEqual([]);
  expect(responses.filter(r => r.method === 'POST' && r.path === '/api/v1/inference' && r.status === 200)).toHaveLength(1);
  passed = true;
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(redact(error.message).slice(0, 1500));
  console.error(redact((await page.locator('#connection-error,#inference-error,#payment-error').allTextContents().catch(() => [])).join('\n')));
} finally {
  durationSeconds = (Date.now()-started)/1000;
  const video = page.video(); await context.close();
  await video.saveAs(path.join(output, 'source.webm')); await browser.close();
  writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed, mode: 'simulation', provider: 'echo', chainId: 31337, paymentMode: 'mock', realUsdcSpent: 0, gpuInferenceCalls: 0, durationSeconds, scenes, responses, errors }, null, 2));
}
if (!passed) throw Error(`Simulation recording failed. Inspect ${output}; no publishable MP4 was produced.`);
const published = exportSimulation(output);
writeFileSync(path.join(output, 'Publication-notes.txt'), 'Development simulation. No GPU inference or real-USDC payment. Keep the permanent disclosure visible when sharing.\n');
console.log(JSON.stringify({ passed, output: published, gpuInferenceCalls: 0, realUsdcSpent: 0 }));
