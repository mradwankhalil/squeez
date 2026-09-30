// Promote squeez the normal way, then re-apply the owner overlays upstream does not ship yet.
//   node local-fixes/apply.mjs             dry-run: current health + the plan (writes nothing)
//   node local-fixes/apply.mjs --apply     squeez update -> setup (safe hosts) -> overlays + config -> verify
import { existsSync } from 'node:fs';
import { PromoteError, checkAll, ensureTag, loadContext, parseArgs, reapplyConfig, reapplyOverlay, run, verificationChecks, versionTag } from './pipeline.mjs';

try {
  const { apply } = parseArgs(process.argv.slice(2));
  const ctx = loadContext();
  const m = ctx.manifest;
  const installed = versionTag(run(m.binary, ['--version'], 20000).out);
  const check = run(m.binary, ['update', '--check'], 60000);
  console.log(`INFO installed ${installed ?? 'unknown'}; ${check.out.trim().split(/\r?\n/).pop()}`);
  const hosts = m.setupHosts.filter(h => existsSync(h.requires)).map(h => h.host);

  if (!apply) {
    console.log('INFO current health:');
    checkAll(verificationChecks(ctx));
    console.log('\nPLAN (--apply):');
    console.log('  1. squeez update            official release, checksums.sha256 verified, running exe swapped by rename, Claude hooks refreshed');
    console.log(`  2. squeez setup --host=...  ${hosts.join(', ')}  (never: ${Object.keys(m.neverSetupHosts).join(', ')})`);
    for (const o of m.overlays) console.log(`  3. overlay ${o.id}: re-apply only if drifted  [${o.upstream.map(u => u.ref).join(', ')}]`);
    console.log('  4. config values re-applied only if drifted (backup first)');
    console.log('  5. full verification; any FAIL exits 1');
  } else {
    const u = run(m.binary, ['update'], 300000);
    u.out.trim().split(/\r?\n/).forEach(l => console.log(`     ${l}`));
    if (u.code !== 0) throw new PromoteError('squeez update failed; nothing else was changed');
    if (/queued/i.test(u.out)) throw new PromoteError('squeez update queued the swap (binary locked); close the harnesses, rerun apply');
    const tag = versionTag(run(m.binary, ['--version'], 20000).out);
    if (!tag || !ensureTag(tag)) throw new PromoteError(`could not fetch tag ${tag} into the fork checkout (needed to verify release assets)`);
    console.log(`PASS squeez update: now ${tag}`);
    for (const h of hosts) {
      const r = run(m.binary, ['setup', `--host=${h}`], 120000);
      if (r.code !== 0) throw new PromoteError(`squeez setup --host=${h} failed: ${r.out.trim().split(/\r?\n/).pop()}`);
      console.log(`PASS squeez setup --host=${h}`);
    }
    for (const o of m.overlays) console.log(reapplyOverlay(o, ctx));
    reapplyConfig(ctx).forEach(l => console.log(l));
    console.log('INFO verification:');
    const result = checkAll(verificationChecks(ctx));
    if (result.fail) throw new PromoteError(`${result.fail} check(s) failed after promotion; backups are next to each changed file`);
    console.log('PASS promotion complete; restart the harnesses so new sessions load the new binary and hooks');
  }
} catch (error) {
  console.error(`FAIL ${error instanceof PromoteError ? error.message : 'filesystem or runtime error; aborted (details withheld)'}`);
  process.exitCode = 1;
}
