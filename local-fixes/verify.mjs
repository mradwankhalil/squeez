// Read-only health check of the squeez install and its overlays. Exit 1 on any FAIL.
import { PromoteError, checkAll, loadContext, verificationChecks } from './pipeline.mjs';

try {
  if (process.argv.length !== 2) throw new PromoteError('verify takes no arguments');
  const result = checkAll(verificationChecks(loadContext()));
  process.exitCode = result.fail ? 1 : 0;
} catch (error) {
  console.error(`FAIL ${error instanceof PromoteError ? error.message : 'cannot load verification inputs (details withheld)'}`);
  process.exitCode = 1;
}
