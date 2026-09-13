/** Identity descriptors are independent of the name score. These are comparisons of supplied
 * values, not proof that a customer owns that identity or a legal sanctions determination. */
export type DobComparison = 'match' | 'year-match' | 'conflict' | 'missing' | 'invalid';
export type CountryComparison = 'match' | 'conflict' | 'missing' | 'invalid';
export interface IdentityComparison {
  dob: DobComparison;
  nationality: CountryComparison;
}

function precision(value: string): 'day' | 'year' | null {
  if (/^[1-9]\d{3}$/.test(value)) return 'year';
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? 'day' : null;
}

export function compareDob(subject: string | null, listed: string[]): DobComparison {
  if (!subject) return 'missing';
  const p = precision(subject);
  if (!p) return 'invalid';
  if (!listed.length) return 'missing';
  const valid = listed.filter(value => precision(value) !== null);
  if (!valid.length) return 'invalid';
  // Listed dates are alternatives. One exact full-date match is not contradicted by another
  // listed alternative. A year fallback applies ONLY when at least one side is year-only.
  if (p === 'day' && valid.some(value => precision(value) === 'day' && value === subject)) return 'match';
  if (valid.some(value => value.slice(0, 4) === subject.slice(0, 4) && (p === 'year' || precision(value) === 'year'))) return 'year-match';
  return 'conflict';
}

export function compareIdentity(dob: string | null, nationality: string, listedDobs: string[], listedCountries: string[]): IdentityComparison {
  let country: CountryComparison;
  if (!nationality || !listedCountries.length) country = 'missing';
  else if (!/^[A-Z]{2}$/.test(nationality) || !listedCountries.some(c => /^[A-Z]{2}$/.test(c))) country = 'invalid';
  else country = listedCountries.includes(nationality) ? 'match' : 'conflict';
  return { dob: compareDob(dob, listedDobs), nationality: country };
}

export const identityConflicts = (c: IdentityComparison) => c.dob === 'conflict' || c.nationality === 'conflict';
export const identityUnusable = (c: IdentityComparison) => c.dob === 'invalid' || c.nationality === 'invalid';
