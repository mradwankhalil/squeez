// squeez promote pipeline: normal upstream install + a short list of overlays upstream does not ship yet.
//
//   node local-fixes/verify.mjs            read-only health check (N pass / M fail)
//   node local-fixes/apply.mjs             dry-run: what a promotion would do
//   node local-fixes/apply.mjs --apply     squeez update -> setup (safe hosts only) -> re-apply overlays -> verify
//
// Upstream does the install: `squeez update` downloads the release, checks it against the release's
// checksums.sha256, swaps the running squeez.exe by renaming it, and refreshes the Claude Code hooks.
// This pipeline only adds what upstream lacks, each overlay tied to an upstream issue (manifest.json).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PromoteError extends Error { constructor(message) { super(message); this.name = 'PromoteError'; } }
const requireThat = (ok, message) => { if (!ok) throw new PromoteError(message); };
export const root = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(root, '..');
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '');
export const SAFE_SETUP_HOSTS = ['claude-code', 'pi', 'gemini'];

// ---------- pure helpers (unit-tested) ----------

export function parseArgs(args) {
  let mode = null;
  for (const a of args) {
    requireThat(a === '--apply' || a === '--dry-run', 'usage: apply.mjs [--dry-run | --apply]  (squeez update always targets the latest release)');
    requireThat(mode === null, 'choose --apply or --dry-run once');
    mode = a;
  }
  return { apply: mode === '--apply' };
}

export function readSubsystem(bytes) {
  requireThat(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'missing DOS MZ header');
  const pe = bytes.readUInt32LE(60);
  requireThat(pe >= 64 && pe + 24 <= bytes.length && bytes.toString('ascii', pe, pe + 4) === 'PE\0\0', 'missing PE signature');
  const size = bytes.readUInt16LE(pe + 20);
  requireThat(size >= 70 && pe + 24 + size <= bytes.length, 'truncated optional header');
  requireThat([0x10b, 0x20b].includes(bytes.readUInt16LE(pe + 24)), 'unsupported optional-header magic');
  return bytes.readUInt16LE(pe + 24 + 68);
}

// `squeez 1.48.10` -> v1.48.10
export function versionTag(versionOutput) {
  const m = String(versionOutput).match(/(\d+\.\d+\.\d+)/);
  return m ? `v${m[1]}` : null;
}

// checksums.sha256 lines: "<hex>  <asset>" (optionally "*<asset>")
export function findChecksum(text, asset) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === asset) return m[1].toLowerCase();
  }
  return null;
}

// Mirrors squeez's parser (src/config.rs Config::from_str): full-line '#' comments are skipped, the line
// splits at the first '=', and a boolean is on only for the exact value "true" (so `false  # note` is off).
function activeValues(text, key) {
  const values = [];
  let section = '';
  text.split(/\r?\n/).forEach((line, index) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) return;
    if (t.startsWith('[')) { section = t; return; }
    const at = t.indexOf('=');
    if (at > 0 && t.slice(0, at).trim() === key) values.push({ value: t.slice(at + 1).trim(), section, index });
  });
  return values;
}
export function configValue(text, key) {
  const v = activeValues(text, key);
  return v.length === 1 && v[0].section === '' ? v[0].value : null;
}
export function configSatisfies(text, key, expected) {
  const v = configValue(text, key);
  if (v === null) return false;
  if (expected === 'false') return v !== 'true';
  return v.replace(/\s+#.*$/, '') === expected;
}
// A missing config.ini is not neutral: squeez init falls back to Config::default() (init.rs load_config_from),
// whose auto_compress_md is true (config.rs), and compress_md then rewrites ~/.claude/CLAUDE.md on every session
// start. So a host whose trigger exists (the plugin or hook that runs `squeez init` there) must have its file.
export function configPresence(fileExists, trigger, triggerExists) {
  if (fileExists) return 'present';
  return trigger && triggerExists ? 'required-absent' : 'absent';
}
// Set one top-level key; refuses duplicates or a sectioned key rather than guessing.
export function setConfigValue(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const v = activeValues(text, key);
  requireThat(v.length <= 1 && (v.length === 0 || v[0].section === ''), `config key ${key} is duplicated or sectioned; fix by hand`);
  if (v.length === 1) lines[v[0].index] = `${key} = ${value}`;
  else {
    const firstSection = lines.findIndex(l => l.trim().startsWith('['));
    const at = firstSection < 0 ? (lines[lines.length - 1] === '' ? lines.length - 1 : lines.length) : firstSection;
    lines.splice(at, 0, `${key} = ${value}`);
  }
  return lines.join(eol);
}

export function commandEntries(value) {
  if (!value || typeof value !== 'object') return [];
  return [...(value.type === 'command' ? [value] : []), ...Object.values(value).flatMap(commandEntries)];
}
export function codexSqueezHooksAbsent(hooksJsonText) {
  if (hooksJsonText === null) return true;
  try { return !commandEntries(JSON.parse(hooksJsonText)).some(e => /squeez/i.test(String(e.command))); }
  catch { return false; }
}
export function tomlSectionValues(text, header, key) {
  const values = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) { inSection = t === header; continue; }
    if (!inSection || !t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m?.[1] === key) values.push(m[2]);
  }
  return values;
}
export function codexContextModeDisabled(configTomlText) {
  const v = tomlSectionValues(configTomlText, '[plugins."context-mode@context-mode"]', 'enabled');
  return v.length === 1 && v[0] === 'false';
}

