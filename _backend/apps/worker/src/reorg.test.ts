import { describe, expect, it, vi } from "vitest";
import { checkpointTail, findCommonAncestor, indexerScope, parseCheckpoints, serializeCheckpoints, type Checkpoint, type ChainHeader } from "./reorg.js";

const hash = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const point = (number: number): Checkpoint => ({ number: BigInt(number), hash: hash(number + 1) });
const header = (number: number): ChainHeader => ({ ...point(number), parentHash: hash(number) });

describe("bounded reorg checkpoints", () => {
  it("round-trips block heights above Number.MAX_SAFE_INTEGER without precision loss", () => {
    const checkpoints = [{ number: 2n ** 60n, hash: hash(1) }];
    expect(parseCheckpoints(serializeCheckpoints(checkpoints))).toEqual(checkpoints);
  });
  it.each(["invalid-json", "{}", '[{"number":"-1","hash":"0x00"}]', JSON.stringify([{ number: "0", hash: hash(1) }, { number: "2", hash: hash(3) }])])("rejects corrupt checkpoint history %s", (json) => {
    expect(() => parseCheckpoints(json)).toThrow();
  });
  it("finds the nearest common ancestor after a shallow fork", async () => {
    const read = vi.fn(async (number: bigint) => number > 2n ? { ...header(Number(number)), hash: hash(99) } : header(Number(number)));
    expect(await findCommonAncestor([point(1), point(2), point(3), point(4)], 4n, read)).toEqual(point(2));
    expect(read.mock.calls.map(([number]) => number)).toEqual([4n, 3n, 2n]);
  });
  it("does not query heights beyond the current confirmed head after a chain rollback", async () => {
    const read = vi.fn(async (number: bigint) => header(Number(number)));
    expect(await findCommonAncestor([point(1), point(2), point(3)], 1n, read)).toEqual(point(1));
    expect(read).toHaveBeenCalledExactlyOnceWith(1n);
  });
  it("identifies forks deeper than retained history and propagates RPC failures", async () => {
    expect(await findCommonAncestor([point(3), point(4)], 4n, async (number) => ({ ...header(Number(number)), hash: hash(99) }))).toBeUndefined();
    await expect(findCommonAncestor([point(3)], 3n, async () => { throw new Error("RPC down"); })).rejects.toThrow("RPC down");
  });
  it("bounds contiguous history while preserving the immediate ancestor", () => {
    expect(checkpointTail([point(1), point(2)], [header(3), header(4)], 3)).toEqual([point(2), point(3), point(4)]);
    expect(checkpointTail([point(1)], [header(10), header(11)], 3)).toEqual([point(10), point(11)]);
  });
  it("rejects backwards history and mixed-fork adjacent block headers", () => {
    expect(() => checkpointTail([point(2)], [header(1)], 3)).toThrow("backwards");
    expect(() => checkpointTail([point(2)], [{ ...header(3), parentHash: hash(88) }], 3)).toThrow("reorganized");
  });
});

describe("chain and deployment cursor identities", () => {
  const identity = { chainId: 31337, genesisHash: hash(1), registry: "0x5FbDB2315678afecb367f032d93F642f64180aa3" };
  it("normalizes address case and unconfigured placeholders", () => {
    expect(indexerScope(identity)).toBe(indexerScope({ ...identity, registry: identity.registry.toLowerCase(), verifier: "0x0000000000000000000000000000000000000004" }));
  });
  it("keeps chains, genesis resets, deployments, contract addresses and roles separate", () => {
    const scopes = [
      identity, { ...identity, chainId: 1 }, { ...identity, genesisHash: hash(2) },
      { ...identity, deploymentId: "v2" }, { ...identity, registry: "0x000000000000000000000000000000000000abcd" },
      { ...identity, registry: undefined, verifier: identity.registry },
    ].map(indexerScope);
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});
