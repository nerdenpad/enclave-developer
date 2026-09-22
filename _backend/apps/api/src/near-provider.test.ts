import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import https, { type RequestOptions, type Server } from "node:https";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { X509Certificate, createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { once } from "node:events";
import type { PeerCertificate } from "node:tls";
import { checkNearCertificate, createNearAttestationVerifier, nearBaseUrl, peerSpkiSha256, runNearVerifier } from "./near-provider.js";
import type { NearVerifiedSession } from "@enclave/core";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Public, disposable test credentials. They never authenticate a live service.
const cert = `-----BEGIN CERTIFICATE-----
MIIBwDCCAWagAwIBAgIUMQD2oAhGlSfJ3DB3NudSKladuXowCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9ucy5uZWFyLmFpMB4XDTI2MDkxOTE2
NTA0NVoXDTM2MDkxNjE2NTA0NVowIzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9u
cy5uZWFyLmFpMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKM+30DfU/cWgtugL
zenTuJa/dseF3VDZMIVO55+ESL7d58jcFK2g8F7zjUIkHRz8hHeGly2MvqsxTrJq
Aer9tqN4MHYwHQYDVR0OBBYEFHR6Yox1SFx518FhZ2mkJVfXADW4MB8GA1UdIwQY
MBaAFHR6Yox1SFx518FhZ2mkJVfXADW4MCMGA1UdEQQcMBqCGHRlc3QuY29tcGxl
dGlvbnMubmVhci5haTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUC
IQChTUAFwWg8iwVoHaabSL+IVum2d8ttEN0YQ7VyzPQAnAIgb+VJPWM2zd2DJxWv
O7HIzMtDXaZiAPMrC9zWZDKbttU=
-----END CERTIFICATE-----`;
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgG2E0eisJeTuHZkRF
2szwcb04Qkqo4X5QCkHdXz/9QMyhRANCAAQoz7fQN9T9xaC26AvN6dO4lr92x4Xd
UNkwhU7nn4RIvt3nyNwUraDwXvONQiQdHPyEd4aXLYy+qzFOsmoB6v22
-----END PRIVATE KEY-----`;
const secondCert = `-----BEGIN CERTIFICATE-----
MIIBwTCCAWagAwIBAgIUaW6Nkxbki4NiDQcZFxx5xWAZqzswCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9ucy5uZWFyLmFpMB4XDTI2MDkxOTE2
NTA0NVoXDTM2MDkxNjE2NTA0NVowIzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9u
cy5uZWFyLmFpMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+fISgaA452tpRFJ5
142II+Ah3dl3UMnG8R+edRGjLhq59CPzH8XxARfNgyPwdLbM9fvme3sgrSP0fBLt
nrZNfaN4MHYwHQYDVR0OBBYEFOf1Dgvp9p4s7kQpUdCtUZgwzCk5MB8GA1UdIwQY
MBaAFOf1Dgvp9p4s7kQpUdCtUZgwzCk5MCMGA1UdEQQcMBqCGHRlc3QuY29tcGxl
dGlvbnMubmVhci5haTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYC
IQC3nVbrVBOzWUgpEARjHEj0Pmkx67f9E9afyKpgdDQdAQIhALYZnDBMkVNZ9hl2
OVYBEXpdp0nxtInkrvJf8J4WY/vl
-----END CERTIFICATE-----`;
const secondKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGhjml2+Usi9OiHrg
2bIo9t1YUUdsNTugLPs6XDTe67ChRANCAAT58hKBoDjna2lEUnnXjYgj4CHd2XdQ
ycbxH551EaMuGrn0I/MfxfEBF82DI/B0tsz1++Z7eyCtI/R8Eu2etk19
-----END PRIVATE KEY-----`;

const host = "test.completions.near.ai";
const baseUrl = `https://${host}/v1`;
const model = "Qwen/Test";
const signingAddress = `0x${"11".repeat(20)}`;
const hash32 = "aa".repeat(32);
const publicCert = new X509Certificate(cert);
const spki = createHash("sha256").update(publicCert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
const originalRequest = https.request.bind(https);
let fixtureDir: string;
let policyPath: string;
let verifierPath: string;
let server: Server;
let port: number;
let requestHook: ((request: IncomingMessage, response: ServerResponse) => boolean) | undefined;
let reportChanges: Record<string, unknown>;
let calls: { url: string; method: string | undefined; authorization: string | undefined; body: string; remotePort: number | undefined }[];
const sessions: NearVerifiedSession[] = [];
const agents = new Set<https.Agent>();

const childFixture = `import { readFile, writeFile } from 'node:fs/promises';
const path = process.argv[process.argv.indexOf('--policy') + 1];
const policy = JSON.parse(await readFile(path, 'utf8'));
let input = ''; for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input);
if (policy.mode === 'reject') { process.stderr.write('private-verifier-diagnostic'); process.stdout.write('private-verifier-diagnostic'); process.exit(7); }
if (policy.mode === 'invalid-json') { process.stdout.write('private-invalid-output'); process.exit(0); }
if (policy.mode === 'oversize') { process.stdout.write('x'.repeat(2097153)); process.exitCode = 0; }
else if (policy.mode === 'hang') { setInterval(() => {}, 1000); }
else {
  if (policy.mode === 'policy-change') await writeFile(path, JSON.stringify({ changed: true }));
  const result = { ok: true, signingAddress: data.attestation?.signing_address ?? '${signingAddress}', tlsSpkiSha256: data.tlsSpkiSha256,
    attestationRef: '${hash32}', verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60000).toISOString(),
    cpuStatus: 'fixture', gpuCount: 1, measurements: { fixture: true }, receivedNonce: data.nonce,
    secretEnvNames: ['INFERENCE_API_KEY','DEPLOYER_PRIVATE_KEY','NEAR_FAKE_SECRET','NODE_OPTIONS'].filter(name=>process.env[name]),
    ...policy.verdict };
  process.stdout.write(JSON.stringify(result));
}`;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "enclave-near-provider-test-"));
  policyPath = join(fixtureDir, "policy.json");
  verifierPath = join(fixtureDir, "verifier.mjs");
  await writeFile(verifierPath, childFixture);
});

