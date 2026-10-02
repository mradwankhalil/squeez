import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildWrappedCommand,
  buildWslSupervisorScript,
  createHooks,
  detectWslDistro,
  isAlreadyWrapped,
  isWslCommand,
  resolveShellFamily,
  resolveSqueezBinary,
  resolveWrapTimeoutSecs,
  shouldWrapTool,
  squeezInstalled,
} from "../plugins/squeez.js";

test("resolves the Windows Squeez executable", () => {
  assert.equal(
    resolveSqueezBinary({ platform: "win32", home: "C:\\Users\\Test" }),
    "C:\\Users\\Test\\.claude\\squeez\\bin\\squeez.exe",
  );
});

test("wraps OpenCode shell tools", () => {
  assert.equal(shouldWrapTool("shell"), true);
  assert.equal(shouldWrapTool("bash"), true);
  assert.equal(shouldWrapTool("read"), false);
});

test("preserves a PowerShell command through the Windows wrapper", () => {
  const command = "Get-ChildItem 'C:\\Program Files' | Select-Object -First 2";
  const wrapped = buildWrappedCommand(command, {
    platform: "win32",
    squeezBinary: "C:\\Users\\Test\\.claude\\squeez\\bin\\squeez.exe",
  });
  const encoded = wrapped.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), command);
  assert.match(wrapped, /squeez\.exe/);
  assert.match(wrapped, / wrap /);
});

test("classifies wsl commands", () => {
  assert.equal(isWslCommand("wsl.exe -d Ubuntu-24.04 -- bash -lc 'ls'"), true);
  assert.equal(isWslCommand("wsl -- ls"), true);
  assert.equal(isWslCommand("git status --short"), false);
  assert.equal(isWslCommand(undefined), false);
});

test("detects the wsl distribution", () => {
  assert.equal(detectWslDistro("wsl.exe -d Ubuntu-24.04 -- ls"), "Ubuntu-24.04");
  assert.equal(detectWslDistro("wsl.exe --distribution Debian -- ls"), "Debian");
  assert.equal(detectWslDistro("wsl.exe --distribution=Kali -- ls"), "Kali");
  assert.equal(detectWslDistro("wsl.exe -- ls"), null);
});

test("resolves the wrap timeout from the environment", () => {
  assert.equal(resolveWrapTimeoutSecs({}), 360);
  assert.equal(resolveWrapTimeoutSecs({ SQUEEZ_WRAP_TIMEOUT_SECS: "45" }), 45);
  assert.equal(resolveWrapTimeoutSecs({ SQUEEZ_WRAP_TIMEOUT_SECS: "0" }), 360);
  assert.equal(resolveWrapTimeoutSecs({ SQUEEZ_WRAP_TIMEOUT_SECS: "nope" }), 360);
});

test("leaves non-wsl windows commands byte-identical", () => {
  const command = "Get-ChildItem 'C:\\Program Files' | Select-Object -First 2";
  const wrapped = buildWrappedCommand(command, {
    platform: "win32",
    squeezBinary: "C:\\Users\\Test\\.claude\\squeez\\bin\\squeez.exe",
  });
  const encoded = wrapped.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), command);
  assert.doesNotMatch(wrapped, /WaitForExit/);
});

test("supervises wsl commands with a bounded wait and exit 124", () => {
  const command = "wsl.exe -d Ubuntu-24.04 -- bash -lc 'git status --untracked-files=all'";
  const wrapped = buildWrappedCommand(command, {
    platform: "win32",
    squeezBinary: "C:\\Users\\Test\\.claude\\squeez\\bin\\squeez.exe",
    env: { SQUEEZ_WRAP_TIMEOUT_SECS: "9" },
  });
  const encoded = wrapped.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");

  assert.match(script, /WaitForExit\(9000\)/);
  assert.match(script, /taskkill \/F \/T \/PID/);
  assert.match(script, /exit 124/);
  assert.match(script, /UseShellExecute=\$false/);

  const inner = script.match(/\$inner='([A-Za-z0-9+/=]+)'/)?.[1];
  assert.ok(inner);
  assert.equal(Buffer.from(inner, "base64").toString("utf16le"), command);
});

