import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from "node:tls";
import { z } from "zod";
import { AppError, sha256Hex } from "@enclave/core";
import type { NearAttestationVerifier, NearVerifiedFetch } from "@enclave/core";

export type NearProviderOptions = { pythonPath: string; policyPath: string; verifierPath?: string };
const defaultVerifierPath = fileURLToPath(new URL("../../../infra/near/verify.py", import.meta.url));
const hex32 = z.string().regex(/^(?:0x)?[0-9a-f]{64}$/i);
const verdictSchema = z.object({
  ok: z.literal(true), signingAddress: z.string().regex(/^0x[0-9a-f]{40}$/i),
  tlsSpkiSha256: hex32, attestationRef: hex32, verifiedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).passthrough();
const normalizeHex = (value: string) => value.replace(/^0x/, "").toLowerCase();
const unavailable = () => new AppError("INFERENCE_ATTESTATION_FAILED", "NEAR hardware attestation or transport verification failed", 503);

export function nearBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.completions\.near\.ai$/.test(url.hostname)
    || (url.port && url.port !== "443") || !["", "/", "/v1", "/v1/"].includes(url.pathname)
    || url.username || url.password || url.search || url.hash) throw new Error("NEAR requires a direct HTTPS completions endpoint");
  return url;
}

export function peerSpkiSha256(cert: Pick<PeerCertificate, "raw">): string {
  if (!cert.raw?.length) throw unavailable();
  const spki = new X509Certificate(cert.raw).publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("hex");
}

/** Public CA verification is retained in addition to the attested SPKI binding. */
export function checkNearCertificate(hostname: string, cert: PeerCertificate, expectedSpki: string): Error | undefined {
  const identityError = checkServerIdentity(hostname, cert);
  if (identityError) return identityError;
  try { if (peerSpkiSha256(cert) !== normalizeHex(expectedSpki)) return unavailable(); }
  catch { return unavailable(); }
  return undefined;
}

type WireResponse = { response: Response; peerSpki: string };
async function requestBytes(url: URL, init: RequestInit, agent: https.Agent, maximum = 8_388_608): Promise<WireResponse> {
  if (init.body != null && typeof init.body !== "string") throw unavailable();
  const requestBody = init.body as string | undefined;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (requestBody !== undefined) headers["content-length"] = String(Buffer.byteLength(requestBody));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "GET", headers, agent,
      ...(init.signal ? { signal: init.signal } : {}),
    }, (res) => {
      let peerSpki: string;
      try { peerSpki = peerSpkiSha256((res.socket as TLSSocket).getPeerCertificate()); }
      catch { res.destroy(); reject(unavailable()); return; }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum
        || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
        res.destroy(); reject(unavailable()); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) { res.destroy(); reject(unavailable()); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on("error", () => reject(unavailable()));
      res.on("aborted", () => reject(unavailable()));
      res.on("end", () => {
        try {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = res.statusCode ?? 502;
          // No redirects or decompression: the verifier hashes the original HTTP body bytes.
          resolve({ response: new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }), peerSpki });
        } catch { reject(unavailable()); }
      });
    });
    req.on("error", () => reject(unavailable()));
    if (requestBody !== undefined) req.write(requestBody);
    req.end();
  });
}

export async function runNearVerifier(options: NearProviderOptions, input: unknown, signal: AbortSignal): Promise<z.infer<typeof verdictSchema>> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { PYTHONUTF8: "1" };
  // The verifier only receives public hardware evidence, never inference credentials.
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.pythonPath, [options.verifierPath ?? defaultVerifierPath, "--policy", options.policyPath], {
      env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(unavailable()); } };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_097_152) { child.kill(); fail(); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", () => { /* Never forward arbitrary verifier diagnostics. */ });
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || signal.aborted) { fail(); return; }
      try {
        const parsed = verdictSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        settled = true;
        resolve(parsed);
      } catch { fail(); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** A new nonce, policy read and hardware verification are required for every inference. */
export function createNearAttestationVerifier(options: NearProviderOptions): NearAttestationVerifier {
  if (!options.pythonPath || !options.policyPath) throw new Error("NEAR verifier runtime and versioned policy are required");
  return async ({ baseUrl, model, signal }) => {
    const base = nearBaseUrl(baseUrl);
    const nonce = randomBytes(32).toString("hex");
    const reportUrl = new URL("/v1/attestation/report", base);
    reportUrl.searchParams.set("signing_algo", "ecdsa");
    reportUrl.searchParams.set("nonce", nonce);
    reportUrl.searchParams.set("include_tls_fingerprint", "true");
    let attestedSpki: string | undefined;
    let handedOff = false;
    // Reuse the attested connection across the provider's load balancer. Every
    // reconnect still requires CA/hostname validation and the verified SPKI.
    const bootstrapAgent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, maxCachedSessions: 0,
      checkServerIdentity: (host, cert) => attestedSpki === undefined
        ? checkServerIdentity(host, cert) : checkNearCertificate(host, cert, attestedSpki),
    });
    try {
      const { response, peerSpki } = await requestBytes(reportUrl, { signal, headers: { accept: "application/json", "accept-encoding": "identity" } }, bootstrapAgent);
      if (response.status !== 200) throw unavailable();
      const rawReport = await response.text();
      const report = JSON.parse(rawReport) as Record<string, unknown>;
      if (report.model_name !== model || report.request_nonce !== nonce
        || typeof report.tls_cert_fingerprint !== "string" || normalizeHex(report.tls_cert_fingerprint) !== peerSpki) throw unavailable();
      const policyBefore = await readFile(options.policyPath);
      if (policyBefore.length > 1_048_576) throw unavailable();
      const verdict = await runNearVerifier(options, { attestation: report, nonce, tlsSpkiSha256: peerSpki }, signal);
      const now = Date.now();
      if (normalizeHex(verdict.tlsSpkiSha256) !== peerSpki
        || typeof report.signing_address !== "string" || verdict.signingAddress.toLowerCase() !== report.signing_address.toLowerCase()
        || Date.parse(verdict.verifiedAt) > now + 5_000 || Date.parse(verdict.verifiedAt) < now - 300_000
        || Date.parse(verdict.expiresAt) <= now || Date.parse(verdict.expiresAt) > Date.parse(verdict.verifiedAt) + 300_000
        || !policyBefore.equals(await readFile(options.policyPath))) throw unavailable();
      attestedSpki = peerSpki;
      const pinnedFetch: NearVerifiedFetch = async (url, init) => {
        if (url.origin !== base.origin || Date.parse(verdict.expiresAt) <= Date.now()) throw unavailable();
        const wire = await requestBytes(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "accept-encoding": "identity" } }, bootstrapAgent);
        if (wire.peerSpki !== peerSpki || wire.response.headers.get("content-encoding") && wire.response.headers.get("content-encoding") !== "identity") throw unavailable();
        return wire.response;
      };
      const session = {
        allowedSigners: [verdict.signingAddress as `0x${string}`],
        attestationRef: `0x${normalizeHex(verdict.attestationRef)}` as `0x${string}`,
        verifiedAt: verdict.verifiedAt, expiresAt: verdict.expiresAt, tlsBound: true as const,
        fetch: pinnedFetch, close: () => bootstrapAgent.destroy(),
        attestationProof: JSON.stringify({ report: JSON.parse(rawReport), verdict, policy: JSON.parse(policyBefore.toString("utf8")), policyHash: sha256Hex(policyBefore) }),
      };
      handedOff = true;
      return session;
    } catch { throw unavailable(); }
    finally { if (!handedOff) bootstrapAgent.destroy(); }
  };
}
