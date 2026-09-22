// Node's process.kill is forceful on Windows. The launcher uses this private IPC
// channel to invoke each service's existing graceful SIGTERM handler instead.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM", "SIGTERM");
  else process.exit(0);
}
if (process.send) {
  process.on("message", (message) => {
    if (message?.type === "enclave:shutdown") shutdown();
  });
  process.once("disconnect", shutdown);
  process.channel?.unref();
}