test("keeps linux-side distro termination opt-in", () => {
  const base = {
    innerCommandB64: "AAA=",
    timeoutMs: 1000,
    timeoutSecs: 1,
    distro: "Ubuntu-24.04",
  };
  assert.doesNotMatch(buildWslSupervisorScript(base), /--terminate/);
  assert.match(
    buildWslSupervisorScript({ ...base, terminateDistro: true }),
    /wsl\.exe --terminate Ubuntu-24\.04/,
  );
});


// ── shell family (X-124): the wrapper must match the shell OpenCode runs ──

const WIN_BIN = "C:\\Users\\Test\\.claude\\squeez\\bin\\squeez.exe";

test("resolves the shell family from the configured OpenCode shell", () => {
  const win = { platform: "win32", env: {} };
  assert.equal(resolveShellFamily({ ...win, configShell: "bash" }), "posix");
  assert.equal(resolveShellFamily({ ...win, configShell: "C:\\Program Files\\Git\\bin\\bash.exe" }), "posix");
  assert.equal(resolveShellFamily({ ...win, configShell: "pwsh" }), "powershell");
  assert.equal(resolveShellFamily({ ...win, configShell: "C:/Users/Test/.orca/agent-hooks/opencode-shell.exe" }), "powershell");
  assert.equal(resolveShellFamily(win), "powershell");
  assert.equal(resolveShellFamily({ platform: "win32", env: { SHELL: "/usr/bin/bash" } }), "posix");
  assert.equal(resolveShellFamily({ platform: "linux", env: {} }), "posix");
});

test("wraps with POSIX quoting when the Windows shell is bash", () => {
  const command = "cd /c/tmp && echo \"it's $HOME\" | grep -n 'a|b'";
  const wrapped = buildWrappedCommand(command, {
    platform: "win32",
    shellFamily: "posix",
    squeezBinary: WIN_BIN,
  });
  assert.equal(
    wrapped,
    "'C:/Users/Test/.claude/squeez/bin/squeez.exe' wrap 'cd /c/tmp && echo \"it'\\''s $HOME\" | grep -n '\\''a|b'\\'''",
  );
  assert.doesNotMatch(wrapped, /-EncodedCommand/);
  assert.doesNotMatch(wrapped, /^&/);
});

test("leaves wsl commands unwrapped under bash so the host timeout bounds them", () => {
  const command = "wsl.exe -d Ubuntu-24.04 -- bash -lc 'ls'";
  assert.equal(
    buildWrappedCommand(command, { platform: "win32", shellFamily: "posix", squeezBinary: WIN_BIN }),
    command,
  );
});

test("recognises a command that is already wrapped, in either form", () => {
  const ps = buildWrappedCommand("echo hi", { platform: "win32", squeezBinary: WIN_BIN });
  const posix = buildWrappedCommand("echo hi", { platform: "win32", shellFamily: "posix", squeezBinary: WIN_BIN });
  assert.equal(isAlreadyWrapped(ps), true);
  assert.equal(isAlreadyWrapped(posix), true);
  assert.equal(isAlreadyWrapped("/home/u/.claude/squeez/bin/squeez wrap 'ls'"), true);
  assert.equal(isAlreadyWrapped("squeez wrap ls"), true);
  assert.equal(isAlreadyWrapped("echo hi"), false);
  assert.equal(isAlreadyWrapped("ls ~/.claude/squeez/bin"), false);
});

