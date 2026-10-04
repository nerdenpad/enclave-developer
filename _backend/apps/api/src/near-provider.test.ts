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
import { checkNearCertificate, createNearAttestationVerifier, nearBaseUrl, nvidiaVerifierOptions, peerSpkiSha256, runNearVerifier } from "./near-provider.js";
import { AppError, type NearVerifiedSession } from "@enclave/core";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Public, disposable test credentials. They never authenticate a live service.
const cert = `-----BEGIN CERTIFICATE-----
MIIB1jCCAXugAwIBAgIUQH167SxubumFz1674ZsxL2voIJQwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9ucy5uZWFyLmFpMB4XDTI2MDkyODE3
NDMwMVoXDTM2MDkyNjE3NDMwMVowIzEhMB8GA1UEAwwYdGVzdC5jb21wbGV0aW9u
cy5uZWFyLmFpMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKM+30DfU/cWgtugL
zenTuJa/dseF3VDZMIVO55+ESL7d58jcFK2g8F7zjUIkHRz8hHeGly2MvqsxTrJq
Aer9tqOBjDCBiTAdBgNVHQ4EFgQUdHpijHVIXHnXwWFnaaQlV9cANbgwHwYDVR0j
BBgwFoAUdHpijHVIXHnXwWFnaaQlV9cANbgwNgYDVR0RBC8wLYIYdGVzdC5jb21w
bGV0aW9ucy5uZWFyLmFpghFjbG91ZC1hcGkubmVhci5haTAPBgNVHRMBAf8EBTAD
AQH/MAoGCCqGSM49BAMCA0kAMEYCIQClzAGEXrd05jxXQTUK2SCe+qt5PMfNQOC+
XH9PIYc1DQIhAKxa3TQR4Ojd6kgD8Drpoynvkm1HlNiFdTRseWg20C9a
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
const cloudHost = "cloud-api.near.ai";
const cloudBaseUrl = `https://${cloudHost}/v1`;
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
let calls: { url: string; method: string | undefined; authorization: string | undefined; noAliasing: string | undefined; body: string; remotePort: number | undefined }[];
const sessions: NearVerifiedSession[] = [];
const agents = new Set<https.Agent>();

