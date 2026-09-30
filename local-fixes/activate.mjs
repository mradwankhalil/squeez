import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Budget, PromoteError, activate, checkAll, invariantChecks, loadContext, parseArgs, releaseTemplate, requireTag, resolveRelease, verificationChecks } from './pipeline.mjs';

try {
  const budget = new Budget();
  const options = parseArgs(process.argv.slice(2));
  if (!options.version) throw new PromoteError('activate requires --version vX.Y.Z (the tag staged by apply.mjs)');
  if (options.apply && (process.platform !== 'win32' || process.arch !== 'x64')) throw new PromoteError('--apply supports Windows x64 only');
  const ctx = loadContext();
  const staged = join(ctx.root, 'staged', `squeez-${options.version}.exe`);
  if (!existsSync(staged)) throw new PromoteError(`no staged binary ${staged}; run apply.mjs --apply --version ${options.version} first`);
  console.log('PASS arguments, manifest and staged file');
  const release = resolveRelease(ctx.manifest.upstream, options.version, budget);
  requireTag(ctx.repoRoot, release.tag, budget);
  // Read every template before anything is changed, so a missing template aborts with nothing touched.
  const templates = ctx.policy.releaseAssets.map(asset => ({ ...asset, bytes: releaseTemplate(ctx.repoRoot, release.tag, asset.template, budget) }));
  activate({
    apply: options.apply, root: ctx.root, live: ctx.manifest.installBinary, stagedBytes: readFileSync(staged), release,
    subsystem: ctx.manifest.subsystemMustEqual, templates,
    preflight: () => checkAll(invariantChecks(ctx), { failFast: true }),
    verify: () => checkAll(verificationChecks(loadContext(), new Budget())),
  });
} catch (error) {
  console.error(`FAIL ${error instanceof PromoteError ? error.message : 'filesystem or runtime error; aborted (details withheld)'}`);
  process.exitCode = 1;
}
