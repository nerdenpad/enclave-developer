import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hashDomain, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { sha256Hex, tcbPolicyRecord } from "@enclave/core";
import { acceptancePlanSchema, createAcceptanceChain, type AcceptanceChain } from "./accept-near-arc.js";

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(),
  getTransactionReceipt: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async importOriginal => ({ ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc), http: vi.fn(() => ({ name: "offline-mocked-transport" })),
}));

// Synthetic event/contract fixtures only. No transactions, live RPC, or hardware claims.
const address = (number: number): Hex => `0x${number.toString(16).padStart(40, "0")}`;
const contracts = { ModelRegistry: address(256), AttestationVerifier: address(257), USDC: address(258),
  UsageMeter: address(259), FeeVault: address(260) };
const signer = address(512), payer = address(513), unrelatedAddress = address(514);
const software = tcbPolicyRecord({ version: 2, servingImageId: "synthetic-chain-unit", requireCpuTee: true, requireGpuCc: true });
const plan = acceptancePlanSchema.parse({ schemaVersion: 1, providerOrigin: "https://cloud-api.near.ai",
  walletAuthOrigin: "https://acceptance.example.test", expectedPriceUnits: "100000", maxOutputTokens: 32,
  confirmations: 12, usdcDomain: { name: "SYNTHETIC USDC", version: "2" }, acceptanceValidUntil: "2026-10-02T12:00:00Z",
  release: { schemaVersion: 1, origin: "https://acceptance.example.test", chainId: 5042, modelId: "Synthetic/ChainUnit",
    servingImageId: "synthetic-chain-unit", tcbVersion: 2, modelHash: sha256Hex("model:Synthetic/ChainUnit"),
    codeHash: software.measurement, policyHash: software.policyHash, signer, contracts,
    providerPolicy: { path: "synthetic-unused-policy.json", sha256: sha256Hex("synthetic unit policy"),
      version: "synthetic-unit-v1", reviewedAt: "2026-10-01T09:00:00Z", reviewedBy: "unit-fixture-only", scope: "production" } } });
type ChainInput = Parameters<AcceptanceChain["verify"]>[1];
const settleTx = sha256Hex("synthetic settlement transaction"), anchorTx = sha256Hex("synthetic anchor transaction");
const settleBlock = sha256Hex("synthetic settlement block"), anchorBlock = sha256Hex("synthetic anchor block");
const snapshotHash = sha256Hex("synthetic preflight snapshot"), unrelatedHash = sha256Hex("unrelated synthetic fact");
const input: ChainInput = { paymentId: "10000000-0000-4000-8000-000000000001", payer, settleTx, anchorTx,
  receipt: { receiptVersion: 2, chainId: 5042, verifierAddress: contracts.AttestationVerifier,
    typedHash: sha256Hex("synthetic previously validated receipt hash"), modelHash: plan.release.modelHash,
    codeHash: plan.release.codeHash, inHash: sha256Hex("synthetic input"), outHash: sha256Hex("synthetic output"),
    attRef: sha256Hex("synthetic session reference"), nonce: sha256Hex("synthetic receipt nonce"),
    ts: "1790855995", sig: `0x${"11".repeat(65)}` } };
const domainTypes = { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } as const;
const domainHash = (chainId: number, token: Hex) => hashDomain({
  domain: { ...plan.usdcDomain, chainId: BigInt(chainId), verifyingContract: token }, types: domainTypes });
const expectedDomain = domainHash(5042, contracts.USDC);
const meterAbi = parseAbi(["event Settled(address indexed payer,uint256 amount,bytes32 indexed receiptHash,bool confidentialPath)"]);
const verifierAbi = parseAbi(["event Verified(bytes32 indexed receiptHash,bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,address signer)"]);

function settlementEvent(overrides: Partial<{ address: Hex; payer: Hex; amount: bigint; receiptHash: Hex; confidentialPath: boolean }> = {}) {
  return { address: overrides.address ?? contracts.UsageMeter,
    topics: encodeEventTopics({ abi: meterAbi, eventName: "Settled", args: {
      payer: overrides.payer ?? payer, receiptHash: overrides.receiptHash ?? keccak256(stringToHex(input.paymentId)) } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }],
      [overrides.amount ?? 100_000n, overrides.confidentialPath ?? false]) };
}
type AnchorOverrides = Partial<Pick<ChainInput["receipt"], "modelHash" | "codeHash" | "inHash" | "outHash" | "attRef">
  & { address: Hex; receiptHash: Hex; signer: Hex }>;
