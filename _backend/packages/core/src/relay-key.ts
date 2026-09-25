import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

export function withRelayKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = env.RELAY_KEY_FILE;
  const chainId = Number(env.ARC_CHAIN_ID ?? 31337);
  if (!file) {
    if (chainId === 5042 && (!env.DEPLOYER_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY.toLowerCase() === "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")) {
      throw Error("Arc Mainnet requires a dedicated relay signer; the public development key is forbidden");
    }
    return env;
  }
  let fd: number | undefined;
  try {
    if (process.platform !== "linux" || !process.getuid || !isAbsolute(file) || chainId !== 5042 || env.DEPLOYER_PRIVATE_KEY) throw Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw Error();
    const record = JSON.parse(readFileSync(fd, "utf8")) as { version?: unknown; chainId?: unknown; privateKey?: unknown; address?: unknown };
    if (record.version !== 1 || record.chainId !== 5042 || typeof record.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.privateKey)) throw Error();
    if (privateKeyToAccount(record.privateKey as `0x${string}`).address !== record.address) throw Error();
    return { ...env, DEPLOYER_PRIVATE_KEY: record.privateKey };
  } catch {
    throw Error("Relay key file is invalid, unsafe or conflicts with the configured signer; secret details suppressed");
  } finally { if (fd !== undefined) closeSync(fd); }
}
