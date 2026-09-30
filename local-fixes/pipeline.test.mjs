// node --test local-fixes/pipeline.test.mjs  (pure helpers + the real manifest; never touches live files)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from './pipeline.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function pe(subsystem = 3, { optionalSize = 240, magic = 0x20b } = {}) {
  const b = Buffer.alloc(512);
  b.write('MZ', 0, 'ascii'); b.writeUInt32LE(128, 60); b.write('PE\0\0', 128, 'ascii');
  b.writeUInt16LE(optionalSize, 148); b.writeUInt16LE(magic, 152); b.writeUInt16LE(subsystem, 152 + 68);
  return b;
}

test('arguments: dry-run by default, --apply once, no --version (squeez update is latest-only)', () => {
  assert.deepEqual(p.parseArgs([]), { apply: false });
  assert.deepEqual(p.parseArgs(['--apply']), { apply: true });
  for (const bad of [['--apply', '--apply'], ['--apply', '--dry-run'], ['--version', 'v1.48.10'], ['--wat']]) {
    assert.throws(() => p.parseArgs(bad), p.PromoteError, bad.join(' '));
  }
});

test('PE subsystem is read from the header: CONSOLE passes, GUI and truncated files do not', () => {
  assert.equal(p.readSubsystem(pe(3)), 3);
  assert.equal(p.readSubsystem(pe(2)), 2);
  assert.throws(() => p.readSubsystem(pe(3).subarray(0, 100)));
  assert.throws(() => p.readSubsystem(pe(3, { magic: 0x1234 })));
});

test('version tag and official checksum parsing', () => {
  assert.equal(p.versionTag('squeez 1.48.10\n'), 'v1.48.10');
  assert.equal(p.versionTag('nothing'), null);
  const sums = `${'a'.repeat(64)}  squeez-linux-x86_64\n${'B'.repeat(64)} *squeez-windows-x86_64.exe\n`;
  assert.equal(p.findChecksum(sums, 'squeez-windows-x86_64.exe'), 'b'.repeat(64));
  assert.equal(p.findChecksum(sums, 'missing.exe'), null);
});

test('config follows squeez parser: false-with-comment is off, only exact true is on', () => {
  assert.equal(p.configSatisfies('auto_compress_md = false   # DISABLED (X-98)', 'auto_compress_md', 'false'), true);
  assert.equal(p.configSatisfies('auto_compress_md = true', 'auto_compress_md', 'false'), false);
  assert.equal(p.configSatisfies('wrap_timeout_secs = 540', 'wrap_timeout_secs', '540'), true);
  assert.equal(p.configSatisfies('wrap_timeout_secs = 360', 'wrap_timeout_secs', '540'), false);
  assert.equal(p.configSatisfies('a = 1\na = 2', 'a', '1'), false, 'duplicates are never trusted');
  assert.equal(p.configSatisfies('[x]\nauto_compress_md = false', 'auto_compress_md', 'false'), false, 'sectioned key is not top-level');
});

test('setConfigValue replaces in place, appends when missing, keeps CRLF, refuses duplicates', () => {
  assert.equal(p.setConfigValue('# c\r\nauto_compress_md = true\r\n', 'auto_compress_md', 'false'), '# c\r\nauto_compress_md = false\r\n');
  assert.equal(p.setConfigValue('enabled = true\n', 'auto_compress_md', 'false'), 'enabled = true\nauto_compress_md = false\n');
  assert.equal(p.setConfigValue('enabled = true\n[section]\nk = v\n', 'x', '1'), 'enabled = true\nx = 1\n[section]\nk = v\n');
  assert.throws(() => p.setConfigValue('a = 1\na = 2\n', 'a', '3'), p.PromoteError);
});

test('config presence: a missing file is required only while its trigger exists', () => {
  assert.equal(p.configPresence(true, 'x', true), 'present');
  assert.equal(p.configPresence(true, undefined, false), 'present');
  assert.equal(p.configPresence(false, 'x', true), 'required-absent');
  assert.equal(p.configPresence(false, 'x', false), 'absent');
  assert.equal(p.configPresence(false, undefined, false), 'absent');
});

