import { chromium, expect as baseExpect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

// Records the hosted UI and real wallet-login API. The unfunded EOA/provider is
// an automated test driver, clearly identified in the captions. No API responses,
// inference outputs, payment events or receipt records are mocked or inserted.
const origin = 'https://enclaveagent.tech';
const output = path.resolve(process.argv[2] || 'recordings/pilot-overview');
if (existsSync(path.join(output, 'Enclave-Pilot-Overview.mp4'))) throw Error('Choose a new output directory.');
mkdirSync(output, { recursive: true });
const account = privateKeyToAccount(generatePrivateKey());
const expect = baseExpect.configure({ timeout: 30_000 });
let executablePath;
if (!existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  executablePath = readdirSync(cache).filter(x => /^chromium-\d+$/.test(x)).sort((a,b) => Number(b.split('-')[1])-Number(a.split('-')[1]))
    .map(x => path.join(cache,x,'chrome-win64','chrome.exe')).find(existsSync);
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1920, height: 900 }, reducedMotion: 'reduce',
  recordVideo: { dir: output, size: { width: 1920, height: 900 } } });
const page = await context.newPage(), started = Date.now(), scenes = [], responses = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.url().startsWith(`${origin}/api/`)) responses.push({ path: new URL(r.url()).pathname, method: r.request().method(), status: r.status() }); });
let signatures = 0, prompts = 0, token, passed = false;
const caption = async (title, detail, seconds = 7) => {
  scenes.push({ seconds: (Date.now()-started)/1000, title, detail });
  await page.waitForTimeout(seconds*1000);
};
try {
  await page.exposeFunction('pilotSign', async raw => {
    const message = hexToString(raw), f = parseSiweMessage(message);
    if (f.domain !== 'enclaveagent.tech' || f.uri !== `${origin}/dashboard` || f.chainId !== 5042 || f.address !== account.address) throw Error('Unexpected signing scope');
    signatures++; return account.signMessage({ message });
  });
  await page.exposeFunction('pilotConnection', () => { prompts++; });
  await page.addInitScript(({ address }) => {
    const listeners = new Map();
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts') { await window.pilotConnection(); return [address]; }
        if (method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return '0x13b2';
        if (method === 'personal_sign') return window.pilotSign(params[0]);
        throw Error('This test wallet cannot make payments or chain transactions');
      }, on(event, fn) { listeners.set(event,fn); }, removeListener(event) { listeners.delete(event); },
    };
    const detail = { info: { uuid: 'b1731661-3807-4b90-93ec-a98fac23a665', rdns: 'test.enclave.recording', name: 'Unfunded test wallet', icon: 'data:image/svg+xml,<svg/>' }, provider };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{ detail })));
  }, { address: account.address });
  scenes.push({ seconds: 0, title: 'Enclave | Development pilot', detail: 'Hosted at enclaveagent.tech. This is a UI walkthrough, not a production inference or payment demonstration.' });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(output,'01-home.png') });
  await caption('Enclave | Development pilot', 'Wallet access, a connected backend and a separate receipt-verification page. E1 production is not released.', 6);
  await page.goto(`${origin}/dashboard`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#wallet-login-panel')).toBeVisible();
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await expect(page.locator('.wallet-dialog')).toBeVisible();
  await expect(page.locator('.wallet-list').last()).not.toBeEmpty();
  await caption('Choose a wallet', 'Browser wallets and a WalletConnect directory. Connecting shares an address; payments need separate approval.', 7);
  await page.getByRole('button',{name:'Unfunded test wallet',exact:false}).click();
  const login = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/wallet/verify'));
  await page.getByRole('button',{name:'Sign in with connected wallet',exact:true}).click();
  const loginResponse = await login; expect(loginResponse.status()).toBe(200); token = (await loginResponse.json()).token;
  await expect(page.locator('#wallet-login-status')).toContainText('Signed in');
  await expect(page.locator('#metric-calls')).toHaveText('0');
  await caption('Sign in with a wallet', 'Unfunded test wallet; the signature is automated for this recording. The live server verifies it and opens a private workspace.', 8);
  await page.screenshot({ path: path.join(output,'02-wallet-login.png') });
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await caption('Navigate away', 'Wallet connection and the signed login survive navigation. Login expires 30 minutes after the original signature.', 5);
  await page.goto(`${origin}/dashboard`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#wallet-login-status')).toContainText('Signed in');
  expect(signatures).toBe(1); expect(prompts).toBe(1);
  await caption('Return without signing again', 'The same empty workspace reloads from the server. No second pairing or login signature; no funds move.', 7);
  await page.goto(`${origin}/status`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('.deployment-badge')).toHaveText('DEVELOPMENT · E1 NOT RELEASED');
  await expect(page.getByText('Local Anvil · chain 31337 · test funds',{exact:true})).toBeVisible();
  await caption('Inspect the actual deployment', 'The gateway reports its model, policy and contracts. Today: local Anvil, MockUSDC and software gateway custody.', 9);
  await page.screenshot({ path:path.join(output,'03-status.png') });
  await caption('Verified inference is currently blocked', 'The NEAR adapter is configured, but NVIDIA attestation checks return HTTP 403 from the server. No successful inference is shown here.', 8);
  await page.goto(`${origin}/verify`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#receipt-json')).toBeEditable();
  await caption('Independent receipt verification', 'A receipt can be imported for signature and optional on-chain checks. This recording contains no completed or anchored receipt.', 8);
  await page.screenshot({path:path.join(output,'04-verification.png')});
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.locator('a[href="https://x.com/enclave_arc"]').first().scrollIntoViewIfNeeded();
  await expect(page.locator('a[href="https://t.me/enclavearc"]').first()).toBeVisible();
  await caption('Follow the build', 'X: @enclave_arc | Telegram: @enclavearc. Next: verified inference, reviewed Arc deployment and real-USDC acceptance tests.', 9);
  expect(errors).toEqual([]);
  expect(responses.filter(r => r.method === 'POST' && !r.path.startsWith('/api/v1/auth/wallet/'))).toHaveLength(0);
  passed = true;
} finally {
  if (token) await fetch(`${origin}/api/v1/auth/wallet/logout`,{method:'POST',headers:{origin,'content-type':'application/json','x-api-key':token},body:'{}',signal:AbortSignal.timeout(10000)}).catch(()=>{});
  const video = page.video(); await context.close();
  await video.saveAs(path.join(output,'source.webm')); await browser.close();
  writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed,recordedAt:new Date().toISOString(),scenes,responses,errors,signatures,prompts,paidRequests:0,automatedUnfundedTestWallet:true},null,2));
}
if (!passed) throw Error('Walkthrough checks failed; do not publish the raw recording.');
const time = s => { const n=Math.floor(s*100);return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,'0')}:${String(Math.floor(n/100)%60).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`; };
const escape = s => s.replace(/[{}\\\r\n]/g,' ');
const wrap = s => { const lines=['']; for(const word of escape(s).split(/\s+/)){if(lines.at(-1).length+word.length>130)lines.push(word);else lines[lines.length-1]+=(lines.at(-1)?' ':'')+word;}return lines.join('\\N'); };
const end=(Date.now()-started)/1000;
const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,26,&H00FFFFFF,&H00FFFFFF,&H00292019,&H00292019,0,0,0,0,100,100,0,0,1,0,0,2,70,70,32,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
writeFileSync(path.join(output,'captions.ass'),ass+scenes.map((s,i)=>`Dialogue: 0,${time(s.seconds)},${time(scenes[i+1]?.seconds??end)},Default,,0,0,0,,{\\b1\\fs32}${escape(s.title)}{\\b0\\fs26}\\N${wrap(s.detail)}`).join('\n'));
const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-i','source.webm','-vf','pad=1920:1080:0:0:color=0x192029,ass=captions.ass','-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p','-r','30','-movflags','+faststart','-an','Enclave-Pilot-Overview.mp4'],{cwd:output,encoding:'utf8',windowsHide:true});
if(result.status!==0) throw Error(result.stderr||'Video export failed');
console.log(JSON.stringify({output:path.join(output,'Enclave-Pilot-Overview.mp4'),passed,signatures,paidRequests:0}));
