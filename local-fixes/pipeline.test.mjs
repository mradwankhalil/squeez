import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const p = await import('./pipeline.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
test('pipeline implementation is available', () => assert.ok(p, 'missing promote implementation'));
const check = (name, fn) => test(name, { skip: !p }, fn);

function pe(subsystem = 3) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(112, 84); bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt16LE(subsystem, 156);
  return bytes;
}

check('default invocation selects dry-run', () => {
  // Given no mutation flag; When parsing; Then never choose apply.
  assert.deepEqual(p.parseArgs([]), { apply: false, version: null });
});
check('specific plain tag is accepted', () => {
  assert.deepEqual(p.parseArgs(['--apply', '--version', 'v1.48.10']), { apply: true, version: 'v1.48.10' });
});
for (const args of [['--version', '1.48.10'], ['--version', 'v1.48.10-rc1'], ['--version', '../bad'], ['--version'], ['--apply', '--dry-run'], ['--apply', '--apply'], ['--wat'], ['--version', 'v1.2.3', '--version', 'v2.3.4']]) {
  check(`unsafe or ambiguous arguments rejected: ${args.join(' ')}`, () => assert.throws(() => p.parseArgs(args)));
}
check('CONSOLE subsystem is read from PE header, not version', () => assert.equal(p.readSubsystem(pe()), 3));
check('GUI subsystem is not accepted as CONSOLE', () => assert.throws(() => p.requireConsole(pe(2), 3)));
check('truncated PE cannot pass', () => assert.throws(() => p.readSubsystem(pe().subarray(0, 90))));
check('invalid optional-header magic cannot pass', () => {
  const bytes = pe(); bytes.writeUInt16LE(0, 88);
  assert.throws(() => p.readSubsystem(bytes));
});
check('out-of-bounds PE offset cannot pass', () => {
  const bytes = pe(); bytes.writeUInt32LE(0xfffffff0, 60);
  assert.throws(() => p.readSubsystem(bytes));
});
check('config ignores comments but rejects duplicate active keys', () => {
  assert.equal(p.configEquals('# auto_compress_md = true\nauto_compress_md = false\n', 'auto_compress_md', 'false'), true);
  assert.equal(p.configEquals('auto_compress_md = false\nauto_compress_md = true', 'auto_compress_md', 'false'), false);
});
check('comment or section-scoped config is not a top-level invariant', () => {
  assert.equal(p.configEquals('# wrap_timeout_secs = 540', 'wrap_timeout_secs', '540'), false);
  assert.equal(p.configEquals('[other]\nwrap_timeout_secs = 540', 'wrap_timeout_secs', '540'), false);
});
const owner = 'C:/Users/Zephyrus/.claude/hooks/squeez-postcompact-quiet.sh';
const command = path => ({ type: 'command', command: `bash "${path}"` });
check('owner PostCompact registration passes', () => {
  assert.equal(p.postCompactOkay({ hooks: { PostCompact: [{ hooks: [command(owner)] }] } }, owner), true);
});
check('duplicate managed PostCompact registration fails', () => {
  const settings = { hooks: { PostCompact: [{ hooks: [command(owner), command('C:/.claude/squeez/hooks/postcompact.sh')] }] } };
  assert.equal(p.postCompactOkay(settings, owner), false);
});
check('mentioning a hook in echo is not registering it', () => assert.equal(p.invokesHook(`echo "${owner}"`, owner), false));
check('six command entries reproduce duplicate detection', () => {
  assert.equal(p.commandEntries({ hooks: { Before: [{ hooks: Array.from({ length: 6 }, () => command(owner)) }] } }).length, 6);
});
check('three managed Codex commands still fail ownership', () => {
  const expected = { SessionStart: 'C:/Users/Zephyrus/.codex/user-hooks/squeez-session-start.sh' };
  assert.equal(p.codexOwnership({ hooks: { SessionStart: [{ hooks: [command('C:/Users/Zephyrus/.codex/squeez/hooks/codex-session-start.sh')] }] } }, expected), false);
});
check('wrong release tag is refused even if metadata has an asset', () => {
  assert.throws(() => p.selectRelease({ tag_name: 'v1.48.10-beta', assets: [] }, { repo: 'claudioemmanuel/squeez', asset: 'squeez-windows-x86_64.exe' }, null));
});
check('release asset from another repository is refused', () => {
  const meta = { tag_name: 'v1.48.10', assets: [{ name: 'squeez-windows-x86_64.exe', size: 256, browser_download_url: 'https://evil.test/a.exe' }] };
  assert.throws(() => p.selectRelease(meta, { repo: 'claudioemmanuel/squeez', asset: 'squeez-windows-x86_64.exe' }, null));
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'squeez-promote-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = join(root, 'live.exe'); writeFileSync(live, pe());
  const plugin = join(root, 'plugin.js'); writeFileSync(plugin, 'old owner plugin');
  const source = join(root, 'source.js'); writeFileSync(source, 'new owner plugin');
  const bytes = pe();
  return { root, live, plugin, source, bytes, release: { tag: 'v1.48.10', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, url: 'unused' } };
}
check('staging never replaces live executable and plugin overwrite is backed up', t => {
  const f = fixture(t); const before = readFileSync(f.live);
  p.installArtifacts({ root: f.root, target: f.plugin, source: f.source, release: f.release, bytes: f.bytes, subsystem: 3, testPlugin: () => {}, log: () => {} });
  assert.deepEqual(readFileSync(f.live), before);
  assert.equal(readFileSync(f.plugin, 'utf8'), 'new owner plugin');
  const backup = readdirSync(f.root).find(n => n.startsWith('plugin.js.bak-squeez-promote-'));
  assert.ok(backup); assert.equal(readFileSync(join(f.root, backup), 'utf8'), 'old owner plugin');
  assert.ok(existsSync(join(f.root, 'staged', 'squeez-v1.48.10.exe')));
});
check('invalid staged binary aborts before plugin overwrite', t => {
  const f = fixture(t);
  assert.throws(() => p.installArtifacts({ root: f.root, target: f.plugin, source: f.source, release: f.release, bytes: pe(2), subsystem: 3, testPlugin: () => {}, log: () => {} }));
  assert.equal(readFileSync(f.plugin, 'utf8'), 'old owner plugin');
  assert.equal(existsSync(join(f.root, 'staged')), false);
});
check('test failure restores prior plugin and preserves backup', t => {
  const f = fixture(t);
  assert.throws(() => p.installArtifacts({ root: f.root, target: f.plugin, source: f.source, release: f.release, bytes: f.bytes, subsystem: 3, testPlugin: () => { throw new Error('fixture failure'); }, log: () => {} }));
  assert.equal(readFileSync(f.plugin, 'utf8'), 'old owner plugin');
  assert.ok(readdirSync(f.root).some(n => n.startsWith('plugin.js.bak-squeez-promote-')));
});
check('dry-run plan creates no staged files and never calls downloader', t => {
  const f = fixture(t); let downloaded = false;
  p.promote({ apply: false, root: f.root, manifest: { subsystemMustEqual: 3 }, plugin: { targetPath: f.plugin, sourceOfTruth: 'source.js' }, release: f.release, preflight: () => {}, download: () => { downloaded = true; return f.bytes; }, testPlugin: () => {}, log: () => {} });
  assert.equal(downloaded, false); assert.equal(existsSync(join(f.root, 'staged')), false);
  assert.equal(readFileSync(f.plugin, 'utf8'), 'old owner plugin');
});
check('protected-file drift blocks download and plugin changes', t => {
  const f = fixture(t); let downloaded = false;
  assert.throws(() => p.promote({ apply: true, root: f.root, manifest: { subsystemMustEqual: 3 }, plugin: { targetPath: f.plugin, sourceOfTruth: 'source.js' }, release: f.release, preflight: () => { throw new Error('protected-file drift'); }, download: () => { downloaded = true; return f.bytes; }, testPlugin: () => {}, log: () => {} }));
  assert.equal(downloaded, false); assert.equal(readFileSync(f.plugin, 'utf8'), 'old owner plugin');
});

check('auto_compress_md off follows squeez parser: inline comment after false is still off', () => {
  assert.equal(p.configBoolOff('auto_compress_md = false   # DISABLED 2026-09-30 (X-98)', 'auto_compress_md'), true);
  assert.equal(p.configBoolOff('auto_compress_md = false', 'auto_compress_md'), true);
});
check('auto_compress_md exactly true is on; duplicates and sections are refused', () => {
  assert.equal(p.configBoolOff('auto_compress_md = true', 'auto_compress_md'), false);
  assert.equal(p.configBoolOff('auto_compress_md = true\r\n', 'auto_compress_md'), false);
  assert.equal(p.configBoolOff('auto_compress_md = false\nauto_compress_md = true', 'auto_compress_md'), false);
  assert.equal(p.configBoolOff('[x]\nauto_compress_md = false', 'auto_compress_md'), false);
  assert.equal(p.configBoolOff('# auto_compress_md = false', 'auto_compress_md'), false);
});
check('Codex hooks off: absent hooks.json passes, any squeez command fails, unrelated hooks tolerated', () => {
  assert.equal(p.codexSqueezHooksAbsent(null), true);
  assert.equal(p.codexSqueezHooksAbsent(JSON.stringify({ hooks: { SessionStart: [{ hooks: [command('C:/Users/Zephyrus/.codex/user-hooks/squeez-session-start.sh')] }] } })), false);
  assert.equal(p.codexSqueezHooksAbsent(JSON.stringify({ hooks: { Stop: [{ hooks: [command('C:/tools/notify.sh')] }] } })), true);
  assert.equal(p.codexSqueezHooksAbsent('{not json'), false);
});
check('context-mode Codex plugin must be explicitly disabled in its own section', () => {
  const toml = '[plugins."chrome@openai-bundled"]\nenabled = true\n\n[plugins."context-mode@context-mode"]\nenabled = false\n';
  assert.equal(p.codexContextModeDisabled(toml), true);
  assert.equal(p.codexContextModeDisabled(toml.replace('enabled = false', 'enabled = true')), false);
  assert.equal(p.codexContextModeDisabled('[plugins."chrome@openai-bundled"]\nenabled = false\n'), false);
});
check('release asset comparison ignores CRLF vs LF only', () => {
  assert.equal(p.assetMatchesTemplate(Buffer.from('a\r\nb\r\n'), Buffer.from('a\nb\n')), true);
  assert.equal(p.assetMatchesTemplate(Buffer.from('a\r\nc\r\n'), Buffer.from('a\nb\n')), false);
});
check('asset refresh keeps the installed file line-ending style', () => {
  assert.equal(p.withEolOf('x\r\ny\r\n', Buffer.from('n1\nn2\n')).toString(), 'n1\r\nn2\r\n');
  assert.equal(p.withEolOf('x\ny\n', Buffer.from('n1\r\nn2\r\n')).toString(), 'n1\nn2\n');
  assert.equal(p.withEolOf(null, Buffer.from('n1\n')).toString(), 'n1\n');
});
check('activation moves the live binary aside, installs staged bytes and keeps a backup', t => {
  const f = fixture(t); const before = readFileSync(f.live); const next = pe(); next.write('NEW', 200);
  const backup = p.activateBinary({ live: f.live, bytes: next, subsystem: 3, log: () => {} });
  assert.deepEqual(readFileSync(f.live), next);
  assert.ok(backup && existsSync(backup)); assert.deepEqual(readFileSync(backup), before);
});
check('activation is a no-op when live already equals staged', t => {
  const f = fixture(t);
  assert.equal(p.activateBinary({ live: f.live, bytes: readFileSync(f.live), subsystem: 3, log: () => {} }), null);
});
check('activation refuses a GUI staged binary and leaves live untouched', t => {
  const f = fixture(t); const before = readFileSync(f.live);
  assert.throws(() => p.activateBinary({ live: f.live, bytes: pe(2), subsystem: 3, log: () => {} }));
  assert.deepEqual(readFileSync(f.live), before);
});
check('activate refuses a staged binary whose digest differs from the release', t => {
  const f = fixture(t); const other = pe(); other.write('X', 210);
  assert.throws(() => p.activate({ apply: true, root: f.root, live: f.live, stagedBytes: other, release: f.release, subsystem: 3, templates: [], preflight: () => {}, verify: () => ({ fail: 0 }), log: () => {} }));
});
check('activate dry-run changes nothing and never runs preflight', t => {
  const f = fixture(t); const next = pe(); next.write('NEW', 200); let ran = false;
  const release = { ...f.release, digest: `sha256:${createHash('sha256').update(next).digest('hex')}` };
  p.activate({ apply: false, root: f.root, live: f.live, stagedBytes: next, release, subsystem: 3, templates: [{ template: 't', target: join(f.root, 'asset.js'), bytes: Buffer.from('x') }], preflight: () => { ran = true; }, verify: () => ({ fail: 0 }), log: () => {} });
  assert.equal(ran, false); assert.deepEqual(readFileSync(f.live), f.bytes); assert.equal(existsSync(join(f.root, 'asset.js')), false);
});
check('activate apply installs binary, refreshes assets, records installed.json, then verifies', t => {
  const f = fixture(t); const next = pe(); next.write('NEW', 200);
  const digest = createHash('sha256').update(next).digest('hex');
  const asset = join(f.root, 'asset.js'); writeFileSync(asset, 'old\r\n');
  p.activate({ apply: true, root: f.root, live: f.live, stagedBytes: next, release: { ...f.release, digest: `sha256:${digest}` }, subsystem: 3, templates: [{ template: 't', target: asset, bytes: Buffer.from('new\n') }], preflight: () => {}, verify: () => ({ fail: 0 }), log: () => {} });
  assert.deepEqual(readFileSync(f.live), next);
  assert.equal(readFileSync(asset, 'utf8'), 'new\r\n');
  assert.equal(JSON.parse(readFileSync(join(f.root, 'installed.json'), 'utf8')).sha256, digest);
});
check('activate reports failed post-activation verification', t => {
  const f = fixture(t); const next = pe(); next.write('NEW', 200);
  const release = { ...f.release, digest: `sha256:${createHash('sha256').update(next).digest('hex')}` };
  assert.throws(() => p.activate({ apply: true, root: f.root, live: f.live, stagedBytes: next, release, subsystem: 3, templates: [], preflight: () => {}, verify: () => ({ fail: 2 }), log: () => {} }), /activation verification failed/);
});
