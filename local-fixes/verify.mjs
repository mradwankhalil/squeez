import { Budget, PromoteError, checkAll, loadContext, verificationChecks } from './pipeline.mjs';

try {
  if (process.argv.length !== 2) throw new PromoteError('verify takes no arguments');
  const budget = new Budget();
  const result = checkAll(verificationChecks(loadContext(), budget));
  console.log(`${result.pass} pass / ${result.fail} fail`);
  process.exitCode = result.fail ? 1 : 0;
} catch (error) {
  console.error(`FAIL ${error instanceof PromoteError ? error.message : 'cannot load verification inputs (details withheld)'}`);
  console.log('0 pass / 1 fail');
  process.exitCode = 1;
}