const childFixture = `import { readFile, writeFile } from 'node:fs/promises';
const path = process.argv[process.argv.indexOf('--policy') + 1];
const policy = JSON.parse(await readFile(path, 'utf8'));
let input = ''; for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input);
const report = data.attestation?.gateway_attestation ?? data.attestation;
if (policy.mode === 'admission-fixture' && typeof report?.fixtureError === 'string') {
  if (policy.changeOnReject) await writeFile(path, JSON.stringify({ changed: true }));
  process.stdout.write(JSON.stringify({ok:false,error:report.fixtureError,report:'private-raw-report'})); process.exit(1);
}
if (policy.mode === 'reject') { process.stderr.write('private-verifier-diagnostic'); process.stdout.write('private-verifier-diagnostic'); process.exit(7); }
if (policy.mode === 'fixed-error') { process.stderr.write('private-verifier-diagnostic'); process.stdout.write(JSON.stringify({ok:false,error:policy.errorCode,report:'private-raw-report',nonce:'private-nonce',token:'private-token'})); process.exit(policy.exitCode ?? 1); }
if (policy.mode === 'invalid-json') { process.stdout.write('private-invalid-output'); process.exit(0); }
if (policy.mode === 'oversize') { process.stdout.write('x'.repeat(2097153)); process.exitCode = 0; }
else if (policy.mode === 'hang') { setInterval(() => {}, 1000); }
else {
  if (policy.mode === 'policy-change') await writeFile(path, JSON.stringify({ changed: true }));
  const result = { ok: true, signingAddress: data.attestation?.signing_address ?? '${signingAddress}', tlsSpkiSha256: data.tlsSpkiSha256,
    attestationRef: '${hash32}', verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60000).toISOString(),
    ...(data.model ? { allowedSigners: ['${signingAddress}'] } : {}),
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
      calls.push({ url: req.url!, method: req.method, authorization: req.headers.authorization,
        noAliasing: req.headers["x-no-aliasing"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"), remotePort: req.socket.remotePort });
      if (requestHook?.(req, res)) return;
      const url = new URL(req.url!, baseUrl);
      if (url.pathname === "/v1/attestation/report") {
        res.setHeader("content-type", "application/json");
        const evidence = { model_name: model, request_nonce: url.searchParams.get("nonce"), tls_cert_fingerprint: spki,
          signing_address: signingAddress, ...reportChanges };
        res.end(JSON.stringify(req.headers.host?.startsWith(cloudHost)
          ? { gateway_attestation: evidence, model_attestations: [evidence] } : evidence));
      } else { res.setHeader("content-type", "application/json"); res.end(' {"output":"test answer"}\n'); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  // Route only the approved test hostname to loopback, preserving real TLS validation and pin checks.
  vi.spyOn(https, "request").mockImplementation(((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    if (![host, cloudHost].includes(url.hostname)) throw new Error("Test attempted a non-loopback request");
    const agent = options.agent as https.Agent;
    agents.add(agent);
    agent.options.ca = [cert, secondCert];
    return originalRequest(url, { ...options, hostname: "127.0.0.1", port, servername: url.hostname,
      headers: { ...options.headers, host: url.hostname } }, callback);
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

async function admissionRuntime(maxDirectAdmissionAttempts = 3, policy: Record<string, unknown> = {}) {
  await writeFile(policyPath, JSON.stringify({ mode: "admission-fixture", ...policy }));
  return { ...runtime(), maxDirectAdmissionAttempts, policySha256: `0x${createHash("sha256").update(await readFile(policyPath)).digest("hex")}` };
}

function rejectAdmissionReports(count: number, errorCode = "WORKLOAD_NOT_APPROVED") {
  requestHook = (request, response) => {
    if (!request.url?.startsWith("/v1/attestation/report")) return false;
    const evidence = { model_name: model, request_nonce: new URL(request.url, baseUrl).searchParams.get("nonce"),
      tls_cert_fingerprint: spki, signing_address: signingAddress,
      ...(calls.length <= count ? { fixtureError: errorCode } : {}) };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.headers.host?.startsWith(cloudHost)
      ? { gateway_attestation: evidence, model_attestations: [evidence] } : evidence));
    return true;
  };
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

  it.each(["http://test.completions.near.ai/v1", "https://test.completions.near.ai.attacker.example/v1",
    `${baseUrl}?key=secret`, `${baseUrl}#x`, `${baseUrl}/other`, "https://test.completions.near.ai:8443/v1", "https://user:pass@test.completions.near.ai/v1"])("rejects unsafe base URL %#", (url) => {
    expect(() => nearBaseUrl(url)).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("accepts only the exact cloud gateway hostname", () => {
    expect(nearBaseUrl("https://cloud-api.near.ai/v1").hostname).toBe("cloud-api.near.ai");
    expect(() => nearBaseUrl("https://cloud-api.near.ai.evil.example/v1")).toThrow();
  });

  it("preflights cloud gateway and model reports before exposing the pinned connection", async () => {
    const apiKey = "fixture-cloud-key";
    const verified = await createNearAttestationVerifier({ ...runtime(), apiKey })({
      baseUrl: cloudBaseUrl, model, signal: AbortSignal.timeout(5_000),
    });
    sessions.push(verified);
    expect(calls).toHaveLength(1);
    const reportUrl = new URL(calls[0]!.url, cloudBaseUrl);
    expect(reportUrl.searchParams.get("model")).toBe(model);
    expect(reportUrl.searchParams.get("provider")).toBe("near");
    expect(reportUrl.searchParams.get("include_tls_fingerprint")).toBe("true");
    expect(calls[0]).toMatchObject({ authorization: `Bearer ${apiKey}`, noAliasing: "true" });
    expect(verified.allowedSigners).toEqual([signingAddress]);
    const proof = JSON.parse(verified.attestationProof!);
    expect(proof.report.model_attestations).toHaveLength(1);
    expect(proof.verdict.allowedSigners).toEqual([signingAddress]);
    expect(JSON.stringify(proof)).not.toContain(apiKey);
    expect(await (await verified.fetch(new URL(`${cloudBaseUrl}/chat/completions`), {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "x-no-aliasing": "true" }, body: "private prompt",
    })).text()).toContain("test answer");
    expect(calls[1]!.remotePort).toBe(calls[0]!.remotePort);
  });

  it("does not send a cloud prompt when model reports or credentials are missing", async () => {
    await expect(createNearAttestationVerifier(runtime())({ baseUrl: cloudBaseUrl, model,
      signal: AbortSignal.timeout(5_000) })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(0);
    requestHook = (req, res) => {
      if (!req.url?.startsWith("/v1/attestation/report")) return false;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ gateway_attestation: { request_nonce: new URL(req.url, cloudBaseUrl).searchParams.get("nonce"),
        tls_cert_fingerprint: spki }, model_attestations: [] }));
      return true;
    };
    await expect(createNearAttestationVerifier({ ...runtime(), apiKey: "fixture" })({ baseUrl: cloudBaseUrl, model,
      signal: AbortSignal.timeout(5_000) })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
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
    await expect(verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: "must never arrive" })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED",
      details: { attestationFailure: { stage: "transport", reason: "tls" } } });
    expect(calls).toHaveLength(1);
  });

  it("rejects cross-origin calls and non-string bodies before opening a request", async () => {
    const verified = await session();
    await expect(verified.fetch(new URL("https://attacker.example/completions"), { method: "POST", body: "private" })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    await expect(verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: new Uint8Array([1]) })).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
  });

  it("redacts synchronous header errors before a pinned request sends bytes", async () => {
    const verified = await session();
    const error = await verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", headers: { authorization: "private-token\ninvalid" }, body: "private" })
      .catch((caught: unknown) => caught);
    expect((error as AppError).details).toEqual({ attestationFailure: { stage: "transport", reason: "request" } });
    expect(JSON.stringify(error)).not.toContain("private-token");
    expect(String(error)).not.toContain("private-token");
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
    const reason = "model_name" in changes ? "model-binding" : "request_nonce" in changes ? "nonce-binding" : changes.tls_cert_fingerprint === null ? "shape" : "tls-binding";
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", details: { attestationFailure: { stage: "report", reason } } });
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

  it("permits exactly the direct node signer when the verifier includes a signer set", async () => {
    await writeFile(policyPath, JSON.stringify({ verdict: { allowedSigners: [signingAddress] } }));
    const verified = await session();
    expect(verified.allowedSigners).toEqual([signingAddress]);
    expect(JSON.parse(verified.attestationProof!).report.signing_address).toBe(signingAddress);
  });

  it.each([
    [`0x${"22".repeat(20)}`], [signingAddress, `0x${"22".repeat(20)}`], [signingAddress, signingAddress], [`0x${"00".repeat(20)}`],
  ])("rejects a direct verifier signer set that is not the single attested node %#", async (...allowedSigners) => {
    await writeFile(policyPath, JSON.stringify({ verdict: { allowedSigners } }));
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
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
    await expect(session()).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", details: { attestationFailure: { stage: "report", reason: "http-status" } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([{ body: "private-invalid-report", reason: "json" }, { body: "null", reason: "shape" }, { body: "[]", reason: "shape" }])(
    "exposes only a fixed report diagnostic for $reason", async ({ body, reason }) => {
      requestHook = (_req, res) => { res.end(body); return true; };
      const error = await session().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", statusCode: 503,
        details: { attestationFailure: { stage: "report", reason } } });
      expect(JSON.stringify(error)).not.toContain(body);
      expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
    });

  it("does not preserve caller-provided AppError details through the outer catch", async () => {
    vi.mocked(https.request).mockImplementationOnce(() => { throw new AppError("INFERENCE_ATTESTATION_FAILED", "private injected message", 503,
      { attestationFailure: { stage: "private injected stage", reason: "private injected reason" }, rawReport: "private injected report" }); });
    const error = await session().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", statusCode: 503,
      details: { attestationFailure: { stage: "transport", reason: "request" } } });
    expect(JSON.stringify(error)).not.toContain("private injected");
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });
});

