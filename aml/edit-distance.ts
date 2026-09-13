/** Bounded Unicode-code-point edit retrieval. This is not a phonetic/transliteration model.
 * Short tokens stay exact-only and 4-5 point tokens stay single-edit-only: two changes in a
 * short name are too permissive without an independently approved model. */
export const MIN_EDIT_TOKEN = 4;
export const MIN_TWO_EDIT_TOKEN = 6;
export const MAX_EDIT_TOKEN = 64;
// normalizeName emits NFD. Recompose before counting/editing: a three-syllable Korean name
// must not become an eight-to-nine-character token merely because its jamo are decomposed.
const codePoints = (token: string) => Array.from(token.normalize('NFC'));

export function deletionKeys(token: string): string[] {
  const chars = codePoints(token);
  if (chars.length < MIN_EDIT_TOKEN || chars.length > MAX_EDIT_TOKEN) return [];
  return [...new Set([chars.join(''), ...chars.map((_, i) => chars.slice(0, i).concat(chars.slice(i + 1)).join(''))])];
}

export function supportedEditLimit(token: string): 0 | 1 | 2 {
  const length = codePoints(token).length;
  return length < MIN_EDIT_TOKEN || length > MAX_EDIT_TOKEN ? 0 : length < MIN_TWO_EDIT_TOKEN ? 1 : 2;
}

/** Restricted Damerau-Levenshtein (optimal-string-alignment) distance, capped at maxDistance+1. */
export function boundedEditDistance(left: string, right: string, maxDistance = 2): number {
  const a = codePoints(left), b = codePoints(right);
  if (!Number.isSafeInteger(maxDistance) || maxDistance < 0) throw new Error('invalid edit-distance bound');
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = maxDistance + 1;
    for (let j = 1; j <= b.length; j++) {
      const substitution = rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
      if (Math.abs(i - j) <= maxDistance) rowMin = Math.min(rowMin, rows[i][j]);
    }
    if (rowMin > maxDistance && i > b.length + maxDistance) return maxDistance + 1;
  }
  return Math.min(rows[a.length][b.length], maxDistance + 1);
}

/** Boundary bigrams retrieve two-edit candidates; the distance verifier remains authoritative. */
export function editGrams(token: string): string[] {
  if (supportedEditLimit(token) < 2) return [];
  const chars = ['^', ...codePoints(token), '$'];
  return [...new Set(chars.slice(0, -1).map((ch, i) => ch + chars[i + 1]))];
}

/** One insertion, deletion, substitution or adjacent transposition. */
export function withinOneEdit(left: string, right: string): boolean {
  if (left.normalize('NFC') === right.normalize('NFC')) return true;
  return supportedEditLimit(left) >= 1 && supportedEditLimit(right) >= 1 && boundedEditDistance(left, right, 1) <= 1;
}

export function withinSupportedEdits(left: string, right: string): boolean {
  if (left.normalize('NFC') === right.normalize('NFC')) return true;
  const limit = Math.min(supportedEditLimit(left), supportedEditLimit(right));
  return limit > 0 && boundedEditDistance(left, right, limit) <= limit;
}

/** Exact token pairs first, then strongest unused bounded-edit pairs. Each token contributes once.
 * This deterministic greedy score is not an optimal assignment or identity probability. */
export function editNameScore(left: string[], right: string[]): number {
  const a = [...new Set(left)], b = [...new Set(right)];
  if (!a.length || !b.length) return 0;
  const usedA = new Set<number>(), usedB = new Set<number>();
  let score = 0;
  for (let i = 0; i < a.length; i++) {
    const j = b.indexOf(a[i]);
    if (j >= 0) { usedA.add(i); usedB.add(j); score++; }
  }
  const pairs: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < a.length; i++) if (!usedA.has(i)) for (let j = 0; j < b.length; j++) if (!usedB.has(j) && withinSupportedEdits(a[i], b[j])) {
    const distance = boundedEditDistance(a[i], b[j], 2);
    pairs.push({ i, j, score: 1 - distance / Math.max(codePoints(a[i]).length, codePoints(b[j]).length) });
  }
  const compare = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  pairs.sort((x, y) => y.score - x.score || compare(a[x.i], a[y.i]) || compare(b[x.j], b[y.j]));
  for (const pair of pairs) if (!usedA.has(pair.i) && !usedB.has(pair.j)) {
    usedA.add(pair.i); usedB.add(pair.j); score += pair.score;
  }
  return score / Math.max(a.length, b.length);
}

/** One missing part among names of at least two supplied/listed parts is review-level evidence,
 * never a full-name score. Edited remaining parts are retained as sub-threshold candidates. */
export function missingTokenNameScore(left: string[], right: string[]): number {
  const a = [...new Set(left)], b = [...new Set(right)];
  if (Math.abs(a.length - b.length) !== 1 || Math.min(a.length, b.length) < 2) return 0;
  const small = a.length < b.length ? a : b, large = a.length < b.length ? b : a;
  const used = new Set<number>(); let similarity = 0;
  for (const token of small) {
    let best = -1, bestScore = -1;
    for (let j = 0; j < large.length; j++) if (!used.has(j) && withinSupportedEdits(token, large[j])) {
      const distance = boundedEditDistance(token, large[j], 2);
      const score = 1 - distance / Math.max(codePoints(token).length, codePoints(large[j]).length);
      if (score > bestScore) { best = j; bestScore = score; }
    }
    if (best < 0) return 0;
    used.add(best); similarity += bestScore;
  }
  return 0.82 * (similarity / small.length);
}
