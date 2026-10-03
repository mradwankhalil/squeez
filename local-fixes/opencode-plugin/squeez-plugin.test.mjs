import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
// This test file runs from two layouts: the ledger keeps it next to
// squeez.js; the installed copy lives in <profile>/tests/ with the plugin in
// <profile>/plugins/. Resolve whichever layout we are in.
const PLUGIN_SPEC = existsSync(new URL("./squeez.js", import.meta.url))
  ? "./squeez.js"
  : "../plugins/squeez.js";
const {
  buildWrappedCommand,
  buildWslSupervisorScript,
  createHooks,
  createSetup,
  detectWslDistro,
  isAlreadyWrapped,
  isWslCommand,
  resolveShellFamily,
  resolveSqueezBinary,
  resolveWrapTimeoutSecs,
  shouldWrapTool,
  squeezInstalled,
  trackResult,
} = await import(PLUGIN_SPEC);

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
  const source = readFileSync(new URL(PLUGIN_SPEC, import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\b(execSync|execFileSync|spawnSync)\b/);
});


// ── v2 setup() entry (PR #242 merged with the owner overlays): hooks register
//    on ctx domains; the wrapper follows the shell each create.before carries ──

function fakeCtx() {
  const registered = { shell: [], tool: [], subscribed: false };
  return {
    registered,
    ctx: {
      shell: { hook: (name, cb) => registered.shell.push([name, cb]) },
      tool: { hook: (name, cb) => registered.tool.push([name, cb]) },
      event: { subscribe: () => { registered.subscribed = true; return (async function* () {})(); } },
    },
  };
}

test("the default export exposes both entry points", async () => {
  const mod = await import(PLUGIN_SPEC);
  assert.equal(mod.default.id, "squeez");
  assert.equal(typeof mod.default.setup, "function");
  assert.equal(typeof mod.default.server, "function");
});

test("v2 setup tolerates a null ctx and missing domains", () => {
  const setup = createSetup({ exists: () => true, runSqueez: async () => "" });
  setup(null);
  setup({});
});

test("v2 setup registers nothing when squeez is absent", () => {
  const { registered, ctx } = fakeCtx();
  createSetup({ exists: () => false, runSqueez: async () => "" })(ctx);
  assert.equal(registered.shell.length, 0);
  assert.equal(registered.tool.length, 0);
  assert.equal(registered.subscribed, false);
});

test("v2 setup wraps create.before with the shell the event carries", () => {
  const { registered, ctx } = fakeCtx();
  createSetup({ squeezBinary: WIN_BIN, platform: "win32", env: {}, exists: () => true, runSqueez: async () => "" })(ctx);
  const wrap = registered.shell.find(([name]) => name === "create.before")?.[1];
  assert.ok(wrap);

  const ps = { command: "echo hi", shell: "pwsh" };
  wrap(ps);
  assert.match(ps.command, /^& '.*squeez\.exe' wrap 'powershell\.exe .* -EncodedCommand /);

  const sh = { command: "echo hi", shell: "bash" };
  wrap(sh);
  assert.equal(sh.command, "'C:/Users/Test/.claude/squeez/bin/squeez.exe' wrap 'echo hi'");

  const wsl = { command: "wsl.exe -- ls", shell: "bash" };
  wrap(wsl);
  assert.equal(wsl.command, "wsl.exe -- ls");

  const skip = { command: "--no-squeez echo hi", shell: "bash" };
  wrap(skip);
  assert.equal(skip.command, "--no-squeez echo hi");
});

test("v2 setup injects the read budget into the mutable input field", async () => {
  const { registered, ctx } = fakeCtx();
  const calls = [];
  createSetup({
    squeezBinary: WIN_BIN,
    platform: "win32",
    env: {},
    exists: () => true,
    runSqueez: async (args) => { calls.push(args.join(" ")); return '{"limit":300}'; },
  })(ctx);
  const before = registered.tool.find(([name]) => name === "execute.before")?.[1];
  assert.ok(before);
  const e = { tool: "read", input: {} };
  await before(e);
  assert.equal(e.input.limit, 300);
  const explicit = { tool: "read", input: { limit: 5 } };
  await before(explicit);
  assert.equal(explicit.input.limit, 5);
  assert.deepEqual(calls, ["budget-params Read"]);
});

test("v2 setup runs init on session.created, tolerant of a numeric suffix", async () => {
  const calls = [];
  const ctx = {
    event: {
      subscribe: () => (async function* () {
        yield { type: "session.created.1" };
      })(),
    },
  };
  createSetup({ exists: () => true, runSqueez: async (args) => { calls.push(args.join(" ")); return ""; } })(ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ["init --host=opencode"]);
});


test("v2 setup runs init once per session on session.execution.started", async () => {
  const calls = [];
  const ctx = {
    event: {
      subscribe: () => (async function* () {
        yield { type: "session.execution.started", data: { sessionID: "s1" } };
        yield { type: "session.execution.started", data: { sessionID: "s1" } };
        yield { type: "session.execution.started", data: { sessionID: "s2" } };
      })(),
    },
  };
  createSetup({ exists: () => true, runSqueez: async (args) => { calls.push(args.join(" ")); return ""; } })(ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ["init --host=opencode", "init --host=opencode"]);
});

test("v2 setup tracks shell completions via shell.exited with a JSON stdin payload", async () => {
  const tracks = [];
  const ctx = {
    event: {
      subscribe: () => (async function* () {
        yield { type: "shell.exited", data: { id: "sh1", status: "exited", exit: 0 } };
        yield { type: "shell.exited.1", data: { id: "sh2", status: "timeout" } };
        yield { type: "shell.exited", data: { id: "sh3", status: "running" } }; // non-terminal
        yield { type: "shell.exited", data: { status: "exited" } }; // missing id
        yield { type: "shell.exited", data: null }; // malformed
        yield { type: "message.updated", data: { id: "sh4", status: "exited" } }; // unrelated
      })(),
    },
  };
  createSetup({
    exists: () => true,
    runSqueez: async () => "",
    trackResult: (tool, bin, payload) => { tracks.push({ tool, payload }); },
  })(ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].tool, "bash");
  assert.deepEqual(tracks[0].payload, { tool_name: "Bash", shell_id: "sh1", shell_status: "exited", exit_code: 0 });
  assert.deepEqual(tracks[1].payload, { tool_name: "Bash", shell_id: "sh2", shell_status: "timeout" });
});

