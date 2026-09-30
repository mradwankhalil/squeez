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
// Every child below passes `windowsHide: true`. On Windows, execSync goes
// through cmd.exe and a detached spawn gets its own console, so without it
// each tool call flashed a console window (squeez issue #231).
//
// WSL supervisor (squeez incident X-80): `squeez wrap` prints its timeout
// notice but does not terminate the child tree, and a live WSL grandchild
// keeps the pipe open so the call never settles. For commands that invoke
// wsl.exe only, the wrapper is replaced by a bounded supervisor that waits
// `wrap_timeout_secs`, then runs `taskkill /F /T /PID` and exits 124. Every
// other command is wrapped byte-identically to before.

import { execSync, spawn } from "child_process";

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
} = {}) {
  if (platform !== "win32") {
    const quoted = "'" + String(command).replace(/'/g, "'\\''") + "'";
    return `${squeezBinary} wrap ${quoted}`;
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

function squeezExists() {
  try {
    execSync(`test -x "${SQUEEZ_BIN}"`, { timeout: 500, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function runInit() {
  try {
    execSync(`"${SQUEEZ_BIN}" init --host=opencode`, { timeout: 5000, windowsHide: true });
  } catch {
    // best-effort — don't break the session if squeez init fails
  }
}

function budgetPatch(tool) {
  const slug = BUDGET_TOOL_SLUG[tool];
  if (!slug) return null;
  try {
    const out = execSync(`"${SQUEEZ_BIN}" budget-params ${slug}`, {
      timeout: 2000,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
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

export default {
  id: "squeez",
  server: async (_input, _options) => {
    // Returning `{}` (not `undefined`) keeps the plugin loader happy when
    // squeez isn't on the machine. Hooks are simply absent so OpenCode runs
    // as if the plugin were not installed.
    if (!squeezExists()) return {};

    return {
      event: async ({ event }) => {
        if (event && event.type === "session.created") {
          runInit();
        }
      },

      "tool.execute.before": async (input, output) => {
        if (!input || !output || !output.args) return;

        if (shouldWrapTool(input.tool)) {
          const command = output.args.command;
          if (!command || typeof command !== "string") return;
          if (command.startsWith(SQUEEZ_BIN)) return;
          if (command.includes("squeez wrap")) return;
          if (command.startsWith("--no-squeez")) return;
          output.args.command = buildWrappedCommand(command, {
            squeezBinary: SQUEEZ_BIN,
          });
          return;
        }

        const patch = budgetPatch(input.tool);
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
  },
};
