import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PromoteError extends Error {
  constructor(message) { super(message); this.name = 'PromoteError'; }
}
function requireThat(ok, message) { if (!ok) throw new PromoteError(message); }
export const root = dirname(fileURLToPath(import.meta.url));
const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = sha256;
const stampNow = () => new Date().toISOString().replace(/[-:.]/g, '');

export function parseArgs(args) {
  let mode = null;
  let version = null;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--apply': case '--dry-run':
        requireThat(mode === null, 'choose --apply or --dry-run once');
        mode = args[i];
        break;
      case '--version':
        requireThat(version === null && tagPattern.test(args[i + 1] ?? ''), '--version requires one plain vX.Y.Z tag');
        version = args[++i];
        break;
      default: throw new PromoteError('unknown argument; use [--dry-run | --apply] [--version vX.Y.Z]');
    }
  }
  return { apply: mode === '--apply', version };
}

export function readSubsystem(bytes) {
  requireThat(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'missing DOS MZ header');
  const pe = bytes.readUInt32LE(60);
  requireThat(pe >= 64 && pe + 24 <= bytes.length, 'PE header outside file');
  requireThat(bytes.toString('ascii', pe, pe + 4) === 'PE\0\0', 'missing PE signature');
  const optional = pe + 24;
  const size = bytes.readUInt16LE(pe + 20);
  requireThat(size >= 70 && optional + size <= bytes.length, 'truncated optional header');
  requireThat([0x10b, 0x20b].includes(bytes.readUInt16LE(optional)), 'unsupported optional-header magic');
  return bytes.readUInt16LE(optional + 68);
}
export function requireConsole(bytes, expected) {
  requireThat(expected === 3 && readSubsystem(bytes) === expected, 'PE subsystem must equal 3 (CONSOLE)');
}

