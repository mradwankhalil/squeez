// squeez OpenCode plugin — full-parity integration.
//
// Conforms to the @opencode-ai/plugin SDK `PluginModule` contract: a default
// export object with `id` + async `server(input, options)` that returns a map
// of hook-name → handler. The server return value MUST be an object — a bare
// return (or `return undefined`) causes OpenCode to crash on internal
// property access (see squeez issue #69, reproduced on opencode 1.4.11 +
// @opencode-ai/plugin 1.4.10).
//
// Handlers:
//   - event (session.created) → finalize previous session and refresh
//     AGENTS.md via `squeez init --host=opencode`.
//   - tool.execute.before (bash/shell) → rewrite command to `squeez wrap <cmd>`.
//   - tool.execute.before (read/grep) → inject budget limits so Read and
//     Grep respect the squeez config.
//   - tool.execute.after (any known tool) → fire-and-forget
//     `squeez track-result` for post-execution context tracking.
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
// with async execFile, no shell, one retry.
//
// WSL supervisor (squeez incident X-80): `squeez wrap` prints its timeout
// notice but does not terminate the child tree, and a live WSL grandchild
// keeps the pipe open so the call never settles. For commands that invoke
// wsl.exe only, the wrapper is replaced by a bounded supervisor that waits
// `wrap_timeout_secs`, then runs `taskkill /F /T /PID` and exits 124. Every
// other command is wrapped byte-identically to before.
//
// Shell family: `squeez wrap` runs its argument in bash, and the wrapper
// itself is parsed by whichever shell OpenCode's shell tool uses. So the
// form follows the configured shell, not the OS. PowerShell shells get
// `& '<squeez>' wrap 'powershell.exe -EncodedCommand …'`; POSIX shells
// (Git Bash on Windows included) get `'<squeez>' wrap '<cmd>'`. Emitting
// the PowerShell form into bash fails every call with `syntax error near
// unexpected token '&'`. Under bash, wsl.exe commands are left unwrapped:
// the supervisor is PowerShell-only, and the host's own timeout kills the
// process tree.

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

// Mirrors OpenCode's choice: the `shell` config key, else $SHELL, else the
// platform default (PowerShell on Windows).
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

function trackResult(tool) {
  // Fire-and-forget — don't block the tool pipeline.
  try {
    spawn(SQUEEZ_BIN, ["track-result", tool], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    }).unref();
  } catch {
    // best-effort
  }
}

export function createHooks({
  squeezBinary = SQUEEZ_BIN,
  platform = process.platform,
  env = process.env,
  runSqueez = runSqueezAsync,
  budgetTtlMs = 60000,
} = {}) {
  let shellFamily = resolveShellFamily({ env, platform });

  // The budget comes from squeez's config, which rarely changes: ask once
  // per tool and keep the answer for a minute. A failure is not kept.
  const budgetCache = new Map();
  async function budgetPatch(tool) {
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
  }

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
        trackResult(input.tool);
      }
    },
  };
}

export default {
  id: "squeez",
  server: async (_input, _options) => {
    // Returning `{}` (not `undefined`) keeps the plugin loader happy when
    // squeez isn't on the machine. Hooks are simply absent so OpenCode runs
    // as if the plugin were not installed.
    if (!squeezInstalled()) return {};

    return createHooks();
  },
};
