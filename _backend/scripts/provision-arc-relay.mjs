import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Run as the dedicated service user. Never writes into the checkout or prints the secret.
try {
  if (process.platform !== "linux" || !process.getuid || process.getuid() === 0) throw Error("Run as the dedicated non-root Linux service user");
  const dir = process.env.ENCLAVE_RELAY_DIR || "/var/lib/enclave/arc-relay";
  if (!path.isAbsolute(dir)) throw Error("Relay directory must be absolute");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw Error("Relay directory must be private and owned by the service user");
  const file = path.join(dir, "signer.json");
  let created = false;
  let fd;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (fd !== undefined) {
    try {
      const privateKey = generatePrivateKey();
      const address = privateKeyToAccount(privateKey).address;
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, chainId: 5042, address, privateKey, createdAt: new Date().toISOString() }) + "\n");
      fsyncSync(fd); created = true;
    } finally { closeSync(fd); }
    const directoryFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error("Unsafe signer file permissions");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  if (stored.version !== 1 || stored.chainId !== 5042 || !/^0x[0-9a-fA-F]{64}$/.test(stored.privateKey)
    || privateKeyToAccount(stored.privateKey).address !== stored.address) throw Error("Invalid existing signer; manual recovery required, key not replaced");
  console.log(JSON.stringify({ address: stored.address, chainId: 5042, created, custody: "software", enabled: false,
    note: "Unfunded relay identity only. No transaction sent. No treasury or customer wallet key imported." }));
} catch {
  // Underlying library errors can contain key material. Do not print them.
  console.error("Relay provisioning failed. Check service-user ownership, private permissions and existing file integrity; no existing key was overwritten.");
  process.exitCode = 1;
}