export function commandEntries(value) {
  if (!value || typeof value !== 'object') return [];
  return [...(value.type === 'command' ? [value] : []), ...Object.values(value).flatMap(commandEntries)];
}
export function invokesHook(command, expected) {
  if (typeof command !== 'string') return false;
  // Accept direct bash invocations, not echoed filenames, comments or shell chains.
  const tokens = command.trim().match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const unquote = s => s.replace(/^(["'])(.*)\1$/, '$2').replace(/\\/g, '/');
  const parts = tokens.map(unquote);
  if (parts[0] === '&') parts.shift();
  if (parts.length !== 2 || !/(?:^|\/)bash(?:\.exe)?$/i.test(parts[0])) return false;
  const home = 'C:/Users/Zephyrus';
  const path = parts[1].replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=\/)/, home).replace(/^\/c\//i, 'C:/');
  return path.toLowerCase() === expected.replace(/\\/g, '/').toLowerCase();
}
export function postCompactOkay(settings, owner) {
  const groups = settings.hooks?.PostCompact;
  const commands = commandEntries(groups);
  return Array.isArray(groups) && groups.length === 1 && Array.isArray(groups[0]?.hooks)
    && groups[0].hooks.length === 1 && commands.length === 1 && invokesHook(commands[0].command, owner)
    && !commandEntries(settings.hooks).some(entry => /squeez\/hooks\/postcompact\.sh/i.test(String(entry.command).replace(/\\/g, '/')));
}
export function codexOwnership(settings, expected) {
  return commandEntries(settings).length === 3 && Object.entries(expected).every(([event, path]) => {
    const entries = commandEntries(settings.hooks?.[event]);
    return entries.length === 1 && invokesHook(entries[0].command, path);
  });
}
// Owner decision (X-74 2026-09-19, X-119 2026-09-30): no squeez command may be registered with Codex on
// Windows until a stable Codex ships openai/codex#49164. An absent hooks.json is the canonical state;
// unrelated non-squeez hooks are tolerated rather than counted.
export function codexSqueezHooksAbsent(hooksJsonText) {
  if (hooksJsonText === null) return true;
  let parsed;
  try { parsed = JSON.parse(hooksJsonText); } catch { return false; }
  return !commandEntries(parsed).some(entry => /squeez/i.test(String(entry.command)));
}
export function tomlSectionValues(text, header, key) {
  const values = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) { inSection = trimmed === header; continue; }
    if (!inSection || !trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (match?.[1] === key) values.push(match[2]);
  }
  return values;
}
export function codexContextModeDisabled(configTomlText) {
  const values = tomlSectionValues(configTomlText, '[plugins."context-mode@context-mode"]', 'enabled');
  return values.length === 1 && values[0] === 'false';
}
export function configEquals(text, key, expected) {
  const values = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    if (trimmed.startsWith('[')) { section = trimmed; continue; }
    const match = trimmed.match(/^([^=\s]+)\s*=\s*(.*?)\s*$/);
    if (match?.[1] === key) values.push({ value: match[2], section });
  }
  return values.length === 1 && values[0].section === '' && values[0].value === expected;
}
// Mirrors squeez's own parser (src/config.rs Config::from_str): full-line '#' comments are skipped, the
// line splits at the first '=', and a boolean is on only for the exact value "true". An inline comment
// after `false` is therefore still off, so a raw string comparison would report a false alarm.
export function configBoolOff(text, key) {
  const values = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) { section = trimmed; continue; }
    const at = trimmed.indexOf('=');
    if (at > 0 && trimmed.slice(0, at).trim() === key) values.push({ value: trimmed.slice(at + 1).trim(), section });
  }
  return values.length === 1 && values[0].section === '' && values[0].value !== 'true';
}
export const normalizeEol = bytes => Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n');
export function assetMatchesTemplate(installed, template) { return normalizeEol(installed) === normalizeEol(template); }
// Keep the installed file's line-ending style so an asset refresh changes content, not EOL noise.
export function withEolOf(existingText, template) {
  const text = normalizeEol(template);
  return Buffer.from(existingText?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new PromoteError(`cannot read valid JSON: ${path}`); }
}
const readIfPresent = path => (existsSync(path) ? readFileSync(path, 'utf8') : null);
export function loadContext() {
  const manifest = readJson(join(root, 'manifest.json'));
  const policy = readJson(join(root, 'policy.json'));
  const installed = readJson(join(root, 'installed.json'));
  requireThat(manifest.tool === 'squeez' && manifest.subsystemMustEqual === 3, 'invalid squeez manifest');
  requireThat(manifest.upstream.repo === 'claudioemmanuel/squeez', 'unexpected upstream repository');
  requireThat(tagPattern.test(installed.tag ?? '') && /^[a-f0-9]{64}$/.test(installed.sha256 ?? ''), 'installed.json needs a plain tag and a SHA-256');
  requireThat(['off', 'owner'].includes(policy.codex?.hooksMode), 'policy.codex.hooksMode must be off or owner');
  const ids = new Set();
  for (const fix of manifest.localFixes) {
    for (const field of ['id', 'what', 'targetPath', 'sourceOfTruth', 'marker', 'verify', 'upstreamStatus']) {
      requireThat(typeof fix[field] === 'string' && fix[field].length > 0, `invalid manifest field ${field}`);
    }
    requireThat(!ids.has(fix.id), 'duplicate fix id'); ids.add(fix.id);
    requireThat(['plugin', 'hook', 'registration', 'config', 'binary-property', 'release-asset'].includes(fix.kind), 'invalid fix kind');
    requireThat(typeof fix.reapplyAfterUpdate === 'boolean' && Array.isArray(fix.clobberedBy), 'invalid fix policy');
    requireThat(fix.sourceOfTruth.startsWith('local-fixes/') && !fix.sourceOfTruth.split('/').includes('..'), 'source of truth must be inside local-fixes');
    requireThat(existsSync(resolve(root, '..', fix.sourceOfTruth)), `missing source of truth: ${fix.id}`);
  }
  const fix = id => {
    const found = manifest.localFixes.find(item => item.id === id);
    requireThat(found, `missing manifest fix ${id}`);
    return found;
  };
  return { root, repoRoot: resolve(root, '..'), manifest, policy, installed, fix };
}

