/** Generate lock-derived SBOMs and local change evidence. Does not install packages, load secrets,
 * sign attestations or claim production release approval. --write creates a NEW output directory. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertActionPins, assertSourceBaseline, inspectLock, sbomSummary, sha256 } from '../pipeline/supply-chain.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.some(f => !['--write', '--audit'].includes(f))) throw new Error('usage: supply-chain.ts [--write] [--audit]');
const run = (command: string, args: string[], cwd = repo) => execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 20_000_000, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const baseline = JSON.parse(readFileSync(join(repo, 'docs/supply-chain/baseline.json'), 'utf8'));
assertActionPins(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'));
const sourceHashes = Object.fromEntries(Object.keys(baseline.sourceHashes).map(path => [path, sha256(readFileSync(join(repo, path)))]));
assertSourceBaseline(baseline.sourceHashes, sourceHashes);
const submodule = run('git', ['-C', 'lib/forge-std', 'rev-parse', 'HEAD']);
if (submodule !== baseline.forgeStdCommit || run('git', ['-C', 'lib/forge-std', 'status', '--porcelain=v1']).length) throw new Error('forge-std changed; explicit dependency review required');
const generatedAt = new Date().toISOString();
const artifacts: Record<string, string> = {};
const projects = ['root', 'web'].map(name => {
  const cwd = name === 'root' ? repo : join(repo, 'web');
  const bytes = readFileSync(join(cwd, 'package-lock.json'), 'utf8');
  const lock = inspectLock(JSON.parse(bytes));
  if (lock.issues.length) throw new Error(`${name} lock inventory invalid: ${lock.issues.join('; ')}`);
  const text = run('npm', ['sbom', '--package-lock-only', '--sbom-format=cyclonedx', '--sbom-type=application'], cwd);
  const summary = sbomSummary(JSON.parse(text));
  if (summary.missingLicense.length) throw new Error(`${name} SBOM license metadata missing`);
  artifacts[`${name}.cdx.json`] = text + '\n';
  let audit: unknown = { status: 'not-run' };
  if (flags.includes('--audit')) {
    // npm audit nonzero is a failed gate; do not convert network failure into vulnerability zero.
    const report = JSON.parse(run('npm', ['audit', '--json'], cwd));
    if (report.auditReportVersion !== 2 || report.metadata?.vulnerabilities?.total !== 0) throw new Error(`${name} audit is not a confirmed zero-findings response`);
    artifacts[`${name}.audit.json`] = JSON.stringify(report, null, 2) + '\n';
    audit = { status: 'registry-response-zero', at: new Date().toISOString(), vulnerabilities: report.metadata.vulnerabilities };
  }
  return { name, lockSha256: sha256(bytes), ...summary, directDependencies: lock.direct,
    lifecycleScripts: lock.packages.filter(p => p.installScript), bundledPackages: lock.packages.filter(p => p.enclosingTarball), audit };
});
const inputs = ['package-lock.json', 'web/package-lock.json', 'foundry.toml', '.github/workflows/ci.yml'];
const report = { version: 1, generatedAt, evidenceKind: 'unsigned-local-lock-derived-inventory',
  head: run('git', ['rev-parse', 'HEAD']), dirtyWorktree: Boolean(run('git', ['status', '--porcelain=v1', '--untracked-files=normal'])),
  tools: { node: process.version, npm: run('npm', ['--version']) },
  inputs: Object.fromEntries(inputs.map(path => [path, sha256(readFileSync(join(repo, path)))])), sourceHashes,
  forgeStdCommit: submodule, forkReference: baseline.forkReference, projects,
  blockers: ['Root LICENSE/rightsholder approval is unresolved; package MIT metadata is not a grant.',
    'Fork file MIT header and upstream repository Apache-2.0 license require reconciliation.',
    'Non-baseline license expressions need distribution-specific review; inventory is not legal approval.',
    'saxes upstream maintenance and eslint deprecation require an assigned maintenance plan.',
    'No signed build provenance, runtime/container SBOM or independently reviewed release exists.'],
  rootLicenseFilePresent: existsSync(join(repo, 'LICENSE')),
  artifactHashes: Object.fromEntries(Object.entries(artifacts).map(([name, content]) => [name, sha256(content)])) };
if (flags.includes('--write')) {
  const parent = join(repo, 'artifacts', 'supply-chain'); mkdirSync(parent, { recursive: true });
  const destination = join(parent, generatedAt.replace(/[:.]/g, '-'));
  mkdirSync(destination); // collision fails: never overwrite older evidence
  for (const [name, content] of Object.entries({ ...artifacts, 'report.json': JSON.stringify(report, null, 2) + '\n' })) writeFileSync(join(destination, name), content, { flag: 'wx' });
  console.log(`wrote local inventory: ${destination}`);
}
console.log(JSON.stringify(report, null, 2));