test('reapplyConfig creates a required config, skips an optional absent one, leaves a correct one untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sq-cfg-'));
  try {
    const trigger = join(dir, 'plugins', 'squeez.js');
    mkdirSync(join(dir, 'plugins')); writeFileSync(trigger, '// plugin');
    const required = join(dir, 'v2', 'squeez', 'config.ini');
    const optional = join(dir, 'absent-host', 'config.ini');
    const ok = join(dir, 'ok.ini'); writeFileSync(ok, 'auto_compress_md = false\n');
    const before = statSync(ok).mtimeMs;
    const ctx = { manifest: {
      config: { [required]: { auto_compress_md: 'false' }, [optional]: { auto_compress_md: 'false' }, [ok]: { auto_compress_md: 'false' } },
      configRequiredWhen: { [required]: trigger, [optional]: join(dir, 'no-such-trigger') },
    } };
    const log = p.reapplyConfig(ctx);
    assert.equal(log.length, 1);
    assert.match(log[0], /created with auto_compress_md = false/);
    assert.equal(p.configSatisfies(readFileSync(required, 'utf8'), 'auto_compress_md', 'false'), true);
    assert.equal(existsSync(optional), false);
    assert.equal(statSync(ok).mtimeMs, before);
    assert.deepEqual(p.reapplyConfig(ctx), [], 'idempotent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex: absent hooks.json passes, any squeez command fails; context-mode must be explicitly false', () => {
  assert.equal(p.codexSqueezHooksAbsent(null), true);
  assert.equal(p.codexSqueezHooksAbsent('{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"bash C:/x/other.sh"}]}]}}'), true);
  assert.equal(p.codexSqueezHooksAbsent('{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"bash C:/Users/u/.codex/user-hooks/squeez-pretooluse.sh"}]}]}}'), false);
  assert.equal(p.codexSqueezHooksAbsent('{broken'), false);
  assert.equal(p.codexContextModeDisabled('[plugins."context-mode@context-mode"]\nenabled = false\n'), true);
  assert.equal(p.codexContextModeDisabled('[plugins."context-mode@context-mode"]\nenabled = true\n'), false);
  assert.equal(p.codexContextModeDisabled('[other]\nenabled = false\n'), false);
});

test('Copilot: the setup-written registration is detected and normalized under hooks, keeping other hooks', () => {
  const home = 'C:\\Users\\u';
  const broken = {
    hooks: { SessionStart: [{ type: 'command', powershell: 'herdr.ps1', timeoutSec: 10 }] },
    theme: 'github',
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash C:\\Users\\u/.copilot\\squeez\\hooks\\copilot-pretooluse.sh' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'bash C:\\Users\\u/.copilot\\squeez\\hooks\\copilot-session-start.sh' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'bash C:\\Users\\u/.copilot\\squeez\\hooks\\copilot-posttooluse.sh' }] }],
  };
  assert.equal(p.copilotSettingsOk(broken), false);
  const fixed = p.normalizeCopilotSettings(broken, home);
  assert.equal(p.copilotSettingsOk(fixed), true);
  assert.deepEqual(Object.keys(fixed).sort(), ['hooks', 'theme']);
  assert.equal(fixed.hooks.SessionStart[0].powershell, 'herdr.ps1', 'non-squeez hook kept first');
  assert.equal(fixed.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(fixed.hooks.PreToolUse[0].hooks[0].command, 'bash "C:/Users/u/.copilot/squeez/hooks/copilot-pretooluse.sh"');
  assert.deepEqual(p.normalizeCopilotSettings(fixed, home), fixed, 'idempotent');
});

test('Copilot: backslash or duplicate squeez entries under hooks are not accepted', () => {
  const home = 'C:/Users/u';
  const ok = p.normalizeCopilotSettings({}, home);
  const dup = structuredClone(ok); dup.hooks.PostToolUse.push(structuredClone(dup.hooks.PostToolUse[0]));
  const back = structuredClone(ok); back.hooks.SessionStart[0].hooks[0].command = 'bash C:\\Users\\u\\.copilot\\squeez\\hooks\\copilot-session-start.sh';
  assert.equal(p.copilotSettingsOk(ok), true);
  assert.equal(p.copilotSettingsOk(dup), false);
  assert.equal(p.copilotSettingsOk(back), false);
});

test('doctor output: only [FAIL] lines count', () => {
  const out = 'squeez doctor\n[ok]   hooks: fine\n[FAIL] registration: copilot — 3 hook command(s) cannot execute\n         detail\n[ok]   config';
  assert.deepEqual(p.doctorFailures(out), ['[FAIL] registration: copilot — 3 hook command(s) cannot execute']);
  assert.deepEqual(p.doctorFailures('[ok] all good'), []);
});

test('real manifest: every overlay names an upstream issue/PR and a retire condition; setup never targets unsafe hosts', () => {
  const { manifest } = p.loadContext();
  assert.ok(manifest.overlays.length >= 3);
  for (const o of manifest.overlays) {
    assert.ok(o.upstream.every(u => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(u.url)), o.id);
    assert.ok(o.retireWhen.length > 20, o.id);
  }
  const hosts = manifest.setupHosts.map(h => h.host);
  assert.deepEqual(hosts, p.SAFE_SETUP_HOSTS);
  for (const unsafe of Object.keys(manifest.neverSetupHosts)) assert.ok(!hosts.includes(unsafe), unsafe);
});

test('real manifest: every required config is also a managed config and pins auto_compress_md = false', () => {
  const { manifest } = p.loadContext();
  const required = Object.entries(manifest.configRequiredWhen ?? {});
  assert.ok(required.length >= 3);
  for (const [file, trigger] of required) {
    assert.ok(manifest.config[file], file);
    assert.equal(manifest.config[file].auto_compress_md, 'false', file);
    assert.ok(typeof trigger === 'string' && trigger.length > 0, file);
  }
});
