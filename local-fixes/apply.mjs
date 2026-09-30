import { Budget, PromoteError, checkAll, downloadRelease, invariantChecks, loadContext, parseArgs, pluginChecks, promote, resolveRelease, runPluginTests } from './pipeline.mjs';

try {
  const budget = new Budget();
  const options = parseArgs(process.argv.slice(2));
  const ctx = loadContext();
  if (options.apply && (process.platform !== 'win32' || process.arch !== 'x64')) throw new PromoteError('--apply supports Windows x64 only');
  console.log('PASS arguments and manifest');
  const release = resolveRelease(ctx.manifest.upstream, options.version, budget);
  promote({
    ...ctx, ...options, release, plugin: ctx.fix('plugin-source'),
    preflight: () => checkAll(invariantChecks(ctx), { failFast: true }),
    download: () => downloadRelease(release, budget),
    testPlugin: () => {
      runPluginTests(ctx.manifest.pluginTests, budget);
      checkAll(pluginChecks(ctx), { failFast: true });
    },
  });
} catch (error) {
  console.error(`FAIL ${error instanceof PromoteError ? error.message : 'filesystem or runtime error; aborted (details withheld)'}`);
  process.exitCode = 1;
}
