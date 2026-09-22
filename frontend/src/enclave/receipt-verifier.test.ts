import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { browserRpc, parseReceipt, receiptTypedData, registryAbi, validateRpcUrl, verifierAbi, verifyLocalReceipt, verifyOnchainReceipt, type PortableReceipt, type RpcRead } from "./receipt-verifier";

const h = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const signer = privateKeyToAccount(h("11")), other = privateKeyToAccount(h("22"));
const verifier = `0x${"ab".repeat(20)}` as Hex, registry = `0x${"cd".repeat(20)}` as Hex;
const trust = { chainId: 31337, verifierAddress: verifier, signer: signer.address };
export async function signedReceipt(version: 1 | 2 = 2) {
  const r: PortableReceipt = { receiptVersion: version, chainId: trust.chainId, verifierAddress: verifier,
    nonce: version === 2 ? h("01") : null, modelHash: h("02"), codeHash: h("03"), inHash: h("04"), outHash: h("05"), attRef: h("06"), ts: "1800000000", sig: `0x${"00".repeat(65)}`, typedHash: h("00"), anchoredTx: h("07") };
  const typed = receiptTypedData(r); r.sig = await signer.signTypedData(typed); r.typedHash = hashTypedData(typed); return r;
}
function fixture(r: PortableReceipt, options: { signer?: Hex; chain?: string; code?: string; policy?: boolean; anchor?: "pending" | "reverted" | "wrong-event" | "wrong-contract" | "reorg"; changeSnapshot?: boolean; contractHash?: Hex; rejected?: boolean } = {}) {
  const reads: Array<{ method: string; params: unknown[] }> = [];
  const rpc: RpcRead = async (method, params) => {
    reads.push({ method, params });
    if (method === "eth_chainId") return options.chain ?? "0x7a69";
    if (method === "eth_getBlockByNumber") return params[0] === "0x8" ? { number: "0x8", hash: options.anchor === "reorg" ? h("99") : h("08") } : { number: "0xa", hash: options.changeSnapshot && params[0] === "0xa" ? h("99") : h("0a") };
    if (method === "eth_getCode") return options.code ?? "0x1234";
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: Hex; data: Hex };
      if (to === verifier) {
        const { functionName } = decodeFunctionData({ abi: verifierAbi, data });
        if (functionName === "enclaveSigner") return encodeFunctionResult({ abi: verifierAbi, functionName, result: options.signer ?? signer.address });
        if (functionName === "registry") return encodeFunctionResult({ abi: verifierAbi, functionName, result: registry });
        if (options.rejected) throw new Error("Model policy rejected the receipt");
        return encodeFunctionResult({ abi: verifierAbi, functionName, result: options.contractHash ?? r.typedHash });
      }
      const { functionName } = decodeFunctionData({ abi: registryAbi, data });
      return functionName === "idByHashes" ? encodeFunctionResult({ abi: registryAbi, functionName, result: 1n }) : encodeFunctionResult({ abi: registryAbi, functionName, result: options.policy === false ? [h("00"), 0n] : [h("09"), 3n] });
    }
    if (method === "eth_getTransactionReceipt") {
      if (options.anchor === "pending") return null;
      return { transactionHash: r.anchoredTx, blockHash: h("08"), blockNumber: "0x8", status: options.anchor === "reverted" ? "0x0" : "0x1", logs: [{ address: options.anchor === "wrong-contract" ? registry : verifier, topics: encodeEventTopics({ abi: verifierAbi, eventName: "Verified", args: { receiptHash: options.anchor === "wrong-event" ? h("ff") : r.typedHash } }), data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }], [r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, signer.address]) }] };
    }
    throw new Error("Unexpected RPC method");
  };
  return { rpc, reads };
}

