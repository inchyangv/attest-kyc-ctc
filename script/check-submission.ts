/** Static, offline assertions for claims that appear in the hackathon submission. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootTestFiles, testSourceFingerprint, verifyTestEvidence } from '../pipeline/test-evidence.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--docs-only')) throw new Error('usage: check:submission [--docs-only]');
const docsOnly = args[0] === '--docs-only';
const deployment = JSON.parse(read('deployments/cc3-testnet.json')) as {
  contracts: Record<string, string>;
};

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  const state = condition ? 'PASS' : 'FAIL';
  console.log(`${state}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

const readme = read('README.md');
const review = read('docs/12-ctc-investment-review.md');
const commands = read('docs/demo-video/commands.sh');
const strictCommands = read('docs/demo-video/commands-v2.sh');
const submissionVerifier = read('scripts/verify-submission.sh');
const narration = read('docs/demo-video/NARRATION.md');
const shotlist = read('docs/demo-video/SHOTLIST.md');
const preflight = read('docs/demo-video/PREFLIGHT.md');
const driver = read('deploy/verify-demo.mjs');
const workerDoc = read('docs/06-worker-design.md');
const vendorDoc = read('docs/07-kyc-vendors.md');
const productPlan = read('docs/03-product-plan.md');
check('submission evidence names the deployment tag its claims were read against', /Reconciled \d{4}-\d{2}-\d{2}\..*tagged `[^`]+`/.test(read('docs/15-submission-evidence.md')));

for (const [name, address] of Object.entries(deployment.contracts)) {
  check(`${name} address in README`, readme.includes(address), address);
  check(`${name} address in diligence review`, review.includes(address), address);
}

for (const name of ['ProofmarkASC', 'ProofmarkRegistry', 'ComplianceSource', 'GatedRwaNote']) {
  check(`${name} address in recording commands`, commands.includes(deployment.contracts[name]), deployment.contracts[name]);
}

const narrationWords = narration
  .split('\n')
  .filter((line) => line.startsWith('> '))
  .map((line) => line.slice(2))
  .join(' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean).length;
check('narration stays inside the 450-word budget', narrationWords <= 450, `${narrationWords}/450 words`);
const spokenNarration = narration.split('\n').filter(line => line.startsWith('> '))
  .map(line => line.slice(2)).join(' ').replace(/\s+/g, ' ');
check('narration says production rejects the sandbox mark and pilot accepts it',
  spokenNarration.includes("Korea's production policy says no, because the mark honestly says sandbox.")
  && spokenNarration.includes('The pilot policy says yes.'));
check('shot list stages production FAIL and sandbox PASS',
  shotlist.includes('`isVerified(A, 1)` false') && shotlist.includes('`isVerified(A, 2)` true'));
check('submission verifier routes by deployed generation: strict v2 pins or the read-only v1 kit, never write mode',
  submissionVerifier.includes('RECORD=0 DEMO_URL="$demo_url" SCENES="2 3 4 6 7 8" bash docs/demo-video/commands-v2.sh')
  && submissionVerifier.includes('RECORD=0 DEMO_URL="$demo_url" SCENES="1 2 3 4 5 6 8" bash docs/demo-video/commands.sh')
  && !submissionVerifier.includes('RECORD=1')
  && strictCommands.includes('read-only scene checks complete'));
const editCaption = 'edited — cross-chain propagation took about 9 minutes';
check('shot list carries the edited-wait caption', shotlist.includes(editCaption));
check('narration carries the same edited-wait caption', narration.includes(editCaption));
check('preflight ends on the complete read-only verifier', preflight.includes('npm run verify:submission'));
check('driver source declares production attribute preview=false (not E2E proof)', driver.includes('issue.body.policyPreview?.production === false'));
check('driver source declares sandbox attribute preview=true (not onchain eligibility proof)', driver.includes('issue.body.policyPreview?.sandbox === true'));
check('vendor documentation remains available', vendorDoc.trim().length > 0);
check('Mode B is not still described as an unimplemented ASC handler',
  !workerDoc.includes('The ASC handler is P1'));
check('public GitHub is not still marked as needing a push',
  !productPlan.includes('repository still needs pushing'));

// Internal Korean diligence is intentional. No unverified blanket language requirement is applied.
if (docsOnly) console.log('NOT CHECKED  test execution evidence (--docs-only); no test-count or release-readiness claim');
else {
  try {
    const files = rootTestFiles(repo);
    const evidence = verifyTestEvidence(JSON.parse(read('artifacts/test-evidence/latest.json')), testSourceFingerprint(repo), files);
    check('actual local test execution matches current source and complete test-file set', true,
      `Solidity ${evidence.solidity.passed}; TypeScript/ABI ${evidence.typescript.passed}; ${evidence.sourceFingerprint}`);
  } catch {
    check('actual local test execution evidence', false, 'missing, failed, expired or source changed; run npm run test:evidence');
  }
}

if (failures) {
  console.error(`\n${failures} submission assertion(s) failed.`);
  process.exit(1);
}
console.log('\nPASS local documentation checks' + (docsOnly ? ' only.' : ' and source-bound local test evidence.'));
console.log('NOT VERIFIED: public deployment, current eligibility/freshness, video, external reproduction, legal/commercial evidence or final submission.');
