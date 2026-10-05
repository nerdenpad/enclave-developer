import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launcherArguments, launchPreflight } from "../scripts/launch-preflight.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(tmpdir(), "enclave checkout with spaces");
const backendManifest = path.join(fixtureRoot, "_backend", "package.json");
const frontendManifest = path.join(fixtureRoot, "frontend", "package.json");
const backendDependency = path.join(fixtureRoot, "_backend", "node_modules", "tsx", "package.json");
const frontendDependency = path.join(fixtureRoot, "frontend", "node_modules", "vite", "bin", "vite.js");
function fixture(overrides = {}) {
  const files = new Set([backendManifest, frontendManifest, backendDependency, frontendDependency]);
  const calls = [];
  const runSync = (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, stdout: args[0] === "context" ? "npipe:////./pipe/docker_engine\n" : "29.0.0\n" };
  };
  return { files, calls, options: { root: fixtureRoot, command: "dev", nodeVersion: "22.12.0", environment: {}, exists: file => files.has(file), runSync, ...overrides } };
}

test("relative profile paths use the caller's directory, including paths with spaces", () => {
  const caller = path.join(tmpdir(), "private profiles");
  assert.deepEqual(launcherArguments(["prepare", "--near-env", "profiles/provider settings.env"], caller),
    { command: "prepare", args: ["--near-env", path.resolve(caller, "profiles/provider settings.env")] });
  assert.deepEqual(launcherArguments(["prepare", "--near-env", path.join(caller, "profile.env")], repository).args,
    ["--near-env", path.join(caller, "profile.env")]);
});

test("help and invalid arguments are resolved before dependency or Docker checks", () => {
  assert.deepEqual(launcherArguments([]), { command: "dev", args: [] });
  for (const args of [["--help"], ["help"], ["prepare", "--help"], ["check", "-h"]]) {
    assert.deepEqual(launcherArguments(args), { command: "help", args: [] });
  }
  for (const args of [["deploy"], ["dev", "--near-env", "profile"], ["prepare", "--near-env"], ["prepare", "--near-env", "--register"], ["check", "extra"]]) {
    assert.throws(() => launcherArguments(args), /command|prepare|--near-env/i);
  }
});

test("an unsupported Node version fails before checking files or starting commands", () => {
  for (const nodeVersion of ["20.19.0", "22.11.9", "invalid"]) {
    const value = fixture({ nodeVersion, exists: () => { throw Error("should not read"); } });
    assert.throws(() => launchPreflight(value.options), /requires Node.js 22.12/);
    assert.equal(value.calls.length, 0);
  }
});

test("a clean checkout and a partially installed checkout give the root setup command", () => {
  for (const [missing, message] of [[backendDependency, /Backend dependencies.*repository root/], [frontendDependency, /Frontend dependencies.*repository root/]]) {
    const value = fixture(); value.files.delete(missing);
    assert.throws(() => launchPreflight(value.options), message);
    assert.equal(value.calls.length, 0);
  }
  const incomplete = fixture(); incomplete.files.delete(frontendManifest);
  assert.throws(() => launchPreflight(incomplete.options), /repository is incomplete/);
  assert.equal(incomplete.calls.length, 0);
});

test("a missing selected profile fails before Docker or any demo-state creation", () => {
  const value = fixture({ command: "prepare", args: ["--near-env", path.join(fixtureRoot, "missing.env")] });
  assert.throws(() => launchPreflight(value.options), /selected NEAR profile does not exist/);
  assert.equal(value.calls.length, 0);
});

test("registration requires a prepared profile and does not require a frontend or Docker", () => {
  const value = fixture({ command: "register" }); value.files.delete(frontendDependency);
  assert.throws(() => launchPreflight(value.options), /demo:prepare/);
  value.files.add(path.join(fixtureRoot, "_backend", ".env.demo"));
  assert.deepEqual(launchPreflight(value.options), {});
  assert.equal(value.calls.length, 0);
});

test("Docker installation and Compose failures produce specific diagnostics without raw output", () => {
  for (const [failureAt, message] of [["--version", /Docker CLI is unavailable/], ["compose", /Compose v2 is unavailable/]]) {
    const value = fixture(); const original = value.options.runSync;
    value.options.runSync = (executable, args, options) => args[0] === failureAt
      ? { status: 1, error: Error("private diagnostic"), stdout: "secret diagnostic", stderr: "private endpoint" }
      : original(executable, args, options);
    assert.throws(() => launchPreflight(value.options), error => message.test(error.message) && !/secret|private/.test(error.message));
    assert.ok(value.calls.every(call => call.args[0] !== "info"));
  }
});

