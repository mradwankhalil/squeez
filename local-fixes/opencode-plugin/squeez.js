// squeez OpenCode plugin — full-parity integration, dual-host export.
//
// v1 (OpenCode 1.x): `server(input, options)` returns a map of hook-name →
//   handler. The return value MUST be an object — a bare return (or
//   `return undefined`) crashes OpenCode on internal property access (see
//   squeez issue #69, opencode 1.4.11 + @opencode-ai/plugin 1.4.10).
//
// v2 (OpenCode 2.x, verified against the v2.0.18 plugin adapter and the
//   2.0.21 host): `setup(ctx)` registers hooks on ctx domains. Contracts:
//   - ctx.shell.hook("create.before", cb) — cb receives a MUTABLE
//     { command, cwd, timeout, shell, env }; the core reads
//     invocation.command after trigger, so in-place mutation is the
//     contract. `shell` names the shell that will parse the command — the
//     wrapper form follows it (see the shell-family note below).
//   - ctx.tool.hook("execute.before"|"execute.after", cb) — mutable `input`
//     field. v2 renamed the bash tool to "shell"; it is mapped back to
//     "bash" for squeez track-result.
//   - ctx.event.subscribe() returns an AsyncIterable of host events. Event
//     names may carry a numeric suffix on some hosts (session.created.1),
//     so the match is suffix-tolerant.
//   A missing domain simply disables that hook (optional chaining).
//   The v2 config-dir drop loader accepts { id, setup, server } and prefers
//   setup when present.
//
// Handlers (both hosts):
//   - session.created → finalize previous session and refresh AGENTS.md via
//     `squeez init --host=opencode`.
//   - bash/shell before-exec → rewrite command to `squeez wrap <cmd>`.
//   - read/grep before-exec → inject budget limits so Read and Grep respect
//     the squeez config.
//   - after-exec (any known tool) → fire-and-forget `squeez track-result`.
//
// Every child below passes `windowsHide: true`. On Windows a child without
// it gets its own console, so each tool call flashed a console window
// (squeez issue #231).
//
// No synchronous child processes. Inside the OpenCode server the first
// execSync of a hook call fails at once with a false ETIMEDOUT (measured:
// 10 ms into a 3000 ms timeout; the same call succeeds when repeated). That
// silently dropped the read/grep budget, and at load it could have dropped
// every hook. So: the installed check is a file test, and squeez is run
// with async execFile, no shell, one retry (squeez issue #245, PR #246).
//
// WSL supervisor (squeez incident X-80 / issue #239): `squeez wrap` prints
// its timeout notice but does not terminate the child tree, and a live WSL
// grandchild keeps the pipe open so the call never settles. For commands
// that invoke wsl.exe only, the wrapper is replaced by a bounded supervisor
// that waits `wrap_timeout_secs`, then runs `taskkill /F /T /PID` and exits
// 124. Every other command is wrapped byte-identically to before.
//
// Shell family (squeez issue #244): `squeez wrap` runs its argument in
// bash, and the wrapper itself is parsed by whichever shell OpenCode's
// shell tool uses. So the form follows the resolved shell, not the OS.
// PowerShell shells get `& '<squeez>' wrap 'powershell.exe -EncodedCommand
// …'`; POSIX shells (Git Bash on Windows included) get `'<squeez>' wrap
// '<cmd>'`. Emitting the PowerShell form into bash fails every call with
// `syntax error near unexpected token '&'`. Under bash, wsl.exe commands
// are left unwrapped: the supervisor is PowerShell-only, and the host's own
// timeout kills the process tree. On v1 the shell comes from the config
// hook (the OpenCode `shell` key); on v2 each create.before event carries
// it as `e.shell`.

import { execFile, spawn } from "child_process";
import { existsSync } from "fs";

const HOME = process.env.HOME || process.env.USERPROFILE || "";

// ── helpers (exported for tests/squeez-plugin.test.mjs) ──────────────────

export function resolveSqueezBinary({ platform = process.platform, home = HOME } = {}) {
  if (platform === "win32") {
    return `${home}\\.claude\\squeez\\bin\\squeez.exe`;
  }
  return `${home}/.claude/squeez/bin/squeez`;
}

export function shouldWrapTool(tool) {
  return tool === "shell" || tool === "bash";
}

