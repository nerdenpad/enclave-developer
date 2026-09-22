import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const SRC = path.resolve("contracts/src");

function load(name: string): string {
  return readFileSync(path.join(SRC, name), "utf8");
}

const sources: Record<string, { content: string }> = {
  "ENCL.sol": { content: load("ENCL.sol") },
  "MockUSDC.sol": { content: load("MockUSDC.sol") },
  "FeeVault.sol": { content: load("FeeVault.sol") },
  "ModelRegistry.sol": { content: load("ModelRegistry.sol") },
  "AttestationVerifier.sol": { content: load("AttestationVerifier.sol") },
  "UsageMeter.sol": { content: load("UsageMeter.sol") },
  "InsuranceStaking.sol": { content: load("InsuranceStaking.sol") },
  "AgentMandate.sol": { content: load("AgentMandate.sol") },
  "MockConfidentialTransfer.sol": { content: load("MockConfidentialTransfer.sol") },
  "interfaces/IArcConfidentialTransfer.sol": {
    content: load("interfaces/IArcConfidentialTransfer.sol"),
  },
};

function findImports(importPath: string): { contents: string } | { error: string } {
  const mapped = importPath.startsWith("./") ? importPath.slice(2) : importPath;
  const src = sources[mapped];
  if (!src) {
    return { error: `missing ${importPath}` };
  }
  return { contents: src.content };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports })) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>;
};

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
if (errors.length > 0) {
  throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
}

const outDir = path.resolve("contracts/out-solc");
mkdirSync(outDir, { recursive: true });
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, art] of Object.entries(contracts)) {
    writeFileSync(
      path.join(outDir, `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: file, abi: art.abi, bytecode: `0x${art.evm.bytecode.object}` }, null, 2),
    );
  }
}
console.log("compiled", Object.keys(output.contracts ?? {}));