test("v2 execute.after leaves shell to the exit observer and keeps read/grep/glob", async () => {
  const tracks = [];
  const hooks = [];
  const ctx = { tool: { hook: (name, fn) => hooks.push([name, fn]) } };
  createSetup({
    exists: () => true,
    runSqueez: async () => "",
    trackResult: (tool) => { tracks.push(tool); },
  })(ctx);
  const after = hooks.find(([n]) => n === "execute.after")[1];
  after({ tool: "shell" });
  after({ tool: "bash" });
  after({ tool: "read" });
  after({ tool: "grep" });
  after({ tool: "glob" });
  after({ tool: "write" });
  assert.deepEqual(tracks, ["read", "grep", "glob"]);
});

test("trackResult pipes the JSON payload to stdin with EOF", () => {
  const writes = [];
  const seen = [];
  const fakeChild = {
    stdin: { on: () => {}, end: (data) => writes.push(data) },
    on: () => {},
    unref: () => {},
  };
  trackResult("bash", "/fake/squeez.exe", { shell_id: "sh1" }, (bin, args, opts) => {
    seen.push({ bin, args, opts });
    return fakeChild;
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].bin, "/fake/squeez.exe");
  assert.deepEqual(seen[0].args, ["track-result", "bash"]);
  assert.deepEqual(seen[0].opts.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(seen[0].opts.detached, true);
  assert.equal(seen[0].opts.windowsHide, true);
  assert.deepEqual(writes, [JSON.stringify({ shell_id: "sh1" })]);
});

test("trackResult without payload keeps stdio ignored (legacy path unchanged)", () => {
  const seen = [];
  trackResult("read", "/fake/squeez.exe", undefined, (bin, args, opts) => {
    seen.push({ args, opts });
    return { on: () => {}, unref: () => {}, stdin: null };
  });
  assert.deepEqual(seen[0].args, ["track-result", "read"]);
  assert.equal(seen[0].opts.stdio, "ignore");
});

test("trackResult swallows spawn errors and stdin EPIPE", () => {
  assert.doesNotThrow(() => {
    trackResult("bash", "/fake", { a: 1 }, () => { throw new Error("ENOENT"); });
    trackResult("bash", "/fake", { a: 1 }, () => ({
      on: (ev, fn) => { if (ev === "error") fn(new Error("spawn failed")); },
      stdin: { on: (ev, fn) => { if (ev === "error") fn(new Error("EPIPE")); }, end: () => { throw new Error("EPIPE"); } },
      unref: () => {},
    }));
  });
});