test("a remote Docker endpoint is rejected before contacting its engine", () => {
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://operator@example.invalid"]) {
    const value = fixture({ environment: { DOCKER_HOST: endpoint } });
    assert.throws(() => launchPreflight(value.options), /local Docker socket/);
    assert.deepEqual(value.calls.map(call => call.args), [["--version"], ["compose", "version"]]);
  }
});

test("checks pin the inspected local socket and never invoke a service or container mutation", () => {
  for (const nodeVersion of ["22.12.0", "24.0.0"]) {
    const value = fixture({ command: "check", nodeVersion, environment: { DOCKER_CONTEXT: "selected-local", PATH: "system path" } });
    assert.deepEqual(launchPreflight(value.options), { dockerEndpoint: "npipe:////./pipe/docker_engine" });
    assert.deepEqual(value.calls.map(call => call.args[0]), ["--version", "compose", "context", "info"]);
    const info = value.calls.at(-1);
    assert.equal(info.options.env.DOCKER_HOST, "npipe:////./pipe/docker_engine");
    assert.equal(info.options.env.DOCKER_CONTEXT, undefined);
    assert.equal(info.options.env.PATH, "system path");
    assert.ok(value.calls.every(call => call.executable === "docker" && !call.args.includes("up") && !call.args.includes("stop")));
  }
});

test("an unavailable engine asks for a manual start without printing Docker diagnostics", () => {
  const value = fixture({ environment: { DOCKER_HOST: "unix:///var/run/docker.sock" } });
  const original = value.options.runSync;
  value.options.runSync = (executable, args, options) => args[0] === "info"
    ? { status: 1, stderr: "private socket diagnostic" } : original(executable, args, options);
  assert.throws(() => launchPreflight(value.options), error => /Start Docker manually/.test(error.message) && !/private/.test(error.message));
});

test("stop can operate without installed app dependencies but still requires its own profile", () => {
  const value = fixture({ command: "stop" }); value.files.delete(backendDependency); value.files.delete(frontendDependency);
  assert.throws(() => launchPreflight(value.options), /demo:prepare/);
  value.files.add(path.join(fixtureRoot, "_backend", ".env.demo"));
  assert.ok(launchPreflight(value.options).dockerEndpoint);
});

test("the real CLI handles a clean copied checkout from another directory without booting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "enclave-launch-no-boot-"));
  const checkout = path.join(directory, "checkout with spaces");
  try {
    await mkdir(path.join(checkout, "scripts"), { recursive: true });
    await mkdir(path.join(checkout, "_backend")); await mkdir(path.join(checkout, "frontend"));
    await writeFile(path.join(checkout, "_backend", "package.json"), "{}");
    await writeFile(path.join(checkout, "frontend", "package.json"), "{}");
    for (const file of ["enclave.mjs", "launch-preflight.mjs", "shutdown-preload.mjs"]) {
      await copyFile(path.join(repository, "scripts", file), path.join(checkout, "scripts", file));
    }
    const invoke = args => spawnSync(process.execPath, [path.join(checkout, "scripts", "enclave.mjs"), ...args],
      { cwd: directory, env: { ...process.env, PATH: "" }, encoding: "utf8", windowsHide: true, timeout: 5000 });
    const help = invoke(["--help"]);
    assert.equal(help.status, 0); assert.match(help.stdout, /check.*prerequisites/);
    const missing = invoke(["dev"]);
    assert.equal(missing.status, 1); assert.match(missing.stderr, /Backend dependencies.*repository root/);
    const invalid = invoke(["dev", "unexpected"]);
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Only prepare/);
    assert.ok(![help.stdout, help.stderr, missing.stdout, missing.stderr, invalid.stdout, invalid.stderr].some(value => /Enclave is ready|Starting only/.test(value)));
    await mkdir(path.join(checkout, "tests"));
    await copyFile(path.join(repository, "tests", "local-launch.mjs"), path.join(checkout, "tests", "local-launch.mjs"));
    // A caller's unrelated profile must not be mistaken for this checkout's profile.
    await mkdir(path.join(directory, "_backend"));
    await writeFile(path.join(directory, "_backend", ".env.demo"), "DEMO_API_KEY=private-test-fixture\n");
    const integration = spawnSync(process.execPath, [path.join(checkout, "tests", "local-launch.mjs")],
      { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(integration.status, 1); assert.match(integration.stderr, /demo:prepare from the repository root/);
    assert.doesNotMatch(integration.stdout + integration.stderr, /private-test-fixture|Launcher did not become ready/);
  } finally {
    assert.ok(directory.startsWith(path.join(tmpdir(), "enclave-launch-no-boot-")));
    await rm(directory, { recursive: true, force: true });
  }
});