describe("portable receipt verification", () => {
  it.each([1, 2] as const)("checks a v%i exported receipt without network access", async version => {
    const receipt = parseReceipt(JSON.stringify(await signedReceipt(version)));
    const result = await verifyLocalReceipt(receipt, trust);
    expect(result).toMatchObject({ signer: signer.address, digest: receipt.typedHash, hardwareAttestationVerified: false, ioHashesVerified: false });
  });
  it.each(["modelHash", "codeHash", "inHash", "outHash", "attRef", "nonce", "typedHash"] as const)("rejects tampered %s", async field => {
    await expect(verifyLocalReceipt({ ...await signedReceipt(), [field]: h("ff") }, trust)).rejects.toThrow();
  });
  it("requires independently supplied signer and domain", async () => {
    const r = await signedReceipt();
    await expect(verifyLocalReceipt(r, { ...trust, signer: other.address })).rejects.toThrow("trusted signer");
    await expect(verifyLocalReceipt(r, { ...trust, chainId: 1 })).rejects.toThrow("domain");
    await expect(verifyLocalReceipt(r, { ...trust, verifierAddress: registry })).rejects.toThrow("domain");
  });
  it.each([{ receiptVersion: 3 }, { nonce: null }, { ts: "18446744073709551616" }, { ts: "-1" }, { ts: "01" }, { chainId: 9007199254740992 }, { chainId: null }, { verifierAddress: null }, { anchoredTx: "javascript:bad" }])("rejects malformed metadata %#", async patch => {
    expect(() => parseReceipt(JSON.stringify({ ...awaitableReceipt, ...patch }))).toThrow();
  });
  const awaitableReceipt = { receiptVersion: 2, chainId: 31337, verifierAddress: verifier, nonce: h("01"), modelHash: h("02"), codeHash: h("03"), inHash: h("04"), outHash: h("05"), attRef: h("06"), ts: "1", sig: `0x${"11".repeat(65)}`, typedHash: h("07") };
  it("rejects oversized JSON and a receipt collection", () => {
    expect(() => parseReceipt(" ".repeat(65_537))).toThrow("64 KiB");
    expect(() => parseReceipt(JSON.stringify({ receipts: [] }))).toThrow("single exported receipt");
  });
  it("rejects malleable and invalid recovery signatures", async () => {
    const r = await signedReceipt();
    await expect(verifyLocalReceipt({ ...r, sig: `${r.sig.slice(0, 66)}${"ff".repeat(32)}1b` as Hex }, trust)).rejects.toThrow("canonical");
    await expect(verifyLocalReceipt({ ...r, sig: `${r.sig.slice(0, 130)}20` as Hex }, trust)).rejects.toThrow("canonical");
  });
});

describe("on-chain receipt checks", () => {
  it.each([1, 2] as const)("checks v%i contract acceptance, policy and anchor at one snapshot", async version => {
    const r = await signedReceipt(version), f = fixture(r); const result = await verifyOnchainReceipt(r, trust, f.rpc);
    expect(result).toMatchObject({ policyBound: true, policyVersion: "3", blockNumber: "10", anchor: { status: "confirmed", confirmations: "3" } });
    expect(f.reads.filter(r => r.method === "eth_call").every(r => r.params[1] === "0xa")).toBe(true);
    expect(f.reads.some(r => /send|sign/i.test(r.method))).toBe(false);
  });
  it.each([{ chain: "0x1" }, { code: "0x" }, { signer: other.address }, { contractHash: h("ff") }, { rejected: true }, { anchor: "wrong-event" }, { anchor: "wrong-contract" }, { anchor: "reverted" }, { anchor: "reorg" }, { changeSnapshot: true }] as const)("rejects false chain evidence %#", async options => {
    const r = await signedReceipt(); await expect(verifyOnchainReceipt(r, trust, fixture(r, options).rpc)).rejects.toThrow();
  });
  it("does not equate contract acceptance with anchoring or bound policy", async () => {
    const r = { ...await signedReceipt(), anchoredTx: null };
    expect(await verifyOnchainReceipt(r, trust, fixture(r, { policy: false }).rpc)).toMatchObject({ policyBound: false, anchor: { status: "not-provided" } });
    const pending = await signedReceipt(); expect(await verifyOnchainReceipt(pending, trust, fixture(pending, { anchor: "pending" }).rpc)).toMatchObject({ anchor: { status: "pending" } });
  });
  it("rejects tampering before any RPC call", async () => {
    const r = await signedReceipt(), f = fixture(r); await expect(verifyOnchainReceipt({ ...r, outHash: h("ff") }, trust, f.rpc)).rejects.toThrow(); expect(f.reads).toHaveLength(0);
  });
});

describe("browser RPC transport", () => {
  it.each(["http://remote.example", "https://user:password@example.com", "javascript:alert(1)", "https://example.com/#x"])("rejects unsafe URL %s", value => expect(() => validateRpcUrl(value)).toThrow());
  it("allows local Anvil and HTTPS providers", () => { expect(validateRpcUrl("http://127.0.0.1:18545")).toContain("18545"); expect(validateRpcUrl("https://rpc.example")).toBe("https://rpc.example/"); });
  it("omits credentials and redirects and never submits a transaction", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })));
    const rpc = browserRpc("https://rpc.example", new AbortController().signal, fetcher);
    expect(await rpc("eth_chainId", [])).toBe("0x1"); expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    await expect(rpc("eth_sendTransaction", [])).rejects.toThrow("read-only"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ jsonrpc: "2.0", id: 2, result: "0x1" }, { jsonrpc: "2.0", id: 1, error: { message: "private endpoint" } }, null])("rejects invalid RPC envelopes without exposing their contents %#", async body => {
    const rpc = browserRpc("https://rpc.example", new AbortController().signal, vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))); await expect(rpc("eth_chainId", [])).rejects.toThrow("RPC request failed");
  });
  it("bounds streamed RPC responses", async () => {
    const rpc = browserRpc("https://rpc.example", new AbortController().signal, vi.fn().mockResolvedValue(new Response("x".repeat(1_048_577)))); await expect(rpc("eth_chainId", [])).rejects.toThrow("RPC request failed");
  });
});