// Copilot CLI reads hooks only from settings.hooks.<Event> and ignores unknown top-level keys; squeez 1.48.10
// registers top-level entries with unquoted backslash paths (upstream #243). This puts exactly one squeez
// entry per event under `hooks`, in the command shape squeez uses for Claude Code, and keeps other hooks.
export const COPILOT_SCRIPTS = [
  { event: 'SessionStart', matcher: null, script: 'copilot-session-start.sh' },
  { event: 'PreToolUse', matcher: 'Bash', script: 'copilot-pretooluse.sh' },
  { event: 'PostToolUse', matcher: null, script: 'copilot-posttooluse.sh' },
];
const isSqueezCopilot = entry => commandEntries(entry).some(e => /copilot-(session-start|pretooluse|posttooluse)\.sh/.test(String(e.command)) && /squeez/i.test(String(e.command)));
export function copilotCommand(home, script) {
  return `bash "${home.replace(/\\/g, '/')}/.copilot/squeez/hooks/${script}"`;
}
export function normalizeCopilotSettings(settings, home) {
  const out = structuredClone(settings);
  for (const { event } of COPILOT_SCRIPTS) {
    if (Array.isArray(out[event])) {
      const kept = out[event].filter(g => !isSqueezCopilot(g));
      if (kept.length) out[event] = kept; else delete out[event];
    }
  }
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const { event, matcher, script } of COPILOT_SCRIPTS) {
    const others = (out.hooks[event] ?? []).filter(g => !isSqueezCopilot(g));
    out.hooks[event] = [...others, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: copilotCommand(home, script) }] }];
  }
  return out;
}
export function copilotSettingsOk(settings) {
  if (COPILOT_SCRIPTS.some(({ event }) => Array.isArray(settings[event]) && settings[event].some(isSqueezCopilot))) return false;
  return COPILOT_SCRIPTS.every(({ event, script }) => {
    const cmds = commandEntries(settings.hooks?.[event] ?? []).map(e => String(e.command)).filter(c => c.includes(script));
    return cmds.length === 1 && !cmds[0].includes('\\') && cmds[0].includes(`/.copilot/squeez/hooks/${script}`);
  });
}

export function doctorFailures(output) {
  return String(output).split(/\r?\n/).filter(l => /^\s*\[FAIL\]/.test(l)).map(l => l.trim());
}
export const normalizeEol = bytes => Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n');

// oh-my-openagent runs Claude Code's PreToolUse hooks on OpenCode tool calls and applies their updatedInput
// with `output.args = {...}`. OpenCode executes the original args object, so that result is dropped, and every
// plugin hook that runs afterwards (the squeez plugin) edits the detached copy: nothing gets wrapped. Excluding
// squeez's Claude hook in opencode-cc-plugin.json leaves the args object alone, and the plugin's wrap takes effect.
function parseJsonObject(text) {
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
export function ccPluginDisables(text, event, pattern) {
  const list = text === null ? null : parseJsonObject(text)?.disabledHooks?.[event];
  return Array.isArray(list) && list.includes(pattern);
}
export function withCcPluginDisabled(text, event, pattern) {
  if (ccPluginDisables(text, event, pattern)) return text;
  const cfg = (text === null ? null : parseJsonObject(text)) ?? {};
  const disabled = { ...(cfg.disabledHooks ?? {}) };
  disabled[event] = [...(Array.isArray(disabled[event]) ? disabled[event] : []), pattern];
  return `${JSON.stringify({ ...cfg, disabledHooks: disabled }, null, 2)}\n`;
}
// A server that started before the plugin file was written still runs the previous plugin.
export const staleServers = (procs, pluginMtimeMs) => procs.filter(p => p.startedMs < pluginMtimeMs);

// ---------- context and side-effecting steps ----------

export function loadContext() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  requireThat(manifest.tool === 'squeez' && manifest.upstream?.repo === 'claudioemmanuel/squeez', 'invalid manifest');
  for (const o of manifest.overlays) requireThat(o.id && o.what && Array.isArray(o.upstream) && o.upstream.length && o.retireWhen, `overlay ${o.id ?? '?'} lacks id/what/upstream/retireWhen`);
  return { manifest, home: process.env.USERPROFILE ?? process.env.HOME };
}