function anchorEvent(overrides: AnchorOverrides = {}) {
  return { address: overrides.address ?? contracts.AttestationVerifier,
    topics: encodeEventTopics({ abi: verifierAbi, eventName: "Verified", args: { receiptHash: overrides.receiptHash ?? input.receipt.typedHash } }),
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [overrides.modelHash ?? input.receipt.modelHash, overrides.codeHash ?? input.receipt.codeHash,
        overrides.inHash ?? input.receipt.inHash, overrides.outHash ?? input.receipt.outHash,
        overrides.attRef ?? input.receipt.attRef, overrides.signer ?? signer]) };
}
function settlementReceipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash: settleTx, blockHash: settleBlock, blockNumber: 101n, status: "success",
    to: contracts.UsageMeter, logs: [settlementEvent()], ...overrides };
}
function anchorReceipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash: anchorTx, blockHash: anchorBlock, blockNumber: 100n, status: "success",
    to: contracts.AttestationVerifier, logs: [anchorEvent()], ...overrides };
}
function readFixture({ functionName }: { functionName: string }) {
  const values: Record<string, unknown> = { TCB_BINDING_VERSION: 1n, isApprovedWithPolicy: true,
    registry: contracts.ModelRegistry, enclaveSigner: signer, usdc: contracts.USDC,
    feeVault: contracts.FeeVault, modelRegistry: contracts.ModelRegistry,
    decimals: 6, DOMAIN_SEPARATOR: expectedDomain, balanceOf: 750_000n };
  if (!(functionName in values)) throw new Error("Unexpected offline contract read");
  return values[functionName];
}
function mockTransaction(kind: "settlement" | "anchor", overrides: Record<string, unknown>) {
  rpc.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => hash === settleTx
    ? settlementReceipt(kind === "settlement" ? overrides : {}) : anchorReceipt(kind === "anchor" ? overrides : {}));
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockReset().mockResolvedValue(5042);
  rpc.getBlockNumber.mockReset().mockResolvedValue(113n);
  rpc.getBlock.mockReset().mockImplementation(async (options?: { blockNumber: bigint }) => options?.blockNumber === 100n
    ? { number: 100n, hash: anchorBlock } : options?.blockNumber === 101n
      ? { number: 101n, hash: settleBlock } : { number: options?.blockNumber ?? 200n, hash: snapshotHash });
  rpc.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) =>
    hash === settleTx ? settlementReceipt() : anchorReceipt());
  rpc.readContract.mockReset().mockImplementation(async (call: { functionName: string }) => readFixture(call));
});

describe("independent Arc acceptance receipt checks", () => {
  it("accepts the exact confirmed, canonical settlement and anchor events", async () => {
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).resolves.toBeUndefined();
    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash: settleTx });
    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash: anchorTx });
    expect(rpc.getBlock).toHaveBeenCalledTimes(4);
  });

  it.each([1, 5042002])("rejects wrong RPC chain %s before reading transactions", async chainId => {
    rpc.getChainId.mockResolvedValue(chainId);
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("RPC_CHAIN_MISMATCH");
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it.each(["settlement", "anchor"] as const)("rejects a %s receipt returned for another requested transaction", async kind => {
    mockTransaction(kind, { transactionHash: unrelatedHash });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("TRANSACTION_NOT_CONFIRMED_CANONICAL");
  });

  it.each((["settlement", "anchor"] as const).flatMap(kind => [
    { kind, change: "reverted", override: { status: "reverted" } },
    { kind, change: "missing target", override: { to: null } },
    { kind, change: "wrong target", override: { to: unrelatedAddress } },
    { kind, change: "orphaned block", override: { blockHash: unrelatedHash } },
  ]))("rejects $kind transaction with $change", async ({ kind, override }) => {
    mockTransaction(kind, override);
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("TRANSACTION_NOT_CONFIRMED_CANONICAL");
  });

  it("rejects a settlement one block below the configured confirmation depth", async () => {
    rpc.getBlockNumber.mockResolvedValue(112n);
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("TRANSACTION_NOT_CONFIRMED_CANONICAL");
  });

  it.each([
    { address: contracts.USDC }, { payer: unrelatedAddress }, { amount: 100_001n }, { amount: 99_999n },
    { receiptHash: unrelatedHash }, { receiptHash: input.receipt.typedHash }, { confidentialPath: true },
  ])("rejects another settlement emitter, payer, amount, payment ID or path %#", async override => {
    mockTransaction("settlement", { logs: [settlementEvent(override)] });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("TRANSACTION_EVENT_MISMATCH");
  });

  it.each([
    { address: contracts.UsageMeter }, { receiptHash: unrelatedHash }, { signer: unrelatedAddress },
    { modelHash: unrelatedHash }, { codeHash: unrelatedHash }, { inHash: unrelatedHash },
    { outHash: unrelatedHash }, { attRef: unrelatedHash },
  ])("rejects another anchor emitter, receipt, signer or receipt field %#", async override => {
    mockTransaction("anchor", { logs: [anchorEvent(override)] });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("TRANSACTION_EVENT_MISMATCH");
  });

  it.each(["settlement", "anchor"] as const)("rejects missing or duplicated matching %s events", async kind => {
    const event = kind === "settlement" ? settlementEvent() : anchorEvent();
    for (const logs of [[], [event, event]]) {
      mockTransaction(kind, { logs });
      await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("TRANSACTION_EVENT_MISMATCH");
    }
  });

  it("rejects a reorg after event verification", async () => {
    rpc.getBlock.mockResolvedValueOnce({ hash: settleBlock }).mockResolvedValueOnce({ hash: anchorBlock })
      .mockResolvedValueOnce({ hash: unrelatedHash });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").verify(plan, input)).rejects.toThrow("CHAIN_REORGANIZED");
  });
});

