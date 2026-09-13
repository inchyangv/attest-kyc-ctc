import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';

// Like the other root ABI tests, requires forge build before execution.
// Encode fixtures from the compiled contract ABI, not the parser's hand-written event definition.
const abi = new Interface(JSON.parse(readFileSync('out/ComplianceSource.sol/ComplianceSource.json', 'utf8')).abi);
const address = (s: string) => '0x' + s.repeat(20), word = (s: string) => '0x' + s.repeat(32);
const tx = word('12'), source = address('11'), issuer = address('22'), subject = address('33');
const attrs = word('44'), claims = word('55'), evidence = word('66'), blockHash = word('77');
const expected = [tx, source, source, issuer, subject, attrs, claims, evidence, '200', '6'];
const event = (name = 'MarkIssued', args: unknown[] = [subject, attrs, issuer, claims, evidence], logIndex = 5) => ({
  ...abi.encodeEventLog(abi.getEvent(name)!, args), address: source, transactionHash: tx, blockHash,
  blockNumber: '0xbe', transactionIndex: '0x2', logIndex, removed: false,
});
const receipt = (logs = [event()]) => ({ transactionHash: tx, to: source, status: '0x1', blockHash,
  blockNumber: '0xbe', transactionIndex: '0x2', logs });
const run = (body: unknown, args = expected) => spawnSync(process.execPath,
  ['script/demo-issuance.mjs', ...args], { input: JSON.stringify(body), encoding: 'utf8', timeout: 5000 });
const rejected = (body: unknown, args = expected) => {
  const result = run(body, args); assert.notEqual(result.status, 0);
  assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'FAIL: DEMO_ISSUANCE_RECEIPT_MISMATCH');
};

test('issuance receipt binds contract-ABI event bytes and returns actual receipt-local position', () => {
  const unrelated = event('MarkIssued', [address('99'), attrs, issuer, claims, evidence], 4);
  const good = run(receipt([unrelated, event()])); assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), `190 ${blockHash} 2 1`);
  assert.equal(run(receipt(), [...expected.slice(0, 8), '195', '6']).status, 0, 'inclusive depth boundary');
  rejected(receipt(), [...expected.slice(0, 8), '194', '6']);
  rejected(receipt(), [...expected.slice(0, 8), '189', '1']);
});

test('successful wrong or ambiguous source lifecycle is not accepted as the expected issuance', () => {
  rejected(receipt([]));
  for (let i = 0; i < 8; i++) {
    const wrong = [...expected]; wrong[i] = i >= 1 && i <= 4 ? address('aa') : word('aa');
    rejected(receipt(), wrong);
  }
  rejected(receipt([{ ...event(), address: address('aa') }]));
  for (const other of [event('MarkIssued', [subject, attrs, issuer, claims, evidence], 6),
    event('MarkRevoked', [subject, 2, 1], 6), event('SanctionDenied', [subject, 1, 1], 6)]) {
    rejected(receipt([event(), other]));
  }
  rejected(receipt([{ ...event(), data: event().data + '00' }]));
  rejected(receipt([{ ...event(), topics: [...event().topics, word('aa')] }]));
  rejected({ ...receipt(), status: 0 });
});

test('issuance log coordinates, order, removed status and malformed inputs fail with fixed private errors', () => {
  for (const change of [{ transactionHash: word('aa') }, { blockHash: word('aa') }, { blockNumber: 191 },
    { transactionIndex: 3 }, { logIndex: -1 }, { removed: true }, { removed: 'false' }, { data: 'PRIVATE' },
    { topics: ['PRIVATE'] }]) rejected(receipt([{ ...event(), ...change }] as ReturnType<typeof event>[]));
  rejected(receipt([event(), event('MarkIssued', [address('99'), attrs, issuer, claims, evidence], 4)]));
  for (const change of [{ transactionIndex: null }, { blockNumber: 0 }, { blockNumber: '1e3' },
    { logs: null }, { blockHash: word('00') }]) rejected({ ...receipt(), ...change });
  for (const args of [expected.slice(0, -1), [...expected.slice(0, -1), '0'], [...expected.slice(0, -1), '9007199254740992']]) {
    rejected(receipt(), args);
  }
  rejected(null); rejected({ private: 'PRIVATE'.repeat(350000) });
});