export function run(file, args, timeout = 120000) {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}
const git = (args, timeout = 30000) => run('git', ['-C', repoRoot, ...args], timeout);
export function tagTemplate(tag, path) {
  requireThat(TAG.test(tag) && !path.split('/').includes('..'), 'unsafe tag or template');
  const r = git(['show', `${tag}:${path}`]);
  requireThat(r.code === 0, `tag ${tag} missing locally; run: git -C ${repoRoot} fetch origin tag ${tag} --no-tags`);
  return r.out;
}
function officialChecksum(repo, tag, asset) {
  const r = run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'checksums.sha256', '--output', '-'], 60000);
  if (r.code !== 0) return null;
  return findChecksum(r.out, asset);
}
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function backup(path) {
  const b = `${path}.bak-squeez-promote-${stamp()}`;
  copyFileSync(path, b);
  return b;
}
function writeAtomic(path, text) {
  const tmp = `${path}.tmp-squeez-promote`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// A file whose source of truth is the ledger: compared byte for byte, restored with a backup.
export function ledgerFileState(target, source) {
  if (!existsSync(target)) return 'missing';
  return readFileSync(target).equals(readFileSync(source)) ? 'ok' : 'drifted';
}
export function restoreLedgerFile(target, source) {
  const state = ledgerFileState(target, source);
  if (state === 'ok') return null;
  const b = state === 'drifted' ? backup(target) : null;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return b;
}

// Each check: [label, fn] where fn returns true (PASS), false (FAIL), or 'skip:<reason>'.
export function verificationChecks(ctx) {
  const { manifest: m, home } = ctx;
  const bin = m.binary;
  const tag = () => versionTag(run(bin, ['--version'], 20000).out);
  const checks = [
    ['binary exists and is PE subsystem 3 (CONSOLE)', () => existsSync(bin) && readSubsystem(readFileSync(bin)) === 3],
    ['binary SHA-256 equals the official release checksum', () => {
      const t = tag(); if (!t) return false;
      const expected = officialChecksum(m.upstream.repo, t, m.upstream.asset);
      return expected === null ? 'skip:could not fetch checksums.sha256 (offline or gh not authenticated)' : expected === sha256File(bin);
    }],
    ['squeez doctor: no [FAIL] lines', () => { const r = run(bin, ['doctor'], 60000); return doctorFailures(r.out).length === 0 && r.code === 0; }],
    ...m.releaseAssets.map(a => [`${a.target.replace(home.replace(/\\/g, '/'), '~')} equals <installed tag>:${a.template}`,
      () => existsSync(a.target) && normalizeEol(readFileSync(a.target)) === normalizeEol(tagTemplate(tag(), a.template))]),
  ];
  for (const o of m.overlays) {
    if (o.id === 'opencode-plugin') {
      checks.push([`overlay opencode-plugin: installed plugin byte-identical to ${o.source}`, () => existsSync(o.target) && readFileSync(o.target).equals(readFileSync(resolve(repoRoot, o.source)))]);
      checks.push(['overlay opencode-plugin: markers ' + o.markers.join(' | '), () => o.markers.every(k => readFileSync(o.target, 'utf8').includes(k))]);
      if (o.testsSource) checks.push([`overlay opencode-plugin: installed tests byte-identical to ${o.testsSource}`, () => ledgerFileState(o.tests, resolve(repoRoot, o.testsSource)) === 'ok']);
      checks.push(['overlay opencode-plugin: installed plugin tests 18 pass / 0 fail', () => pluginTestsPass(o.tests)]);
    } else if (o.id === 'copilot-hooks') {
      checks.push(['overlay copilot-hooks: squeez hooks under hooks.<Event>, forward-slash paths, no top-level keys', () => !existsSync(o.target) || copilotSettingsOk(JSON.parse(readFileSync(o.target, 'utf8')))]);
    } else if (o.id === 'codex-hooks-off') {
      checks.push(['overlay codex-hooks-off: no squeez command registered in ~/.codex/hooks.json', () => codexSqueezHooksAbsent(existsSync(o.target) ? readFileSync(o.target, 'utf8') : null)]);
      checks.push(['overlay codex-hooks-off: context-mode Codex plugin enabled = false', () => codexContextModeDisabled(readFileSync(o.codexConfig, 'utf8'))]);
    }
  }
  for (const [file, keys] of Object.entries(m.config)) {
    for (const [key, expected] of Object.entries(keys)) {
      const trigger = m.configRequiredWhen?.[file];
      checks.push([`config ${file.replace(home.replace(/\\/g, '/'), '~')}: ${key} = ${expected}`, () => {
        const state = configPresence(existsSync(file), trigger, Boolean(trigger) && existsSync(trigger));
        if (state === 'present') return configSatisfies(readFileSync(file, 'utf8'), key, expected);
        requireThat(state === 'absent', `host config absent while ${trigger} exists; squeez would fall back to its defaults (auto_compress_md = true)`);
        return 'skip:host config absent';
      }]);
    }
  }
  if (m.omoClaudeHooksOff) {
    const x = m.omoClaudeHooksOff;
    checks.push([`omo: Claude ${x.event} hook ${x.pattern} excluded in ${x.file.replace(home.replace(/\\/g, '/'), '~')}`, () => {
      const s = omoExclusionState(x);
      if (s.state === 'present') return true;
      if (s.state === 'not-needed') return 'skip:OpenCode squeez plugin not installed';
      if (s.state === 'pending') return `skip:pending OpenCode restart (${s.detail}); restart it, then rerun apply.mjs --apply`;
      return false;
    }]);
  }
  checks.push([`instruction blocks in sync: ${m.instructionBlocks.join(', ')}`, () => m.instructionBlocks.every(b => {
    const r = run('python', [m.syncBlockTool, b, '--check'], 60000);
    return r.code === 0 && !/DRIFT|MISSING|ABSENT/i.test(r.out) && /IN SYNC/.test(r.out);
  })]);
  return checks;
}

export function pluginTestsPass(testPath) {
  const r = run(process.execPath, ['--test', '--test-reporter=tap', testPath], 120000);
  const n = label => Number(r.out.match(new RegExp(`^# ${label} (\\d+)\\s*$`, 'm'))?.[1]);
  return n('tests') === 18 && n('pass') === 18 && n('fail') === 0 && n('skipped') === 0;
}

export function checkAll(checks, log = console.log) {
  let pass = 0, fail = 0, skip = 0;
  for (const [label, fn] of checks) {
    let result, reason = '';
    try { result = fn(); } catch (e) { result = false; reason = e instanceof PromoteError ? e.message : 'unreadable input (details withheld)'; }
    if (result === true) { pass++; log(`PASS ${label}`); }
    else if (typeof result === 'string' && result.startsWith('skip:')) { skip++; log(`SKIP ${label} (${result.slice(5)})`); }
    else { fail++; log(`FAIL ${label}${reason ? `\n     ${reason}` : ''}`); }
  }
  log(`${pass} pass / ${fail} fail${skip ? ` / ${skip} skip` : ''}`);
  return { pass, fail, skip };
}

// Re-apply one overlay if (and only if) it drifted. Returns a log line.
export function reapplyOverlay(o, ctx) {
  const { home } = ctx;
  if (o.id === 'opencode-plugin') {
    const source = readFileSync(resolve(repoRoot, o.source));
    // The plugin's tests are installed outside this repo; the ledger copy is their source of truth too.
    const testsSource = o.testsSource ? resolve(repoRoot, o.testsSource) : null;
    const testsDrifted = testsSource !== null && ledgerFileState(o.tests, testsSource) !== 'ok';
    const tb = testsDrifted ? restoreLedgerFile(o.tests, testsSource) : null;
    const testsNote = testsDrifted ? `; its tests restored from the ledger (backup ${tb ?? 'none'})` : '';
    if (existsSync(o.target) && readFileSync(o.target).equals(source)) return `PASS opencode-plugin already the owner plugin${testsNote}`;
    const b = existsSync(o.target) ? backup(o.target) : null;
    writeFileSync(o.target, source);
    if (!pluginTestsPass(o.tests)) {
      if (b) copyFileSync(b, o.target);
      throw new PromoteError(`opencode-plugin tests failed after re-apply; previous plugin restored from ${b}`);
    }
    return `PASS opencode-plugin re-applied (backup ${b ?? 'none'})${testsNote}`;
  }
  if (o.id === 'copilot-hooks') {
    if (!existsSync(o.target)) return 'PASS copilot-hooks: Copilot not installed';
    const settings = JSON.parse(readFileSync(o.target, 'utf8'));
    if (copilotSettingsOk(settings)) return 'PASS copilot-hooks already registered where Copilot reads them';
    const b = backup(o.target);
    writeAtomic(o.target, `${JSON.stringify(normalizeCopilotSettings(settings, home), null, 2)}\n`);
    return `PASS copilot-hooks re-applied (backup ${b})`;
  }
  if (o.id === 'codex-hooks-off') {
    const text = existsSync(o.target) ? readFileSync(o.target, 'utf8') : null;
    if (codexSqueezHooksAbsent(text)) return 'PASS codex-hooks-off: no squeez hook registered';
    const moved = `${o.target}.bak-squeez-promote-${stamp()}`;
    renameSync(o.target, moved);
    return `PASS codex-hooks-off re-applied (hooks.json moved to ${moved}; re-enable registry is hooks.json.disabled-test)`;
  }
  throw new PromoteError(`unknown overlay ${o.id}`);
}

export function reapplyConfig(ctx) {
  const lines = [];
  for (const [file, keys] of Object.entries(ctx.manifest.config)) {
    const trigger = ctx.manifest.configRequiredWhen?.[file];
    const state = configPresence(existsSync(file), trigger, Boolean(trigger) && existsSync(trigger));
    if (state === 'absent') continue;
    if (state === 'required-absent') {
      let text = '# squeez configuration: created by local-fixes/apply.mjs (manifest.configRequiredWhen); every other key uses the squeez default\n';
      for (const [k, v] of Object.entries(keys)) text = setConfigValue(text, k, v);
      mkdirSync(dirname(file), { recursive: true });
      writeAtomic(file, text);
      lines.push(`PASS config ${file}: created with ${Object.entries(keys).map(([k, v]) => `${k} = ${v}`).join(', ')} (absent while ${trigger} exists)`);
      continue;
    }
    let text = readFileSync(file, 'utf8');
    const drift = Object.entries(keys).filter(([k, v]) => !configSatisfies(text, k, v));
    if (!drift.length) continue;
    const b = backup(file);
    for (const [k, v] of drift) text = setConfigValue(text, k, v);
    writeAtomic(file, text);
    lines.push(`PASS config ${file}: set ${drift.map(([k, v]) => `${k} = ${v}`).join(', ')} (backup ${b})`);
  }
  return lines;
}

function opencodeServers() {
  const script = "$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'opencode*' } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const r = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 60000);
  if (r.code !== 0) return null;
  return [...r.out.matchAll(/^(\d+)\|([^|\r\n]+)\|(\d+)\s*$/gm)]
    .map(([, pid, name, startedMs]) => ({ pid: Number(pid), name, startedMs: Number(startedMs) }))
    .filter(p => p.name.toLowerCase() !== 'opencode-shell.exe');
}

export function omoExclusionState(x) {
  const text = existsSync(x.file) ? readFileSync(x.file, 'utf8') : null;
  if (ccPluginDisables(text, x.event, x.pattern)) return { state: 'present' };
  if (!existsSync(x.plugin)) return { state: 'not-needed' };
  const servers = opencodeServers();
  if (servers === null) return { state: 'pending', detail: 'could not list OpenCode processes' };
  const stale = staleServers(servers, statSync(x.plugin).mtimeMs);
  if (stale.length) return { state: 'pending', detail: `${stale.map(p => `${p.name} pid ${p.pid}`).join(', ')} started before the plugin was written` };
  return { state: 'absent' };
}

// Written only when no running OpenCode server predates the installed plugin: under a server that still runs an
// older plugin, the exclusion makes that plugin's wrapper effective for every command.
export function reapplyOmoExclusion(ctx) {
  const x = ctx.manifest.omoClaudeHooksOff;
  if (!x) return [];
  const s = omoExclusionState(x);
  if (s.state === 'present' || s.state === 'not-needed') return [];
  if (s.state === 'pending') return [`DEFER omo exclusion: ${s.detail}; restart OpenCode, then rerun apply.mjs --apply`];
  const text = existsSync(x.file) ? readFileSync(x.file, 'utf8') : null;
  requireThat(text === null || parseJsonObject(text) !== null, `${x.file} is not a JSON object; fix it by hand, nothing was written`);
  const b = text === null ? null : backup(x.file);
  mkdirSync(dirname(x.file), { recursive: true });
  writeAtomic(x.file, withCcPluginDisabled(text, x.event, x.pattern));
  return [`PASS omo exclusion: ${x.event} ${x.pattern} added to ${x.file} (backup ${b ?? 'none'})`];
}

export const ensureTag = tag => git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]).code === 0 || git(['fetch', 'origin', 'tag', tag, '--no-tags'], 60000).code === 0;
export { requireThat, TAG };
