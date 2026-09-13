import { EvidenceVault, type VaultRecord } from '../../pipeline/vault.js';

const path = process.env.SYNTHETIC_VAULT_PATH;
const key = process.env.SYNTHETIC_VAULT_KEY;
const role = process.env.SYNTHETIC_VAULT_ROLE;
if (!path || !key || !role || !process.send) throw new Error('synthetic concurrent vault fixture is incomplete');

const vault = new EvidenceVault(path, key);
let expected: VaultRecord | undefined;
let revision: string | undefined;
if (role === 'rescreen') expected = vault.get('rescreen');
if (role === 'appeal') revision = vault.reviewSnapshot('appeal').revision;
process.send({ state: 'ready', role });

process.once('message', (message) => {
  if (message !== 'go') throw new Error('unexpected fixture command');
  try {
    if (role === 'api') {
      const record = vault.get('template');
      if (!record) throw new Error('missing template');
      vault.put({ ...record, id: 'api-created' });
    } else if (role === 'rescreen') {
      if (!expected) throw new Error('missing rescreen snapshot');
      vault.recordRescreen('rescreen', { at: 2_000, decision: 'REVIEW', reason: 'SYNTHETIC-CONCURRENT-REVIEW', listVersions: { synthetic: 2 } }, expected);
    } else if (role === 'appeal') {
      if (!revision) throw new Error('missing appeal revision');
      vault.decideReview('appeal', { at: 2_000, operator: 'synthetic-appeal', outcome: 'cleared', reason: 'SYNTHETIC-APPEAL' }, revision);
    } else if (role === 'purge') {
      if (vault.purgeExpired(2_000) !== 1) throw new Error('expected one approved purge');
    } else throw new Error('unknown fixture role');
    process.send!({ state: 'complete', role });
  } catch (error) {
    process.send!({ state: 'failed', role, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
});
