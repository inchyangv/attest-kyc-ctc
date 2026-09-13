import { readFileSync } from 'node:fs';
import { ListBackedAmlEngine } from './engine.js';
import { readIndex, type IndexMeta } from './index-format.js';
import { assertProvenance, freshnessHoursFor, sha256, type SanctionsUse } from './provenance.js';

/** Per-process cache. Inspect actual compressed bytes each access, not mtime/inode alone.
 * Invalid replacement and missing file fail closed; never return a last-good fallback. */
export class IndexEngineCache {
  private cached?: { digest: string; engine: ListBackedAmlEngine; meta: IndexMeta; key: string; keyId: string; maxAgeHours: number };
  get(path: string, key: string, keyId: string, use: SanctionsUse = 'screen') {
    if (key.length < 32) throw new Error('EVIDENCE_HMAC_KEY is required (32+ chars)');
    const bytes = readFileSync(path), digest = sha256(bytes), maxAgeHours = freshnessHoursFor(use);
    if (!this.cached || digest !== this.cached.digest || key !== this.cached.key || keyId !== this.cached.keyId || maxAgeHours !== this.cached.maxAgeHours) {
      const { entries, meta } = readIndex(bytes);
      assertProvenance(meta.provenance, Date.now(), maxAgeHours);
      const engine = new ListBackedAmlEngine({ entries, listVersions: meta.listVersions, provenance: meta.provenance, evidenceKey: key, keyId, maxAgeHours });
      this.cached = { digest, engine, meta, key, keyId, maxAgeHours };
    }
    assertProvenance(this.cached.meta.provenance, Date.now(), maxAgeHours);
    const expected = process.env.SANCTIONS_EXPECTED_SNAPSHOT_ID;
    if (expected && expected !== this.cached.meta.provenance.snapshotId) throw new Error('sanctions snapshot differs from runtime pin');
    return { engine: this.cached.engine, meta: structuredClone(this.cached.meta) };
  }
}
