/**
 * PII leak detector, for tests.
 *
 * A plain `JSON.stringify(x).includes(name)` fails on Hangul.
 * The same characters become a different code point sequence under a different normal form:
 *
 *     NFC  U+BC15 U+C11C U+C900                       (3 code points)
 *     NFD  U+1107 U+1161 U+11A8 U+1109 ...          (8 code points, jamo decomposed)
 *
 *   The AML engine did store an NFD-normalised name in the evidence, and a naive
 *   includes() reported no leak. It was wrong.
 *   Normalise both sides to the same form before comparing.
 */
export function containsPii(haystack: unknown, needle: string): boolean {
  const hay = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  if (!hay) return false;
  for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'] as const) {
    if (hay.normalize(form).includes(needle.normalize(form))) return true;
  }
  // absorb case differences too, for romanised forms
  const lower = hay.normalize('NFKC').toLowerCase();
  if (lower.includes(needle.normalize('NFKC').toLowerCase())) return true;
  return false;
}

/** Returns the first of several values that appears, or null. */
export function findPii(haystack: unknown, needles: readonly string[]): string | null {
  for (const n of needles) if (containsPii(haystack, n)) return n;
  return null;
}
