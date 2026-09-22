import { decodeEventLog, decodeFunctionResult, encodeFunctionData, hashTypedData, parseAbi, recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { RECEIPT_TYPES } from "./api";

export const MAX_RECEIPT_BYTES = 65_536;
const hex = z.string().regex(/^0x[\da-f]{64}$/i).transform(v => v as Hex);
const address = z.string().regex(/^0x[\da-f]{40}$/i).refine(v => !/^0x0{40}$/i.test(v)).transform(v => v as Hex);
const receiptSchema = z.object({
  receiptVersion: z.union([z.literal(1), z.literal(2)]), nonce: hex.nullable().optional(),
  chainId: z.number().int().positive().safe(), verifierAddress: address,
  modelHash: hex, codeHash: hex, inHash: hex, outHash: hex, attRef: hex,
  ts: z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 2n ** 64n - 1n),
  sig: z.string().regex(/^0x[\da-f]{130}$/i).transform(v => v as Hex), typedHash: hex,
  anchoredTx: hex.nullable().optional(),
}).refine(r => r.receiptVersion !== 2 || r.nonce != null);
export type PortableReceipt = z.infer<typeof receiptSchema>;
export const trustSchema = z.object({ chainId: z.number().int().positive().safe(), verifierAddress: address, signer: address });
export type ReceiptTrust = z.infer<typeof trustSchema>;
export const verifierAbi = parseAbi([
  "function enclaveSigner() view returns (address)",
  "function registry() view returns (address)",
  "function verifyReceipt((bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, bytes32 nonce, uint64 ts) r, bytes sig) returns (bytes32)",
  "function verifyLegacyReceipt((bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, uint64 ts) r, bytes sig) returns (bytes32)",
  "event Verified(bytes32 indexed receiptHash, bytes32 modelHash, bytes32 codeHash, bytes32 inHash, bytes32 outHash, bytes32 attRef, address signer)",
]);
export const registryAbi = parseAbi([
  "function idByHashes(bytes32 modelHash, bytes32 codeHash) view returns (uint256)",
  "function listingPolicy(uint256 id) view returns (bytes32 policyHash, uint64 policyVersion)",
]);
export function parseReceipt(text: string): PortableReceipt {
  if (new TextEncoder().encode(text).length > MAX_RECEIPT_BYTES) throw new Error("Receipt exceeds the 64 KiB limit.");
  try { return receiptSchema.parse(JSON.parse(text)); }
  catch { throw new Error("Invalid receipt JSON. Use a single exported receipt with its chain ID, verifier address and typed hash."); }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function receiptTypedData(receipt: PortableReceipt) {
  return {
    domain: { name: "ENCLAVE", version: String(receipt.receiptVersion), chainId: receipt.chainId, verifyingContract: receipt.verifierAddress },
    primaryType: "InferenceReceipt" as const,
    types: { InferenceReceipt: receipt.receiptVersion === 2 ? RECEIPT_TYPES.InferenceReceipt : RECEIPT_TYPES.InferenceReceipt.filter(f => f.name !== "nonce") },
    message: { ...receipt, nonce: receipt.nonce ?? `0x${"00".repeat(32)}` as Hex, ts: BigInt(receipt.ts) },
  };
}
export async function verifyLocalReceipt(input: PortableReceipt, expected: ReceiptTrust) {
  const receipt = receiptSchema.parse(input), trust = trustSchema.parse(expected);
  if (receipt.chainId !== trust.chainId || !same(receipt.verifierAddress, trust.verifierAddress)) throw new Error("Receipt domain does not match the trusted chain and verifier.");
  const s = BigInt(`0x${receipt.sig.slice(66, 130)}`), v = Number.parseInt(receipt.sig.slice(130), 16);
  if (s === 0n || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n || ![0, 1, 27, 28].includes(v)) throw new Error("Receipt signature is not canonical.");
  const typed = receiptTypedData(receipt), digest = hashTypedData(typed);
  if (!same(digest, receipt.typedHash)) throw new Error("Receipt hash does not match its signed fields and domain.");
  let signer: Hex;
  try { signer = await recoverTypedDataAddress({ ...typed, signature: receipt.sig }); }
  catch { throw new Error("Receipt signature is invalid."); }
  if (!same(signer, trust.signer)) throw new Error("Receipt was not signed by the trusted signer.");
  return { kind: "local" as const, digest, signer, hardwareAttestationVerified: false as const, ioHashesVerified: false as const };
}

export function validateRpcUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter an HTTPS RPC URL or localhost HTTP URL."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash) throw new Error("RPC requires HTTPS, except on localhost; embedded login credentials are not allowed.");
  return url.href;
}
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][\da-f]*)$/i).transform(v => BigInt(v));
const blockSchema = z.object({ number: quantity, hash: hex });
const txSchema = z.object({ transactionHash: hex, blockHash: hex, blockNumber: quantity, status: z.literal("0x1"),
  logs: z.array(z.object({ address, data: z.string().regex(/^0x(?:[\da-f]{2})*$/i).transform(v => v as Hex), topics: z.array(hex), removed: z.boolean().optional() })) });
