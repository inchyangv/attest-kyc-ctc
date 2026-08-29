/**
 * Deterministic serialisation.
 *
 * The evidence chain only works if the same input always produces the same bytes.
 * An auditor recomputes `evidenceHash` from their copy and compares it to the on-chain value.
 * `JSON.stringify` follows insertion order for object keys, so it cannot be used as is.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error('canonicalJson: non-finite numbers cannot go into evidence');
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v instanceof Date) throw new Error('canonicalJson: use an epoch integer instead of a Date');

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortDeep((v as Record<string, unknown>)[k]);
  }
  return out;
}