describe("bounded direct workload admission", () => {
  it.each([0, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects unsafe attempt limit %s", (maxDirectAdmissionAttempts) => {
    expect(() => createNearAttestationVerifier({ ...runtime(), maxDirectAdmissionAttempts })).toThrow("integer from 1 to 3");
    expect(calls).toHaveLength(0);
  });

  it("requires a pinned policy before enabling direct selection retries", () => {
    expect(() => createNearAttestationVerifier({ ...runtime(), maxDirectAdmissionAttempts: 2 })).toThrow("pinned policy");
    expect(calls).toHaveLength(0);
  });

  it("keeps the default at one rejected report", async () => {
    await admissionRuntime();
    rejectAdmissionReports(10);
    await expect(createNearAttestationVerifier(runtime())({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { verifierError: "WORKLOAD_NOT_APPROVED" } } });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(1);
  });

  it("selects an approved second connection with a fresh nonce before one explicit POST", async () => {
    const options = await admissionRuntime();
    rejectAdmissionReports(1);
    const destroy = vi.spyOn(https.Agent.prototype, "destroy");
    const verified = await createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) });
    sessions.push(verified);
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.method === "GET" && call.body === "" && call.authorization === undefined)).toBe(true);
    expect(calls[0]!.remotePort).not.toBe(calls[1]!.remotePort);
    const nonces = calls.map(call => new URL(call.url, baseUrl).searchParams.get("nonce"));
    expect(nonces[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(nonces[1]).not.toBe(nonces[0]);
    expect(JSON.parse(verified.attestationProof!).report.request_nonce).toBe(nonces[1]);
    const selectedAgents = [...agents];
    expect(selectedAgents).toHaveLength(2);
    expect(destroy.mock.contexts).toContain(selectedAgents[0]);
    expect(destroy.mock.contexts).not.toContain(selectedAgents[1]);
    expect(vi.mocked(childProcess.spawn).mock.calls.every(call => call[1]?.includes(options.policySha256))).toBe(true);
    await verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: "one explicit private prompt" });
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(calls[2]!.remotePort).toBe(calls[1]!.remotePort);
    verified.close?.();
    expect(destroy.mock.contexts).toContain(selectedAgents[1]);
  });

  it("bounds unknown workloads to three GETs and destroys every rejected agent", async () => {
    const options = await admissionRuntime();
    rejectAdmissionReports(10);
    const destroy = vi.spyOn(https.Agent.prototype, "destroy");
    const error = await createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", details: { attestationFailure: {
      stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED" } } });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => new URL(call.url, baseUrl).searchParams.get("nonce"))).size).toBe(3);
    expect(calls.every(call => call.method === "GET" && call.body === "")).toBe(true);
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(3);
    expect(agents.size).toBe(3);
    for (const agent of agents) expect(destroy.mock.contexts).toContain(agent);
    expect(JSON.stringify(error)).not.toContain("private-raw-report");
  });

  it("never redispatches a failed inference request after admission selection", async () => {
    const options = await admissionRuntime();
    rejectAdmissionReports(1);
    const verified = await createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) });
    sessions.push(verified);
    requestHook = (request, response) => {
      if (request.method !== "POST") return false;
      response.statusCode = 503;
      response.end("provider unavailable");
      return true;
    };
    const response = await verified.fetch(new URL(`${baseUrl}/chat/completions`), { method: "POST", body: "one explicit request" });
    expect(response.status).toBe(503);
    expect(calls.filter(call => call.method === "GET")).toHaveLength(2);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(2);
  });

  it.each(["CPU_TCB_REJECTED", "CPU_BINDING_MISMATCH", "NVIDIA_GPU_REJECTED", "NONCE_MISMATCH", "WORKLOAD_BINDING_MISMATCH", "POLICY_EXPIRED"])(
    "does not retry a fatal verifier rejection %s", async (errorCode) => {
      const options = await admissionRuntime();
      rejectAdmissionReports(10, errorCode);
      await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
        .rejects.toMatchObject({ details: { attestationFailure: { verifierError: errorCode } } });
      expect(calls).toHaveLength(1);
      expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(1);
    });

  it("does not retry report nonce or protocol failures", async () => {
    const options = await admissionRuntime();
    reportChanges = { request_nonce: "bad" };
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { stage: "report", reason: "nonce-binding" } } });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it("keeps Cloud at one attempt even when direct retries are configured", async () => {
    const options = await admissionRuntime();
    rejectAdmissionReports(10);
    await expect(createNearAttestationVerifier({ ...options, apiKey: "fixture" })({ baseUrl: cloudBaseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { verifierError: "WORKLOAD_NOT_APPROVED" } } });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(1);
  });

  it("stops when the original caller aborts during the retry wait", async () => {
    const options = await admissionRuntime();
    rejectAdmissionReports(10);
    const controller = new AbortController();
    const realDestroy = https.Agent.prototype.destroy;
    vi.spyOn(https.Agent.prototype, "destroy").mockImplementation(function (this: https.Agent) {
      realDestroy.call(this);
      setTimeout(() => controller.abort(), 20);
    });
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: controller.signal }))
      .rejects.toMatchObject({ details: { attestationFailure: { reason: "aborted" } } });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(childProcess.spawn).mock.calls[0]![2]!.signal).toBe(controller.signal);
  });

  it("does not treat injected diagnostic-shaped errors as a trusted retry decision", async () => {
    const options = await admissionRuntime();
    vi.mocked(https.request).mockImplementationOnce(() => { throw new AppError("INFERENCE_ATTESTATION_FAILED", "private injected message", 503,
      { attestationFailure: { stage: "verifier", reason: "rejected", verifierError: "WORKLOAD_NOT_APPROVED" } }); });
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { stage: "transport", reason: "request" } } });
    expect(https.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it("does not retry TLS validation failures", async () => {
    const options = await admissionRuntime();
    vi.mocked(https.request).mockImplementationOnce(() => { throw Object.assign(new Error("private TLS diagnostic"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }); });
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { stage: "transport", reason: "tls" } } });
    expect(https.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it("refuses a changed policy between rejected candidates before another GET", async () => {
    const options = await admissionRuntime(3, { changeOnReject: true });
    rejectAdmissionReports(10);
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { stage: "policy", reason: "changed" } } });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(1);
  });

  it("refuses a policy that disagrees with the trusted pin before opening a connection", async () => {
    const options = await admissionRuntime();
    await writeFile(policyPath, "{}");
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ details: { attestationFailure: { stage: "policy", reason: "changed" } } });
    expect(calls).toHaveLength(0);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it("does not open a candidate when the original deadline already expired", async () => {
    const options = await admissionRuntime();
    await expect(createNearAttestationVerifier(options)({ baseUrl, model, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ details: { attestationFailure: { reason: "aborted" } } });
    expect(calls).toHaveLength(0);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });
});

