import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface TestEvidence {
  version: 1;
  sourceFingerprint: string;
  startedAt: number;
  completedAt: number;
  nodeVersion: string;
  forgeVersion: string;
  solidity: { passed: number; failed: number; skipped: number; total: number };
  typescript: { passed: number; failed: number; skipped: number; cancelled: number; todo: number; total: number };
  testFiles: string[];
}

/** One file discovery contract for execution and evidence verification, including provider submodules. */
export function rootTestFiles(repo: string): string[] {
  const files: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(repo, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('test discovery does not follow symlinks');
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  for (const dir of ['worker', 'pipeline', 'aml', 'test']) visit(dir);
  return files.sort();
}

export function testSourceFingerprint(repo: string): string {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter(path => /^(?:src|test|pipeline|worker|aml|script|scripts|docs|deploy|deployments|web|zk|\.github)\//.test(path)
      ? /\.(?:ts|tsx|mts|js|jsx|mjs|cjs|sol|circom|json|sh|md|yml|yaml|toml|css|html|svg)$/.test(path)
      : ['package.json', 'package-lock.json', 'tsconfig.json', 'foundry.toml', 'README.md', '.gitmodules', '.gitignore'].includes(path));
  const root = realpathSync(repo); const hash = createHash('sha256').update('proofmark-test-source-v1\0');
  for (const path of [...new Set(paths)].sort()) {
    const absolute = join(repo, path);
    hash.update(path).update('\0');
    if (!existsSync(absolute)) { hash.update('deleted\0'); continue; }
    if (!realpathSync(absolute).startsWith(root + sep)) throw new Error('test source symlink escapes repository');
    hash.update(createHash('sha256').update(readFileSync(absolute)).digest('hex')).update('\0');
  }
  const library = join(repo, 'lib/forge-std');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: library, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: library, encoding: 'utf8' }).trim()) throw new Error('forge-std must be clean for test evidence');
  hash.update(`forge-std\0${head}\0`);
  // Historical AML property tests consume ignored raw data. Bind those bytes too, not just code.
  const raw = join(repo, 'data/raw');
  let dataDir = raw;
  const pointer = join(raw, 'current.json');
  if (existsSync(pointer)) {
    const bytes = readFileSync(pointer); const parsed = JSON.parse(bytes.toString('utf8'));
    if (!/^[0-9a-f-]{36}$/.test(parsed.generation)) throw new Error('invalid test-data generation');
    hash.update('aml-pointer\0').update(bytes); dataDir = join(raw, 'generations', parsed.generation);
  }
  for (const file of ['ofac_sdn.xml', 'un_consolidated.xml', 'eu_fsf.xml']) {
    const path = join(dataDir, file); hash.update(file).update('\0');
    if (!existsSync(path)) { hash.update('missing\0'); continue; }
    if (!realpathSync(path).startsWith(root + sep)) throw new Error('test data symlink escapes repository');
    hash.update(createHash('sha256').update(readFileSync(path)).digest('hex')).update('\0');
  }
  return hash.digest('hex');
}
export function foundrySummary(raw: string): TestEvidence['solidity'] {
  const parsed = JSON.parse(raw);
  const result = { passed: 0, failed: 0, skipped: 0, total: 0 };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid Foundry result');
  for (const suite of Object.values(parsed) as { test_results?: Record<string, { status?: string }> }[]) {
    if (!suite?.test_results || typeof suite.test_results !== 'object') throw new Error('missing Foundry test results');
    for (const test of Object.values(suite.test_results)) {
      if (test.status === 'Success') result.passed++;
      else if (test.status === 'Failure') result.failed++;
      else if (test.status === 'Skipped') result.skipped++;
      else throw new Error('unknown Foundry test status');
      result.total++;
    }
  }
  if (!result.total) throw new Error('empty Foundry test run');
  return result;
}
export function nodeSummary(raw: string): TestEvidence['typescript'] {
  const roots = raw.trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'test:summary' && event.data && !Object.hasOwn(event.data, 'file'));
  if (roots.length !== 1) throw new Error('expected one root Node test summary');
  const data = roots[0].data;
  const { passed, failed, skipped, cancelled, todo, tests: total } = data.counts ?? {};
  const result = { passed, failed, skipped, cancelled, todo, total };
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0) || total < 1
    || passed + failed + skipped + cancelled + todo !== total || data.success !== (failed === 0 && cancelled === 0)) throw new Error('inconsistent Node test summary');
  return result;
}
export function verifyTestEvidence(value: unknown, expectedFingerprint: string, expectedFiles: string[], now = Date.now()): TestEvidence {
  const e = value as TestEvidence;
  if (!e || e.version !== 1 || e.sourceFingerprint !== expectedFingerprint) throw new Error('test evidence absent or source fingerprint differs');
  if (!Number.isSafeInteger(e.startedAt) || e.startedAt < 0 || !Number.isSafeInteger(e.completedAt) || e.startedAt > e.completedAt
    || e.completedAt > now || now - e.completedAt > 86_400_000) throw new Error('test evidence time invalid or older than 24 hours');
  if (typeof e.nodeVersion !== 'string' || !e.nodeVersion || typeof e.forgeVersion !== 'string' || !e.forgeVersion
    || JSON.stringify(e.testFiles) !== JSON.stringify(expectedFiles)) throw new Error('test evidence tools/files incomplete');
  for (const group of [e.solidity, e.typescript]) {
    if (!group || !Number.isSafeInteger(group.total) || group.total < 1 || group.passed !== group.total
      || group.failed !== 0 || group.skipped !== 0) throw new Error('test evidence contains non-passing or missing tests');
  }
  if (e.typescript.cancelled !== 0 || e.typescript.todo !== 0) throw new Error('test evidence contains cancelled/todo tests');
  return e;
}