export class Budget {
  constructor() { this.deadline = Date.now() + 18000; }
  remaining(maximum = 18000) {
    const ms = Math.min(maximum, this.deadline - Date.now());
    requireThat(ms > 0, '18-second command budget exhausted; rerun explicitly');
    return ms;
  }
}
function run(command, args, budget, maxBuffer = 1024 * 1024) {
  try {
    return execFileSync(command, args, { timeout: budget.remaining(), maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // Never include captured stderr, command payloads, environment, or JSON contents.
    throw new PromoteError(`${command} failed or exceeded bounded deadline (child output withheld)`);
  }
}
export function runPluginTests(path, budget) {
  const output = run(process.execPath, ['--test', '--test-reporter=tap', path], budget).toString('utf8');
  const number = label => Number(output.match(new RegExp(`^# ${label} (\\d+)\\s*$`, 'm'))?.[1]);
  requireThat(number('tests') === 9 && number('pass') === 9 && number('fail') === 0 && number('skipped') === 0 && number('cancelled') === 0, 'installed plugin suite must report exactly 9 passing tests, no skips');
}
export function requireTag(repoRoot, tag, budget) {
  requireThat(tagPattern.test(tag), 'unsafe tag');
  try { run('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${tag}^{commit}`], budget); }
  catch { throw new PromoteError(`tag ${tag} missing locally; run: git -C ${repoRoot} fetch origin tag ${tag} --no-tags`); }
}
export function releaseTemplate(repoRoot, tag, template, budget) {
  requireThat(tagPattern.test(tag) && !template.split('/').includes('..'), 'unsafe template reference');
  return run('git', ['-C', repoRoot, 'show', `${tag}:${template}`], budget, 8 * 1024 * 1024);
}

export function invariantChecks(ctx) {
  const { policy, fix } = ctx;
  const settings = () => readJson(policy.settingsPath);
  const ownerHook = (id, event) => {
    const item = fix(id);
    const bytes = readFileSync(item.targetPath);
    return bytes.equals(readFileSync(resolve(ctx.repoRoot, item.sourceOfTruth))) && bytes.toString().includes(item.marker)
      && commandEntries(settings().hooks?.[event]).some(entry => invokesHook(entry.command, item.targetPath));
  };
  const ownerScript = id => {
    const item = fix(id);
    const bytes = readFileSync(item.targetPath);
    return bytes.equals(readFileSync(resolve(ctx.repoRoot, item.sourceOfTruth))) && bytes.toString().includes(item.marker);
  };
  const codex = policy.codex;
  const codexChecks = codex.hooksMode === 'off'
    ? [
      ['Codex: no squeez hook registered (owner decision: hooks OFF on Windows)', () => codexSqueezHooksAbsent(readIfPresent(codex.hooksPath))],
      ['Codex: context-mode plugin enabled = false', () => codexContextModeDisabled(readFileSync(codex.configPath, 'utf8'))],
    ]
    : [
      ['Codex: exactly 3 command entries', () => commandEntries(readJson(codex.hooksPath)).length === 3],
      ['Codex: all 3 events reference existing user-hooks scripts', () => codexOwnership(readJson(codex.hooksPath), codex.ownerHooks) && Object.values(codex.ownerHooks).every(path => existsSync(path) && lstatSync(path).isFile())],
    ];
  return [
    ['PostCompact: exactly one owner command; no managed postcompact.sh', () => postCompactOkay(settings(), fix('postcompact-quiet').targetPath)],
    ['compact-restore: owner bytes, marker and SessionStart reference', () => ownerHook('compact-restore', 'SessionStart')],
    ['postcompact-quiet: owner bytes, marker and settings reference', () => ownerHook('postcompact-quiet', 'PostCompact')],
    ...codexChecks,
    ...['codex-user-session-start', 'codex-user-pretooluse', 'codex-user-posttooluse'].map(id => [`${id}: owner script bytes and marker`, () => ownerScript(id)]),
    ...Object.entries(policy.config).map(([key, value]) => [
      `config: ${key} = ${value} (single active key, ${policy.claudeConfigPath.split('/').slice(-3).join('/')})`,
      () => configEquals(readFileSync(policy.claudeConfigPath, 'utf8'), key, value),
    ]),
    ...policy.autoCompressOff.map(path => [
      `auto_compress_md off (squeez semantics): ${path.replace(/^C:\/Users\/Zephyrus\//, '~/')}`,
      () => configBoolOff(readFileSync(path, 'utf8'), 'auto_compress_md'),
    ]),
  ];
}
export function pluginChecks(ctx) {
  const { manifest, repoRoot, fix } = ctx;
  const plugin = fix('plugin-source');
  return [
    ['installed plugin byte-identical to source of truth', () => readFileSync(plugin.targetPath).equals(readFileSync(resolve(repoRoot, plugin.sourceOfTruth)))],
    ['all plugin manifest markers present', () => manifest.localFixes.filter(item => item.kind === 'plugin').every(item => readFileSync(item.targetPath, 'utf8').includes(item.marker))],
  ];
}
export function releaseChecks(ctx, budget) {
  const { manifest, policy, installed, repoRoot } = ctx;
  return [
    [`installed binary SHA-256 = official ${installed.tag} asset recorded in installed.json`, () => sha256(readFileSync(manifest.installBinary)) === installed.sha256],
    ...policy.releaseAssets.map(asset => [
      `release asset matches ${installed.tag}:${asset.template}`,
      () => assetMatchesTemplate(readFileSync(asset.target), releaseTemplate(repoRoot, installed.tag, asset.template, budget)),
    ]),
  ];
}
export function verificationChecks(ctx, budget) {
  const { manifest } = ctx;
  return [
    ['installed binary exists', () => existsSync(manifest.installBinary) && lstatSync(manifest.installBinary).isFile()],
    ['installed binary PE subsystem = 3 (CONSOLE)', () => { requireConsole(readFileSync(manifest.installBinary), manifest.subsystemMustEqual); return true; }],
    ...releaseChecks(ctx, budget),
    ...pluginChecks(ctx),
    ['installed plugin tests: 9 pass, 0 fail, 0 skip', () => { runPluginTests(manifest.pluginTests, budget); return true; }],
    ...invariantChecks(ctx),
  ];
}
export function checkAll(checks, { failFast = false, log = console.log } = {}) {
  let pass = 0;
  let fail = 0;
  for (const [label, check] of checks) {
    let okay = false;
    try { okay = check() === true; } catch { /* Per-check label is safe; source contents are not. */ }
    if (okay) { pass++; log(`PASS ${label}`); }
    else {
      fail++; log(`FAIL ${label}`);
      if (failFast) throw new PromoteError(`aborted at ${label}; protected files are check-only`);
    }
  }
  return { pass, fail };
}

export function selectRelease(metadata, upstream, requested) {
  const tag = metadata.tag_name;
  requireThat(typeof tag === 'string' && tagPattern.test(tag), 'release tag must be plain vX.Y.Z');
  requireThat(!metadata.draft && !metadata.prerelease && (!requested || tag === requested), 'release is draft/prerelease or does not match requested tag');
  const assets = metadata.assets?.filter(asset => asset.name === upstream.asset) ?? [];
  requireThat(assets.length === 1, 'release must contain exactly one expected Windows executable');
  const asset = assets[0];
  requireThat(asset.browser_download_url === `https://github.com/${upstream.repo}/releases/download/${tag}/${upstream.asset}`, 'unexpected release asset URL');
  requireThat(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 64 * 1024 * 1024, 'invalid release asset size');
  return { tag, url: asset.browser_download_url, size: asset.size, digest: asset.digest ?? null };
}
export function resolveRelease(upstream, requested, budget) {
  const endpoint = requested ? `tags/${requested}` : 'latest';
  const bytes = run('gh', ['api', `repos/${upstream.repo}/releases/${endpoint}`], budget);
  let metadata;
  try { metadata = JSON.parse(bytes.toString('utf8')); }
  catch { throw new PromoteError('invalid GitHub release metadata'); }
  return selectRelease(metadata, upstream, requested);
}
export function downloadRelease(release, budget) {
  requireThat(/^sha256:[a-f0-9]{64}$/.test(release.digest ?? ''), 'release has no SHA-256 digest; refusing unverified download');
  return run('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '3', '--max-time', String(Math.max(1, Math.floor(budget.remaining() / 1000))), release.url], budget, 64 * 1024 * 1024);
}

function writeBackedUp(path, bytes, log) {
  const present = existsSync(path);
  if (present) {
    requireThat(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'refusing to overwrite non-regular file');
    if (readFileSync(path).equals(bytes)) { log(`PASS unchanged ${path}`); return null; }
  }
  const stamp = stampNow();
  const backup = present ? `${path}.bak-squeez-promote-${stamp}` : null;
  if (backup) { copyFileSync(path, backup, constants.COPYFILE_EXCL); log(`PASS backup ${backup}`); }
  const temporary = `${path}.tmp-squeez-promote-${stamp}`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  try { renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  log(`PASS wrote ${path}`);
  return backup;
}
export function installArtifacts({ root: directory, target, source, release, bytes, subsystem, testPlugin, log }) {
  requireThat(bytes.length === release.size && release.digest === `sha256:${hash(bytes)}`, 'download size or SHA-256 mismatch');
  log('PASS staged download size and SHA-256');
  requireConsole(bytes, subsystem); log('PASS staged binary PE subsystem = 3 (CONSOLE)');
  requireThat(tagPattern.test(release.tag), 'unsafe staging tag');
  const stageDirectory = join(directory, 'staged');
  if (existsSync(stageDirectory)) requireThat(lstatSync(stageDirectory).isDirectory() && !lstatSync(stageDirectory).isSymbolicLink(), 'staged directory must not be a link');
  mkdirSync(stageDirectory, { recursive: true });
  const staged = join(stageDirectory, `squeez-${release.tag}.exe`);
  writeBackedUp(staged, bytes, log);
  const wasPresent = existsSync(target);
  const backup = writeBackedUp(target, readFileSync(source), log);
  try {
    requireThat(readFileSync(target).equals(readFileSync(source)), 'plugin byte equality failed after install');
    testPlugin(); log('PASS reinstalled plugin: byte equality and 9 tests');
  } catch (error) {
    if (backup) { copyFileSync(backup, target); log(`PASS restored previous plugin from ${backup}`); }
    else if (!wasPresent) unlinkSync(target);
    throw error;
  }
  log(`PASS staged ${staged} sha256=${hash(bytes)}; live binary NOT replaced (run activate.mjs)`);
}
export function promote({ apply, root: directory, repoRoot = directory, manifest, plugin, release, preflight, download, testPlugin, log = console.log }) {
  log(`PASS target ${release.tag}`);
  if (!apply) {
    log(`PASS DRY-RUN would download ${release.url}`);
    log(`PASS DRY-RUN would verify size, SHA-256 and PE subsystem ${manifest.subsystemMustEqual}`);
    log(`PASS DRY-RUN would stage ${join(directory, 'staged', `squeez-${release.tag}.exe`)}`);
    log(`PASS DRY-RUN would back up/reinstall ${plugin.targetPath} from ${plugin.sourceOfTruth} and run 9 tests`);
    log('PASS DRY-RUN would check hook/config invariants BEFORE download and AFTER plugin installation; abort on first drift, never repair protected files');
    log('PASS DRY-RUN no files written, no binary downloaded, no squeez command invoked; plan is not a health check');
    return;
  }
  preflight();
  installArtifacts({ root: directory, target: plugin.targetPath, source: resolve(repoRoot, plugin.sourceOfTruth), release, bytes: download(), subsystem: manifest.subsystemMustEqual, testPlugin, log });
  preflight();
  log('PASS apply completed; staging only. Activate with: node local-fixes/activate.mjs --apply --version ' + release.tag);
}

// Windows refuses to overwrite a running executable, and every agent command is wrapped by squeez, so
// squeez.exe is almost always running. Renaming a running image is allowed (measured 2026-09-30): the
// live file moves aside, running processes keep their image, and new launches pick up the new file.
export function activateBinary({ live, bytes, subsystem, log }) {
  requireConsole(bytes, subsystem);
  requireThat(existsSync(live) && lstatSync(live).isFile() && !lstatSync(live).isSymbolicLink(), 'live binary must be a regular file');
  if (readFileSync(live).equals(bytes)) { log(`PASS live binary already equals staged sha256=${hash(bytes)}`); return null; }
  const backup = `${live}.bak-squeez-activate-${stampNow()}`;
  renameSync(live, backup); log(`PASS moved previous binary aside: ${backup}`);
  try {
    writeFileSync(live, bytes, { flag: 'wx' });
    requireThat(readFileSync(live).equals(bytes), 'activated binary does not match staged bytes');
  } catch (error) {
    if (existsSync(live)) unlinkSync(live);
    renameSync(backup, live); log('PASS restored previous binary after failed activation');
    throw error;
  }
  log(`PASS activated ${live} sha256=${hash(bytes)}`);
  return backup;
}
export function refreshAsset({ target, template, log }) {
  return writeBackedUp(target, withEolOf(readIfPresent(target), template), log);
}
export function writeInstalled(directory, { tag, sha256: digest }) {
  requireThat(tagPattern.test(tag) && /^[a-f0-9]{64}$/.test(digest), 'invalid installed record');
  const path = join(directory, 'installed.json');
  const record = { tag, sha256: digest, source: `official ${tag} release asset; digest matched GitHub release metadata`, activatedAt: new Date().toISOString() };
  const temporary = `${path}.tmp-${stampNow()}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, path);
}
export function activate({ apply, root: directory, live, stagedBytes, release, subsystem, templates, preflight, verify, log = console.log }) {
  requireThat(release.digest === `sha256:${hash(stagedBytes)}`, 'staged binary does not match the official release digest');
  requireConsole(stagedBytes, subsystem);
  log(`PASS staged ${release.tag} matches official digest and is CONSOLE`);
  if (!apply) {
    log(`PASS DRY-RUN would move ${live} aside and install the staged binary`);
    for (const t of templates) log(`PASS DRY-RUN would refresh ${t.target} from ${release.tag}:${t.template}`);
    log('PASS DRY-RUN would record installed.json and run full verification');
    return;
  }
  preflight();
  const binaryBackup = activateBinary({ live, bytes: stagedBytes, subsystem, log });
  for (const t of templates) refreshAsset({ target: t.target, template: t.bytes, log });
  writeInstalled(directory, { tag: release.tag, sha256: hash(stagedBytes) });
  log(`PASS recorded installed ${release.tag}`);
  const result = verify();
  requireThat(result.fail === 0, `activation verification failed (${result.fail}); previous binary kept at ${binaryBackup ?? 'unchanged'}; asset backups printed above`);
  log('PASS activation complete; restart harnesses so new sessions load the new binary');
}