describe("Arc acceptance contract and USDC domain preflight", () => {
  it("pins all contract reads to one canonical block and checks the exact immutable approval tuple", async () => {
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan, payer))
      .resolves.toEqual({ payerBalanceUnits: "750000" });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: contracts.ModelRegistry,
      functionName: "isApprovedWithPolicy", args: [plan.release.modelHash, plan.release.codeHash, plan.release.policyHash, 2n], blockNumber: 188n }));
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: contracts.USDC,
      functionName: "balanceOf", args: [payer], blockNumber: 188n }));
    for (const [functionName, contract] of Object.entries({ TCB_BINDING_VERSION: contracts.ModelRegistry,
      registry: contracts.AttestationVerifier, enclaveSigner: contracts.AttestationVerifier,
      usdc: contracts.UsageMeter, feeVault: contracts.UsageMeter, modelRegistry: contracts.UsageMeter,
      decimals: contracts.USDC, DOMAIN_SEPARATOR: contracts.USDC })) {
      expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: contract, functionName, blockNumber: 188n }));
    }
    expect(rpc.readContract.mock.calls.every(([call]) => call.blockNumber === 188n)).toBe(true);
    expect(rpc.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 188n });
    expect(rpc.getBlock).toHaveBeenCalledTimes(3);
  });

  it("does not infer a payer or query a relay balance when no payer is supplied", async () => {
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan)).resolves.toEqual({ payerBalanceUnits: null });
    expect(rpc.readContract.mock.calls.some(([call]) => call.functionName === "balanceOf")).toBe(false);
  });

  it("rejects a wrong RPC chain before any contract reads", async () => {
    rpc.getChainId.mockResolvedValue(5042002);
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan, payer)).rejects.toThrow("RPC_CHAIN_MISMATCH");
    expect(rpc.readContract).not.toHaveBeenCalled();
  });

  it.each([
    { name: "TCB_BINDING_VERSION", value: 0n }, { name: "TCB_BINDING_VERSION", value: 2n },
    { name: "isApprovedWithPolicy", value: false }, { name: "registry", value: unrelatedAddress },
    { name: "enclaveSigner", value: unrelatedAddress }, { name: "usdc", value: unrelatedAddress },
    { name: "feeVault", value: unrelatedAddress }, { name: "modelRegistry", value: unrelatedAddress },
    { name: "decimals", value: 18 }, { name: "DOMAIN_SEPARATOR", value: unrelatedHash },
    { name: "DOMAIN_SEPARATOR", value: domainHash(5042002, contracts.USDC) },
    { name: "DOMAIN_SEPARATOR", value: domainHash(5042, unrelatedAddress) },
  ])("rejects mismatched capability, wiring or token domain $name %#", async ({ name, value }) => {
    rpc.readContract.mockImplementation(async (call: { functionName: string }) => call.functionName === name ? value : readFixture(call));
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan, payer)).rejects.toThrow("CHAIN_POLICY_OR_DOMAIN_MISMATCH");
  });

  it("rejects a preflight block that reorganizes during the contract reads", async () => {
    rpc.getBlock.mockResolvedValueOnce({ number: 200n, hash: snapshotHash }).mockResolvedValueOnce({ number: 188n, hash: snapshotHash })
      .mockResolvedValueOnce({ number: 188n, hash: unrelatedHash });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan, payer)).rejects.toThrow("CHAIN_REORGANIZED");
  });

  it("refuses a head below the requested confirmation depth before reading contracts", async () => {
    rpc.getBlock.mockResolvedValue({ number: 11n, hash: snapshotHash });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan, payer)).rejects.toThrow("CHAIN_BLOCK_UNAVAILABLE");
    expect(rpc.readContract).not.toHaveBeenCalled();
  });

  it("refuses a confirmed block returned for another height before reading contracts", async () => {
    rpc.getBlock.mockResolvedValueOnce({ number: 200n, hash: snapshotHash }).mockResolvedValueOnce({ number: 187n, hash: snapshotHash });
    await expect(createAcceptanceChain("https://offline-rpc.example.test").preflight(plan, payer)).rejects.toThrow("CHAIN_BLOCK_UNAVAILABLE");
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
});