describe("isolated hardware verifier process protocol", () => {
  it("does not inherit ambient NVIDIA mode or artifact settings", async () => {
    vi.stubEnv("NVIDIA_VERIFIER_MODE", "local");
    vi.stubEnv("NVIDIA_NVAT_BINARY", "/unreviewed/nvattest");
    vi.stubEnv("NVIDIA_NVAT_LIBRARY", "/unreviewed/libnvat.so");
    await runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000));
    const env = vi.mocked(childProcess.spawn).mock.calls[0]![2]!.env!;
    expect(env.NVIDIA_VERIFIER_MODE).toBeUndefined();
    expect(env.NVIDIA_NVAT_BINARY).toBeUndefined();
    expect(env.NVIDIA_NVAT_LIBRARY).toBeUndefined();
  });

  it("passes only explicit local NVIDIA artifact paths without inference credentials", async () => {
    vi.stubEnv("INFERENCE_API_KEY", "fixture-secret-token");
    const nvidiaLocal = { binaryPath: "/reviewed/bin/nvattest", libraryPath: "/reviewed/lib/libnvat.so" };
    await runNearVerifier({ ...runtime(), nvidiaLocal }, publicInput(), AbortSignal.timeout(5_000));
    const env = vi.mocked(childProcess.spawn).mock.calls[0]![2]!.env!;
    expect(env).toMatchObject({ NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: nvidiaLocal.binaryPath, NVIDIA_NVAT_LIBRARY: nvidiaLocal.libraryPath });
    expect(env.INFERENCE_API_KEY).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
  });

  it.each([
    { NVIDIA_VERIFIER_MODE: "local" },
    { NVIDIA_VERIFIER_MODE: "nras", NVIDIA_NVAT_BINARY: "/unreviewed/nvattest" },
    { NVIDIA_VERIFIER_MODE: "auto" },
    { NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: "relative/nvattest", NVIDIA_NVAT_LIBRARY: "/reviewed/libnvat.so" },
    { NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: "/reviewed/shared", NVIDIA_NVAT_LIBRARY: "/reviewed/shared" },
    { NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: "/reviewed/bin/nvattest", NVIDIA_NVAT_LIBRARY: "/reviewed/one:two/libnvat.so" },
    { NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: "/reviewed/bin/nvattest", NVIDIA_NVAT_LIBRARY: "/reviewed/$ORIGIN/libnvat.so" },
  ])("rejects implicit or incomplete NVIDIA verifier configuration %#", options => {
    expect(() => nvidiaVerifierOptions(options)).toThrow();
  });

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
    expect(error).toMatchObject({ details: { attestationFailure: { stage: "verifier", reason:
      mode === "reject" ? "process-failed" : mode === "oversize" ? "output-limit" : "invalid-output" } } });
    expect(String(error)).not.toContain("private-verifier-diagnostic");
    expect(String(error)).not.toContain("private-invalid-output");
  });

  it.each(["CPU_TCB_REJECTED", "WORKLOAD_NOT_APPROVED", "NVIDIA_LOCAL_TIMEOUT", "ARCHIVE_VERDICT_MISMATCH"])(
    "preserves only allowlisted verifier code %s through session failure", async errorCode => {
      await writeFile(policyPath, JSON.stringify({ mode: "fixed-error", errorCode }));
      const error = await session().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", statusCode: 503 });
      expect((error as AppError).details).toEqual({ attestationFailure: { stage: "verifier", reason: "rejected", verifierError: errorCode } });
      expect(JSON.stringify(error)).not.toContain("private-");
    });

  it.each(["NVIDIA_PRIVATE_SECRET", "CPU_TCB_REJECTED\nprivate-token", { token: "private-token" }])(
    "does not copy unknown or malformed verifier error fields %#", async errorCode => {
      await writeFile(policyPath, JSON.stringify({ mode: "fixed-error", errorCode }));
      const error = await runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000)).catch((caught: unknown) => caught);
      expect((error as AppError).details).toEqual({ attestationFailure: { stage: "verifier", reason: "process-failed" } });
      expect(JSON.stringify(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain("NVIDIA_PRIVATE_SECRET");
    });

  it("rejects a fixed failure verdict even when the process incorrectly exits zero", async () => {
    await writeFile(policyPath, JSON.stringify({ mode: "fixed-error", errorCode: "CPU_TCB_REJECTED", exitCode: 0 }));
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED",
      details: { attestationFailure: { stage: "verifier", reason: "rejected", verifierError: "CPU_TCB_REJECTED" } } });
  });

  it.each([{ cloud: true, flag: "--cloud-archive" }, { cloud: false, flag: "--direct-archive" }])(
    "uses only the explicit $flag archive entry point with the pinned policy", async ({ cloud, flag }) => {
      await writeFile(policyPath, JSON.stringify({ verdict: { archivedHardwareVerified: true } }));
      const policySha256 = `0x${"ab".repeat(32)}`;
      const input = { ...publicInput(), archivedVerdict: { fixture: "public historical evidence" } };
      const verdict = await runNearVerifier({ ...runtime(), policySha256 }, input, AbortSignal.timeout(5_000), cloud, true);
      expect(verdict.archivedHardwareVerified).toBe(true);
      expect(vi.mocked(childProcess.spawn).mock.calls[0]![1]).toEqual([verifierPath, "--policy", policyPath, "--policy-sha256", policySha256, flag]);
      expect(calls).toHaveLength(0);
    });

  it.each([true, false])("refuses archive replay without an independent verified flag for cloud=%s", async (cloud) => {
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000), cloud, true)).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    await writeFile(policyPath, JSON.stringify({ verdict: { archivedHardwareVerified: false } }));
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000), cloud, true)).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
    expect(calls).toHaveLength(0);
  });

  it.each([{ ok: false }, { signingAddress: "invalid" }, { signingAddress: `0x${"00".repeat(20)}` },
    { attestationRef: "invalid" }, { verifiedAt: "invalid" }])("rejects malformed verdict schema %#", async (verdict) => {
    await writeFile(policyPath, JSON.stringify({ verdict }));
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED" });
  });

  it("aborts an unresponsive verifier within the caller deadline", async () => {
    await writeFile(policyPath, JSON.stringify({ mode: "hang" }));
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(300))).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED",
      details: { attestationFailure: { stage: "verifier", reason: "aborted" } } });
  });

  it("does not spawn after cancellation and redacts missing executable failures", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    await expect(runNearVerifier(runtime(), publicInput(), AbortSignal.abort())).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED",
      details: { attestationFailure: { stage: "verifier", reason: "aborted" } } });
    expect(spawn).not.toHaveBeenCalled();
    await expect(runNearVerifier({ ...runtime(), pythonPath: join(fixtureDir, "missing-python") }, publicInput(), AbortSignal.timeout(5_000)))
      .rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", details: { attestationFailure: { stage: "verifier", reason: "process-failed" } } });
  });

  it("redacts invalid input before starting a verifier process", async () => {
    const input: { private: unknown } = { private: null }; input.private = input;
    await expect(runNearVerifier(runtime(), input, AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED",
      details: { attestationFailure: { stage: "verifier", reason: "invalid-input" } } });
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it("redacts a synchronous spawn failure without copying caller details", async () => {
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => { throw new AppError("PRIVATE_CODE", "private spawn message", 500, { raw: "private spawn details" }); });
    const error = await runNearVerifier(runtime(), publicInput(), AbortSignal.timeout(5_000)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INFERENCE_ATTESTATION_FAILED", statusCode: 503 });
    expect((error as AppError).details).toEqual({ attestationFailure: { stage: "verifier", reason: "process-failed" } });
    expect(JSON.stringify(error)).not.toContain("private spawn");
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