beforeEach(async () => {
  await writeFile(policyPath, "{}");
  requestHook = undefined;
  reportChanges = {};
  calls = [];
  vi.mocked(childProcess.spawn).mockClear();
  server = https.createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      calls.push({ url: req.url!, method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8"), remotePort: req.socket.remotePort });
      if (requestHook?.(req, res)) return;
      const url = new URL(req.url!, baseUrl);
      if (url.pathname === "/v1/attestation/report") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model_name: model, request_nonce: url.searchParams.get("nonce"), tls_cert_fingerprint: spki,
          signing_address: signingAddress, ...reportChanges }));
      } else { res.setHeader("content-type", "application/json"); res.end(' {"output":"test answer"}\n'); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  // Route only the approved test hostname to loopback, preserving real TLS validation and pin checks.
  vi.spyOn(https, "request").mockImplementation(((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    if (url.hostname !== host) throw new Error("Test attempted a non-loopback request");
    const agent = options.agent as https.Agent;
    agents.add(agent);
    agent.options.ca = [cert, secondCert];
    return originalRequest(url, { ...options, hostname: "127.0.0.1", port, servername: host }, callback);
  }) as typeof https.request);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close?.();
  for (const agent of agents) agent.destroy();
  agents.clear();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  const target = resolve(fixtureDir);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("enclave-near-provider-test-")) throw new Error("Unexpected fixture cleanup path");
  await rm(target, { recursive: true, force: true });
});

const runtime = () => ({ pythonPath: process.execPath, policyPath, verifierPath });
const publicInput = () => ({ attestation: { signing_address: signingAddress }, nonce: hash32, tlsSpkiSha256: spki });
async function session() {
  const result = await createNearAttestationVerifier(runtime())({ baseUrl, model, signal: AbortSignal.timeout(5_000) });
  sessions.push(result);
  return result;
}