export type RpcRead = (method: string, params: unknown[]) => Promise<unknown>;
export function browserRpc(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): RpcRead {
  const endpoint = validateRpcUrl(url);
  let sequence = 0;
  return async (method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getTransactionReceipt"].includes(method)) throw new Error("Only read-only verification calls are allowed.");
    const id = ++sequence;
    try {
      const response = await fetcher(endpoint, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      if (!response.ok || Number(response.headers.get("content-length")) > 1_048_576 || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1_048_576) { await reader.cancel(); throw new Error(); } chunks.push(next.value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (body.jsonrpc !== "2.0" || body.id !== id || body.error || !("result" in body)) throw new Error();
      return body.result;
    } catch { throw new Error(signal.aborted ? "Verification cancelled." : "RPC request failed or returned invalid data. Check the endpoint, CORS support and contract policy."); }
  };
}

/** Uses a user-selected RPC and explicit trust roots; never takes endpoints or trust roots from uploaded JSON. */
export async function verifyOnchainReceipt(receipt: PortableReceipt, trust: ReceiptTrust, rpc: RpcRead) {
  const local = await verifyLocalReceipt(receipt, trust);
  if (quantity.parse(await rpc("eth_chainId", [])) !== BigInt(trust.chainId)) throw new Error("RPC network does not match the trusted chain ID.");
  const block = blockSchema.parse(await rpc("eth_getBlockByNumber", ["latest", false]));
  const blockTag = `0x${block.number.toString(16)}`;
  const code = await rpc("eth_getCode", [trust.verifierAddress, blockTag]);
  if (typeof code !== "string" || !/^0x[\da-f]+$/i.test(code) || code === "0x0") throw new Error("No verifier contract exists at the trusted address.");
  const call = async (data: Hex, to: Hex = trust.verifierAddress) => {
    const result = await rpc("eth_call", [{ to, data }, blockTag]);
    if (typeof result !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(result)) throw new Error("Invalid contract response.");
    return result as Hex;
  };
  const currentSigner = decodeFunctionResult({ abi: verifierAbi, functionName: "enclaveSigner", data: await call(encodeFunctionData({ abi: verifierAbi, functionName: "enclaveSigner" })) });
  if (!same(currentSigner, trust.signer)) throw new Error("The verifier's current signer differs from the trusted signer. Historical receipts may require a separate historical policy review.");
  const message = receiptTypedData(receipt).message;
  const functionName = receipt.receiptVersion === 2 ? "verifyReceipt" : "verifyLegacyReceipt";
  const verified = decodeFunctionResult({ abi: verifierAbi, functionName, data: await call(encodeFunctionData({ abi: verifierAbi, functionName, args: [message, receipt.sig] })) });
  if (!same(verified, local.digest)) throw new Error("The verifier returned a different receipt hash.");
  const registry = decodeFunctionResult({ abi: verifierAbi, functionName: "registry", data: await call(encodeFunctionData({ abi: verifierAbi, functionName: "registry" })) });
  address.parse(registry);
  const listingId = decodeFunctionResult({ abi: registryAbi, functionName: "idByHashes", data: await call(encodeFunctionData({ abi: registryAbi, functionName: "idByHashes", args: [receipt.modelHash, receipt.codeHash] }), registry) });
  if (listingId === 0n) throw new Error("The receipt model/code pair has no registry listing.");
  const [policyHash, policyVersion] = decodeFunctionResult({ abi: registryAbi, functionName: "listingPolicy", data: await call(encodeFunctionData({ abi: registryAbi, functionName: "listingPolicy", args: [listingId] }), registry) });
  let anchor: { status: "not-provided" | "pending" | "confirmed"; confirmations: string } = { status: "not-provided", confirmations: "0" };
  if (receipt.anchoredTx) {
    const raw = await rpc("eth_getTransactionReceipt", [receipt.anchoredTx]);
    if (raw === null) anchor = { status: "pending", confirmations: "0" };
    else {
      const tx = txSchema.parse(raw);
      if (!same(tx.transactionHash, receipt.anchoredTx) || tx.blockNumber > block.number) throw new Error("Anchor transaction is inconsistent with the checked chain snapshot.");
      const canonical = blockSchema.parse(await rpc("eth_getBlockByNumber", [`0x${tx.blockNumber.toString(16)}`, false]));
      if (canonical.number !== tx.blockNumber || !same(canonical.hash, tx.blockHash)) throw new Error("Anchor transaction is not in the canonical block.");
      const matches = tx.logs.some(log => {
        if (!same(log.address, trust.verifierAddress) || log.removed) return false;
        try {
          const event = decodeEventLog({ abi: verifierAbi, eventName: "Verified", data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
          return same(event.args.receiptHash, local.digest) && same(event.args.signer, trust.signer) && (["modelHash", "codeHash", "inHash", "outHash", "attRef"] as const).every(k => same(event.args[k], receipt[k]));
        } catch { return false; }
      });
      if (!matches) throw new Error("Anchor transaction does not contain this receipt's Verified event from the trusted verifier.");
      anchor = { status: "confirmed", confirmations: String(block.number - tx.blockNumber + 1n) };
    }
  }
  const finalBlock = blockSchema.parse(await rpc("eth_getBlockByNumber", [blockTag, false]));
  if (finalBlock.number !== block.number || !same(finalBlock.hash, block.hash)) throw new Error("The chain reorganized during verification. Run the check again.");
  return { ...local, kind: "chain" as const, blockNumber: String(block.number), registry, listingId: String(listingId), policyHash, policyVersion: String(policyVersion), policyBound: policyVersion > 0n && !/^0x0{64}$/i.test(policyHash), anchor };
}
