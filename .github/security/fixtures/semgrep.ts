// ruleid: enclave-node-tls-verification-disabled
const unsafeTls = { rejectUnauthorized: false };
// ok: enclave-node-tls-verification-disabled
const checkedTls = { rejectUnauthorized: true };
// ruleid: enclave-node-tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// ruleid: enclave-dynamic-code-execution
eval(untrustedCode);
// ruleid: enclave-dynamic-code-execution
new Function(untrustedCode);
// ok: enclave-dynamic-code-execution
JSON.parse(untrustedData);
// ruleid: enclave-shell-process-enabled
spawn(command, args, { shell: true });
// ruleid: enclave-shell-process-enabled
childProcess.spawnSync(command, args, { shell: true });
// ok: enclave-shell-process-enabled
spawn(command, args, { shell: false });