const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const POWERSHELL_SHELLS = new Set(["powershell", "pwsh", "opencode-shell"]);

// Mirrors OpenCode's choice: the `shell` config key (v1) or the event's
// `shell` field (v2), else $SHELL, else the platform default (PowerShell on
// Windows).
export function resolveShellFamily({
  configShell,
  env = process.env,
  platform = process.platform,
} = {}) {
  const shell = configShell || env.SHELL || "";
  const name = String(shell).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  if (POSIX_SHELLS.has(name)) return "posix";
  if (POWERSHELL_SHELLS.has(name)) return "powershell";
  return platform === "win32" ? "powershell" : "posix";
}

export function isAlreadyWrapped(command) {
  if (typeof command !== "string") return false;
  if (command.includes("squeez wrap")) return true;
  return /^\s*(?:&\s*)?(?:'[^']*squeez(?:\.exe)?'|"[^"]*squeez(?:\.exe)?"|\S*squeez(?:\.exe)?)\s+wrap\s/i.test(command);
}

export function resolveWrapTimeoutSecs(env = process.env) {
  const raw = env.SQUEEZ_WRAP_TIMEOUT_SECS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 360;
  return n;
}

export function isWslCommand(command) {
  if (typeof command !== "string") return false;
  return /^wsl(\.exe)?\b/i.test(command.trim());
}

export function detectWslDistro(command) {
  if (typeof command !== "string") return null;
  const m = command.match(/(?:-d|--distribution)(?:=|\s+)(\S+)/);
  return m ? m[1] : null;
}

function encodePowerShell(text) {
  return Buffer.from(text, "utf16le").toString("base64");
}