describe("NEAR transport trust boundaries", () => {
  it("hashes the real DER SubjectPublicKeyInfo and verifies both hostname and key", () => {
    const peer = publicCert.toLegacyObject() as PeerCertificate;
    expect(peerSpkiSha256(peer)).toBe(spki);
    expect(checkNearCertificate(host, peer, `0x${spki.toUpperCase()}`)).toBeUndefined();
    expect(checkNearCertificate("wrong.completions.near.ai", peer, spki)).toBeInstanceOf(Error);
    expect(checkNearCertificate(host, peer, hash32)).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(() => peerSpkiSha256({ raw: Buffer.alloc(0) })).toThrow();
    expect(checkNearCertificate(host, { ...peer, raw: Buffer.from("invalid cert") }, spki)).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
  });

  it.each(["http://test.completions.near.ai/v1", "https://cloud-api.near.ai/v1", "https://test.completions.near.ai.attacker.example/v1",
    `${baseUrl}?key=secret`, `${baseUrl}#x`, `${baseUrl}/other`, "https://test.completions.near.ai:8443/v1", "https://user:pass@test.completions.near.ai/v1"])("rejects unsafe base URL %#", (url) => {
    expect(() => nearBaseUrl(url)).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("requires an explicit verifier and versioned policy", () => {
    expect(() => createNearAttestationVerifier({ pythonPath: "", policyPath })).toThrow("required");
    expect(() => createNearAttestationVerifier({ pythonPath: process.execPath, policyPath: "" })).toThrow("required");
  });

  it("binds a fresh report nonce and same-socket SPKI before allowing an authenticated POST", async () => {
    const verified = await session();
    expect(calls).toHaveLength(1);
    const attestationUrl = new URL(calls[0]!.url, baseUrl);
    expect(attestationUrl.pathname).toBe("/v1/attestation/report");
    expect(attestationUrl.searchParams.get("nonce")).toMatch(/^[a-f0-9]{64}$/);
    expect(attestationUrl.searchParams.get("signing_algo")).toBe("ecdsa");
    expect(attestationUrl.searchParams.get("include_tls_fingerprint")).toBe("true");
    expect(calls[0]!.authorization).toBeUndefined();
    expect(verified).toMatchObject({ allowedSigners: [signingAddress], attestationRef: `0x${hash32}`, tlsBound: true });
    const privateProof = JSON.parse(verified.attestationProof!);
    expect(privateProof.verdict.receivedNonce).toBe(attestationUrl.searchParams.get("nonce"));
    expect(privateProof.verdict).toMatchObject({ cpuStatus: "fixture", gpuCount: 1, measurements: { fixture: true } });
    expect(privateProof.policyHash).toMatch(/^0x[0-9a-f]{64}$/);
    const response = await verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", headers: { authorization: "Bearer fixture-api-key" }, body: "private prompt" });
    expect(await response.text()).toBe(' {"output":"test answer"}\n');
    expect(calls[1]).toMatchObject({ method: "POST", body: "private prompt", authorization: "Bearer fixture-api-key" });
    expect(calls[1]!.remotePort).toBe(calls[0]!.remotePort);
    const another = await session();
    expect(JSON.parse(another.attestationProof!).report.request_nonce).not.toBe(privateProof.report.request_nonce);
  });

  it("rejects TLS key rotation before the server receives any prompt bytes", async () => {
    const verified = await session();
    server.setSecureContext({ key: secondKey, cert: secondCert });
    const sockets = [...agents].flatMap((agent) => Object.values(agent.freeSockets).flat()).filter((socket) => socket !== undefined);
    const closed = sockets.map((socket) => once(socket, "close"));
    server.closeAllConnections();
    await Promise.all(closed);
    await expect(verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: "must never arrive" })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
  });

  it("rejects cross-origin calls and non-string bodies before opening a request", async () => {
    const verified = await session();
    await expect(verified.fetch(new URL("https://attacker.example/completions"), { method: "POST", body: "private" })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    await expect(verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: new Uint8Array([1]) })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
  });

  it("returns redirects without following them or forwarding credentials", async () => {
    const verified = await session();
    requestHook = (_req, res) => { res.writeHead(303, { location: "https://attacker.example/steal" }); res.end(); return true; };
    const response = await verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", headers: { authorization: "Bearer fixture-api-key" }, body: "private" });
    expect(response.status).toBe(303);
    expect(calls).toHaveLength(2);
  });

  it.each(["gzip", "declared", "stream", "invalid-status"])("rejects unsafe response encoding, size, or status: %s", async (mode) => {
    const verified = await session();
    requestHook = (_req, res) => {
      if (mode === "gzip") { res.setHeader("content-encoding", "gzip"); res.end("encoded body"); }
      if (mode === "declared") { res.setHeader("content-length", "8388609"); res.end(); }
      if (mode === "stream") { res.write(Buffer.alloc(4_194_304)); res.end(Buffer.alloc(4_194_305)); }
      if (mode === "invalid-status") { res.statusCode = 600; res.end("bad status"); }
      return true;
    };
    await expect(verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: "private" })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
  });

  it.each([204, 205, 304])("handles bodyless HTTP %s without throwing in an event listener", async (status) => {
    const verified = await session();
    requestHook = (_req, res) => { res.statusCode = status; res.end(); return true; };
    const response = await verified.fetch(new URL(`${baseUrl}/signature/chat-id`), { method: "GET" });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it.each([{ model_name: "Other/Model" }, { request_nonce: "bad" }, { tls_cert_fingerprint: hash32 }, { tls_cert_fingerprint: null }])("rejects report binding mismatch %#", async (changes) => {
    reportChanges = changes;
    const spawn = vi.mocked(childProcess.spawn);
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it.each(["signer", "spki", "expired", "future", "stale", "long-ttl", "policy-change"])("rejects verifier/policy inconsistency: %s", async (mode) => {
    const verdict: Record<string, unknown> = {};
    if (mode === "signer") verdict.signingAddress = `0x${"22".repeat(20)}`;
    if (mode === "spki") verdict.tlsSpkiSha256 = hash32;
    if (mode === "expired") verdict.expiresAt = new Date(0).toISOString();
    if (mode === "future") verdict.verifiedAt = new Date(Date.now() + 60_000).toISOString();
    if (mode === "stale") verdict.verifiedAt = new Date(Date.now() - 600_000).toISOString();
    if (mode === "long-ttl") verdict.expiresAt = new Date(Date.now() + 600_000).toISOString();
    await writeFile(policyPath, JSON.stringify({ mode, verdict }));
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a session that has expired before a later request", async () => {
    const verified = await session();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(verified.expiresAt) + 1);
    await expect(verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: "private" })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a bootstrap redirect without sending credentials or invoking the verifier", async () => {
    requestHook = (_req, res) => { res.writeHead(303, { location: "https://attacker.example/report" }); res.end(); return true; };
    const spawn = vi.mocked(childProcess.spawn);
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("isolated hardware verifier process protocol", () => {
  it("passes only public evidence and a minimal environment, preserving verifier audit fields", async () => {
    vi.stubEnv("INFERENCE_API_KEY", "fixture-secret-token");
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", "fixture-chain-secret");
    vi.stubEnv("NEAR_FAKE_SECRET", "fixture-other-secret");
    const spawn = vi.mocked(childProcess.spawn);
    const verdict = await runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000));
    expect(verdict).toMatchObject({ ok: true, signingAddress, tlsSpkiSha256: spki, secretEnvNames: [], cpuStatus: "fixture", gpuCount: 1 });
    const [executable, args, options] = spawn.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([verifierPath, "--policy", policyPath]);
    expect(options).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(JSON.stringify(options)).not.toContain("fixture-secret-token");
    expect(JSON.stringify(options)).not.toContain("fixture-chain-secret");
  });

  it.each(["reject", "invalid-json", "oversize"])("redacts verifier failure: %s", async (mode) => {
    await writeFile(policyPath, JSON.stringify({ mode }));
    const error: unknown = await runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", statusCode: 503 });
    expect(String(error)).not.toContain("private-verifier-diagnostic");
    expect(String(error)).not.toContain("private-invalid-output");
  });

  it.each([{ ok: false }, { signingAddress: "invalid" }, { attestationRef: "invalid" }, { verifiedAt: "invalid" }])("rejects malformed verdict schema %#", async (verdict) => {
    await writeFile(policyPath, JSON.stringify({ verdict }));
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
  });

  it("aborts an unresponsive verifier within the caller deadline", async () => {
    await writeFile(policyPath, JSON.stringify({ mode: "hang" }));
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(300))).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
  });

  it("does not spawn after cancellation and redacts missing executable failures", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.abort())).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    await expect(runNearVerifier({ ...runtime(), pythonPath: join(fixtureDir, "missing-python") }, publicInput(), AbortSignal.timeout(5_000)))
      .rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
  });

  it("detects an oversized or unreadable policy before trusting a verifier result", async () => {
    await writeFile(policyPath, " ".repeat(1_048_577));
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    const missing = join(fixtureDir, "missing-policy.json");
    await expect(createNearAttestationVerifier({ ...runtime(), policyPath: missing })({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect((await readFile(verifierPath, "utf8")).length).toBeGreaterThan(100);
  });
});
