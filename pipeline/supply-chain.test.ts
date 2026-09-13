import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertActionPins, assertSourceBaseline, inspectLock, sbomSummary, sha256 } from './supply-chain.js';

const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz', integrity, license: 'MIT' };
const fixture = () => ({ lockfileVersion: 3, packages: { '': { dependencies: { demo: '^1.0.0' } }, 'node_modules/demo': { ...entry } } });

test('inventory validates registry/integrity, metadata and direct resolution rather than audit counts', () => {
  const f = fixture(); const result = inspectLock(f);
  assert.deepEqual(result.issues, []); assert.equal(result.direct[0].resolvedVersion, '1.0.0');
  for (const changed of [{ resolved: 'http://registry.npmjs.org/x' }, { resolved: 'https://user:secret@registry.npmjs.org/x' },
    { resolved: 'https://unreviewed.invalid/x' }, { integrity: 'sha512-AA==' }, { version: '' }, { license: '' }, { link: true }]) {
    assert.ok(inspectLock({ ...f, packages: { ...f.packages, 'node_modules/demo': { ...entry, ...changed } } }).issues.length);
  }
  assert.throws(() => inspectLock({ ...f, lockfileVersion: 1 }));
});

test('bundled platform packages retain enclosing tarball binding rather than invented individual integrity', () => {
  const f = fixture();
  const nested = 'node_modules/demo/node_modules/nested';
  const input = { ...f, packages: { ...f.packages, [nested]: { version: '2.0.0', license: 'MIT', inBundle: true } } };
  const r = inspectLock(input); assert.deepEqual(r.issues, []);
  assert.equal(r.packages.find(p => p.path === nested)?.enclosingTarball, 'node_modules/demo');
  assert.equal(r.packages.find(p => p.path === nested)?.integrity, null);
  assert.ok(inspectLock({ ...input, packages: { '': {}, [nested]: input.packages[nested] } }).issues.length);
});

test('critical source or dependency drift blocks until an explicit new review baseline', () => {
  const expected = { 'src/ASCBaseX.sol': sha256('old upstream semantics') };
  assert.doesNotThrow(() => assertSourceBaseline(expected, { ...expected }));
  assert.throws(() => assertSourceBaseline(expected, { 'src/ASCBaseX.sol': sha256('upgraded SDK semantics') }), /review required/);
  assert.throws(() => assertSourceBaseline(expected, {}), /missing/);
  assert.throws(() => assertSourceBaseline({}, {}), /empty/);
});

test('SBOM scope and non-baseline license expressions stay visible without legal approval', () => {
  const b = { bomFormat: 'CycloneDX', specVersion: '1.5', dependencies: [], components: [
    { name: 'copyleft', version: '1', scope: 'optional', licenses: [{ expression: 'Apache-2.0 AND LGPL-3.0-or-later' }] },
    { name: 'unknown', version: '1' }, { name: 'mit', version: '1', licenses: [{ license: { id: 'MIT' } }] },
  ] };
  const r = sbomSummary(b); assert.deepEqual(r.missingLicense, ['unknown@1']); assert.equal(r.licenseReview[0].scope, 'optional');
  assert.equal(r.licenseReview.length, 1);
  assert.throws(() => sbomSummary({ ...b, components: [] }), /empty/);
});

test('workflow gates reject moving tags and unreviewed action commits', () => {
  assertActionPins('  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1');
  for (const ref of ['actions/checkout@v7', 'actions/checkout@' + '1'.repeat(40), 'other/repo@' + '1'.repeat(40)]) {
    assert.throws(() => assertActionPins(`- uses: ${ref}`), /unreviewed or floating/);
  }
});