export function buildWslSupervisorScript({
  innerCommandB64,
  timeoutMs,
  timeoutSecs,
  distro,
  terminateDistro = false,
}) {
  const lines = [
    `$inner='${innerCommandB64}'`,
    `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `$psi.FileName = 'powershell.exe'`,
    `$psi.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $inner`,
    `$psi.UseShellExecute=$false`,
    `$p = [System.Diagnostics.Process]::Start($psi)`,
    `if (-not $p.WaitForExit(${timeoutMs})) {`,
    `  taskkill /F /T /PID $p.Id *> $null`,
    `  [Console]::Error.WriteLine('squeez: command timed out after ${timeoutSecs}s; process tree terminated')`,
  ];
  if (terminateDistro && distro) {
    lines.push(`  wsl.exe --terminate ${distro} *> $null`);
  }
  lines.push(`  exit 124`);
  lines.push(`}`);
  lines.push(`exit $p.ExitCode`);
  return lines.join("\n");
}

export function buildWrappedCommand(command, {
  platform = process.platform,
  squeezBinary = resolveSqueezBinary({ platform }),
  env = process.env,
  shellFamily = platform === "win32" ? "powershell" : "posix",
} = {}) {
  if (platform !== "win32" || shellFamily === "posix") {
    const quoted = "'" + String(command).replace(/'/g, "'\\''") + "'";
    if (platform !== "win32") return `${squeezBinary} wrap ${quoted}`;
    if (isWslCommand(command)) return command;
    // Forward slashes and quotes: bash would eat the backslashes otherwise.
    return `'${squeezBinary.replace(/\\/g, "/")}' wrap ${quoted}`;
  }

  const timeoutSecs = resolveWrapTimeoutSecs(env);
  const timeoutMs = timeoutSecs * 1000;

  let innerScript;
  if (isWslCommand(command)) {
    innerScript = buildWslSupervisorScript({
      innerCommandB64: encodePowerShell(command),
      timeoutMs,
      timeoutSecs,
      distro: detectWslDistro(command),
    });
  } else {
    innerScript = command;
  }

  const encoded = encodePowerShell(innerScript);
  const psCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  return `& '${squeezBinary}' wrap '${psCommand}'`;
}

// ── plugin internals ────────────────────────────────────────────────────

const SQUEEZ_BIN = resolveSqueezBinary();

// Map OpenCode's lowercase tool names to the capitalized slugs the squeez
// budget-params subcommand expects (Read / Grep).
const BUDGET_TOOL_SLUG = {
  read: "Read",
  grep: "Grep",
};

export function squeezInstalled(binary = SQUEEZ_BIN, exists = existsSync) {
  try {
    return exists(binary) === true;
  } catch {
    return false;
  }
}

function runSqueezAsync(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      SQUEEZ_BIN,
      args,
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

// runSqueezAsync wraps the module-level binary; for tests and the v2 setup
// path the runner is injectable.
function makeRunner(squeezBinary) {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        squeezBinary,
        args,
        { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
      );
    });
}

export function trackResult(tool, squeezBinary = SQUEEZ_BIN, payload, spawnImpl = spawn) {
  // Fire-and-forget — don't block the tool pipeline. The observer reads
  // stdin to completion and no-ops on an empty payload, so tracking without a
  // payload stays a silent no-op (legacy callers unchanged); a payload must be
  // piped and EOF'd for the observer to record anything.
  try {
    const json = payload === undefined ? undefined : JSON.stringify(payload);
    const child = spawnImpl(squeezBinary, ["track-result", tool], {
      stdio: json === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {});
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(json);
    }
    child.unref();
  } catch {
    // best-effort
  }
}

// The budget comes from squeez's config, which rarely changes: ask once per
// tool and keep the answer for a minute. A failure is not kept. Shared by
// the v1 hook map and the v2 setup path.
export function createBudgetPatcher({ runSqueez = runSqueezAsync, budgetTtlMs = 60000 } = {}) {
  const budgetCache = new Map();
  return async function budgetPatch(tool) {
    const slug = BUDGET_TOOL_SLUG[tool];
    if (!slug) return null;
    const hit = budgetCache.get(slug);
    if (hit && Date.now() - hit.at < budgetTtlMs) return hit.patch;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = (await runSqueez(["budget-params", slug], 2000)).trim();
        const patch = out ? JSON.parse(out) : null;
        budgetCache.set(slug, { at: Date.now(), patch });
        return patch;
      } catch {
        // try once more, then leave the call untouched
      }
    }
    return null;
  };
}

export function createHooks({
  squeezBinary = SQUEEZ_BIN,
  platform = process.platform,
  env = process.env,
  runSqueez = runSqueezAsync,
  budgetTtlMs = 60000,
} = {}) {
  let shellFamily = resolveShellFamily({ env, platform });
  const budgetPatch = createBudgetPatcher({ runSqueez, budgetTtlMs });

  return {
    // OpenCode hands every plugin the resolved config once at load.
    config: async (cfg) => {
      shellFamily = resolveShellFamily({ configShell: cfg && cfg.shell, env, platform });
    },

    event: async ({ event }) => {
      if (event && event.type === "session.created") {
        // best-effort and not awaited: don't hold the session up if init fails
        runSqueez(["init", "--host=opencode"], 5000).catch(() => {});
      }
    },

    "tool.execute.before": async (input, output) => {
      if (!input || !output || !output.args) return;

      if (shouldWrapTool(input.tool)) {
        const command = output.args.command;
        if (!command || typeof command !== "string") return;
        if (command.startsWith(squeezBinary)) return;
        if (isAlreadyWrapped(command)) return;
        if (command.startsWith("--no-squeez")) return;
        output.args.command = buildWrappedCommand(command, {
          platform,
          squeezBinary,
          env,
          shellFamily,
        });
        return;
      }

      const patch = await budgetPatch(input.tool);
      if (!patch) return;
      for (const [k, v] of Object.entries(patch)) {
        // Do not override fields the user (or agent) already set explicitly.
        if (output.args[k] === undefined) {
          output.args[k] = v;
        }
      }
    },

    "tool.execute.after": async (input) => {
      if (!input || !input.tool) return;
      // Only track tools we know about — keeps the noise down.
      if (["bash", "shell", "read", "grep", "glob"].includes(input.tool)) {
        trackResult(input.tool, squeezBinary);
      }
    },
  };
}

// v2 setup factory — injectable for tests. Registers on whichever ctx
// domains the host provides; a missing domain disables that hook.
export function createSetup({
  squeezBinary = SQUEEZ_BIN,
  platform = process.platform,
  env = process.env,
  runSqueez,
  trackResult: track = trackResult,
  exists = existsSync,
} = {}) {
  const run = runSqueez || makeRunner(squeezBinary);
  return function setup(ctx) {
    if (!ctx) return;
    // Returning nothing (not even a cleanup) keeps the v2 loader happy when
    // squeez isn't on the machine. Hooks are simply absent.
    if (!squeezInstalled(squeezBinary, exists)) return;

    // session.created (v1) / session.execution.started (v2) → squeez init.
    // The event bus is an AsyncIterable; event names may carry a numeric
    // suffix on some hosts. v2 renamed the event and fires it once per
    // execution (per turn), so dedupe per session — init is once-per-session
    // work. Without this alias the v2 host never initializes squeez, which
    // also leaves track-result with no live session state.
    if (ctx.event && typeof ctx.event.subscribe === "function") {
      const initializedSessions = new Set();
      (async () => {
        try {
          for await (const event of ctx.event.subscribe()) {
            if (!event) continue;
            const type = String(event.type);
            if (/^session\.created(\.\d+)?$/.test(type)) {
              run(["init", "--host=opencode"], 5000).catch(() => {});
            } else if (/^session\.execution\.started(\.\d+)?$/.test(type)) {
              const sid = (event.data && event.data.sessionID) || "";
              if (initializedSessions.has(sid)) continue;
              initializedSessions.add(sid);
              run(["init", "--host=opencode"], 5000).catch(() => {});
            } else if (/^shell\.exited(\.\d+)?$/.test(type)) {
              // v2 shell is its own domain/aggregate: it never reaches
              // ctx.tool hooks, so completions are observed on the bus.
              // Payload has {id, exit?, status} only — do not invent fields.
              const data = event.data;
              if (!data || typeof data.id !== "string") continue;
              if (!["exited", "timeout", "killed"].includes(data.status)) continue;
              track("bash", squeezBinary, {
                tool_name: "Bash", shell_id: data.id, shell_status: data.status,
                ...(typeof data.exit === "number" ? { exit_code: data.exit } : {}),
              });
            }
          }
        } catch {
          // event stream closed or host shutting down — harmless
        }
      })();
    }

    // bash (v2: shell) → wrap command. Same guards as the v1 handler. The
    // event carries the resolved shell, so the wrapper follows it per call.
    if (ctx.shell && typeof ctx.shell.hook === "function") {
      ctx.shell.hook("create.before", (e) => {
        if (!e || typeof e.command !== "string") return;
        const command = e.command;
        if (!command) return;
        if (command.startsWith(squeezBinary)) return;
        if (isAlreadyWrapped(command)) return;
        if (command.startsWith("--no-squeez")) return;
        e.command = buildWrappedCommand(command, {
          platform,
          squeezBinary,
          env,
          shellFamily: resolveShellFamily({ configShell: e.shell, env, platform }),
        });
      });
    }

    if (ctx.tool && typeof ctx.tool.hook === "function") {
      const budgetPatch = createBudgetPatcher({ runSqueez: run });

      // read/grep budget injection — v2's mutable field is `input`.
      ctx.tool.hook("execute.before", async (e) => {
        if (!e || typeof e.tool !== "string") return;
        const patch = await budgetPatch(e.tool);
        if (!patch) return;
        const input = e.input;
        if (!input || typeof input !== "object") return;
        for (const [k, v] of Object.entries(patch)) {
          // Do not override fields the user (or agent) already set explicitly.
          if (input[k] === undefined) {
            input[k] = v;
          }
        }
      });

      // Post-execution tracking — read/grep/glob only. Shell completions are
      // owned by the shell.exited bus branch above: shell is its own domain on
      // v2 and never reaches tool hooks, so keeping bash here could double-count.
      ctx.tool.hook("execute.after", (e) => {
        if (!e || !e.tool) return;
        if (["read", "grep", "glob"].includes(e.tool)) {
          track(e.tool, squeezBinary);
        }
      });
    }
  };
}

export default {
  id: "squeez",

  // OpenCode 2.x entry point. v1 ignores this key (its PluginModule type is
  // { id?, server, tui? }); v2's config-dir drop loader prefers setup().
  setup: createSetup(),

  // OpenCode 1.x entry point.
  server: async (_input, _options) => {
    // Returning `{}` (not `undefined`) keeps the plugin loader happy when
    // squeez isn't on the machine. Hooks are simply absent so OpenCode runs
    // as if the plugin were not installed.
    if (!squeezInstalled()) return {};

    return createHooks();
  },
};
