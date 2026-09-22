import { isConfiguredAddress } from "@enclave/core";
import { keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";

export type Checkpoint = { number: bigint; hash: Hex };
export type ChainHeader = Checkpoint & { parentHash: Hex };
export type HeaderReader = (number: bigint) => Promise<ChainHeader>;

const storedCheckpoints = z.array(z.object({
  number: z.string().regex(/^(0|[1-9][0-9]*)$/),
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
}));

export function parseCheckpoints(json: string): Checkpoint[] {
  const rows = storedCheckpoints.parse(JSON.parse(json));
  const checkpoints = rows.map((row): Checkpoint => ({ number: BigInt(row.number), hash: `0x${row.hash.slice(2)}` }));
  for (let index = 1; index < checkpoints.length; index++) {
    if (checkpoints[index]!.number !== checkpoints[index - 1]!.number + 1n) {
      throw new Error("Indexer checkpoint history is not contiguous");
    }
  }
  return checkpoints;
}

export function serializeCheckpoints(checkpoints: Checkpoint[]): string {
  return JSON.stringify(checkpoints.map((block) => ({ number: block.number.toString(), hash: block.hash })));
}

/** Most recent retained canonical ancestor, restricted to the currently confirmed height. */
export async function findCommonAncestor(checkpoints: Checkpoint[], head: bigint, read: HeaderReader): Promise<Checkpoint | undefined> {
  for (const checkpoint of [...checkpoints].reverse()) {
    if (checkpoint.number > head) continue;
    const canonical = await read(checkpoint.number);
    if (canonical.hash.toLowerCase() === checkpoint.hash.toLowerCase()) return checkpoint;
  }
  return undefined;
}

/** Retain a bounded, contiguous header window and reject inconsistent RPC snapshots. */
export function checkpointTail(previous: Checkpoint[], headers: ChainHeader[], size: number): Checkpoint[] {
  const tail = [...previous];
  for (const header of headers) {
    const prior = tail.at(-1);
    if (prior && header.number <= prior.number) throw new Error("Indexer checkpoint would move backwards");
    if (prior && header.number === prior.number + 1n && header.parentHash.toLowerCase() !== prior.hash.toLowerCase()) {
      throw new Error("Chain reorganized while reading checkpoint headers");
    }
    if (prior && header.number > prior.number + 1n) tail.length = 0;
    tail.push({ number: header.number, hash: header.hash });
  }
  return tail.slice(-size);
}

export function indexerScope(input: {
  chainId: number;
  genesisHash: Hex;
  deploymentId?: string | undefined;
  verifier?: string | undefined;
  meter?: string | undefined;
  feeVault?: string | undefined;
  registry?: string | undefined;
}): string {
  const normalize = (value: string | undefined) => isConfiguredAddress(value) ? value.toLowerCase() : null;
  const identity = {
    genesis: input.genesisHash.toLowerCase(), deployment: input.deploymentId ?? "",
    verifier: normalize(input.verifier), meter: normalize(input.meter),
    feeVault: normalize(input.feeVault), registry: normalize(input.registry),
  };
  return `enclave-v2:${input.chainId}:${keccak256(stringToHex(JSON.stringify(identity)))}`;
}