test("the before-hook follows the shell the config hook reports", async () => {
  const hooks = createHooks({ squeezBinary: WIN_BIN, platform: "win32", env: {} });

  const first = { args: { command: "echo hi" } };
  await hooks["tool.execute.before"]({ tool: "bash" }, first);
  assert.match(first.args.command, /^& '.*squeez\.exe' wrap 'powershell\.exe .* -EncodedCommand /);

  await hooks.config({ shell: "bash" });
  const second = { args: { command: "echo hi" } };
  await hooks["tool.execute.before"]({ tool: "bash" }, second);
  assert.equal(second.args.command, "'C:/Users/Test/.claude/squeez/bin/squeez.exe' wrap 'echo hi'");

  await hooks["tool.execute.before"]({ tool: "bash" }, second);
  assert.equal(second.args.command, "'C:/Users/Test/.claude/squeez/bin/squeez.exe' wrap 'echo hi'");

  const bypass = { args: { command: "--no-squeez echo hi" } };
  await hooks["tool.execute.before"]({ tool: "bash" }, bypass);
  assert.equal(bypass.args.command, "--no-squeez echo hi");
});

// ── no synchronous child processes (X-124): inside the OpenCode server the first
//    execSync of a hook call fails at once with a false ETIMEDOUT ──

test("the installed check does not start a process", () => {
  assert.equal(squeezInstalled(WIN_BIN, () => true), true);
  assert.equal(squeezInstalled(WIN_BIN, () => false), false);
  assert.equal(squeezInstalled(WIN_BIN, () => { throw new Error("denied"); }), false);
});

test("applies the read and grep budget through the async runner, once per tool", async () => {
  const calls = [];
  const hooks = createHooks({
    squeezBinary: WIN_BIN,
    platform: "win32",
    env: {},
    runSqueez: async (args) => {
      calls.push(args.join(" "));
      return args[1] === "Read" ? '{"limit":300}\n' : '{"head_limit":100}\n';
    },
  });

  const read = { args: { filePath: "a" } };
  await hooks["tool.execute.before"]({ tool: "read" }, read);
  assert.deepEqual(read.args, { filePath: "a", limit: 300 });

  const explicit = { args: { filePath: "a", limit: 5 } };
  await hooks["tool.execute.before"]({ tool: "read" }, explicit);
  assert.equal(explicit.args.limit, 5);

  const grep = { args: { pattern: "x" } };
  await hooks["tool.execute.before"]({ tool: "grep" }, grep);
  assert.equal(grep.args.head_limit, 100);

  const other = { args: { filePath: "a" } };
  await hooks["tool.execute.before"]({ tool: "edit" }, other);
  assert.deepEqual(other.args, { filePath: "a" });

  assert.deepEqual(calls, ["budget-params Read", "budget-params Grep"]);
});

test("retries a failed budget lookup once, does not cache a failure, never throws", async () => {
  let attempts = 0;
  const flaky = createHooks({
    squeezBinary: WIN_BIN,
    platform: "win32",
    env: {},
    runSqueez: async () => {
      if (attempts++ === 0) throw new Error("spawn ETIMEDOUT");
      return '{"limit":300}';
    },
  });
  const first = { args: { filePath: "a" } };
  await flaky["tool.execute.before"]({ tool: "read" }, first);
  assert.equal(first.args.limit, 300);
  assert.equal(attempts, 2);

  let dead = 0;
  const broken = createHooks({
    squeezBinary: WIN_BIN,
    platform: "win32",
    env: {},
    runSqueez: async () => { dead++; throw new Error("gone"); },
  });
  const untouched = { args: { filePath: "a" } };
  await broken["tool.execute.before"]({ tool: "read" }, untouched);
  assert.deepEqual(untouched.args, { filePath: "a" });
  await broken["tool.execute.before"]({ tool: "read" }, { args: { filePath: "b" } });
  assert.equal(dead, 4);
});

test("the plugin source never starts a child process synchronously", () => {
  const source = readFileSync(new URL("../plugins/squeez.js", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\b(execSync|execFileSync|spawnSync)\b/);
});