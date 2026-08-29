/**
 * Matching: token blocking index plus an order-independent score.
 *
 * Two rules shape this:
 *  1) cast a wide net for recall, then narrow the blocking decision with corroboration.
 *  2) romanised expansion is our inference, so it cannot block on its own.
 */
import { normalizeName, tokenize, contentTokens } from './normalize.js';
import { romanizeVariants, hasHangul } from './romanize.js';
import type { SanctionEntry } from './ingest/parse.js';
import type { ScreeningHit, MatchType } from './types.js';

export interface IndexedName {
  entryIdx: number;
  norm: string;
  tokens: string[];
  isAlias: boolean;
}

export interface Corpus {
  entries: SanctionEntry[];
  names: IndexedName[];
  /** Token to name-index list. The only thing keeping this off a 78k x N comparison. */
  byToken: Map<string, number[]>;
  /** Lowercase EVM address to entry index */
  byWallet: Map<string, number>;
}

/** Common tokens make poor blocking keys. They pull in thousands of candidates. */
const STOP_TOKENS = new Set(['al','bin','abu','mohammad','mohamed','muhammad','ahmad','ahmed','ali','hassan','hussein','abd','abdul','company','co','ltd','limited','llc','inc','corp','trading','general','international','group','holding','bank','oil','gas','shipping']);

export function buildCorpus(entries: SanctionEntry[]): Corpus {
  const names: IndexedName[] = [];
  const byToken = new Map<string, number[]>();
  const byWallet = new Map<string, number>();

  entries.forEach((e, ei) => {
    for (const a of e.cryptoAddresses) if (/^0x[0-9a-f]{40}$/.test(a)) byWallet.set(a, ei);
    e.names.forEach((raw, ni) => {
      const norm = normalizeName(raw);
      if (!norm) return;
      const toks = contentTokens(tokenize(norm));
      if (!toks.length) return;
      const idx = names.length;
      names.push({ entryIdx: ei, norm, tokens: toks, isAlias: ni > 0 });
      for (const t of new Set(toks)) {
        if (STOP_TOKENS.has(t)) continue;
        let l = byToken.get(t); if (!l) { l = []; byToken.set(t, l); }
        l.push(idx);
      }
    });
  });
  return { entries, names, byToken, byWallet };
}

/** Jaccard plus a containment bonus. Word order does not matter. */
export function nameScore(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  if (inter === 0) return 0;
  const jac = inter / (A.size + B.size - inter);
  // Give the containment bonus only when the smaller side has three or more tokens.
  // With two tokens on each side containment hits 1.0 and a common fragment like 'ji' scores
  // full marks. Every one of the 33% false positives on Korean names came from this.
  const small = Math.min(A.size, B.size);
  if (small < 3) return jac;
  const contain = (inter / small) * 0.95;
  // Discount the bonus when the lengths differ a lot. Two tokens inside six is usually chance.
  const ratio = small / Math.max(A.size, B.size);
  return Math.max(jac, contain * (0.6 + 0.4 * ratio));
}

export interface Candidate {
  entry: SanctionEntry;
  matchedName: string;
  score: number;
  matchType: MatchType;
}

/** Narrow with blocking, then score. Anything under minScore is dropped. */
function candidatesFor(corpus: Corpus, tokens: string[], matchType: MatchType, minScore: number): Candidate[] {
  const counts = new Map<number, number>();
  for (const t of new Set(tokens)) {
    const l = corpus.byToken.get(t); if (!l) continue;
    if (l.length > 4000) continue;   // skip tokens that are too common to narrow anything
    for (const ni of l) counts.set(ni, (counts.get(ni) ?? 0) + 1);
  }
  const best = new Map<number, Candidate>();
  for (const [ni] of counts) {
    const n = corpus.names[ni];
    const s = nameScore(tokens, n.tokens);
    if (s < minScore) continue;
    const prev = best.get(n.entryIdx);
    if (!prev || s > prev.score) {
      best.set(n.entryIdx, {
        entry: corpus.entries[n.entryIdx], matchedName: n.norm, score: s,
        matchType: n.isAlias && matchType === 'fuzzy' ? 'alias' : matchType,
      });
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, 50);
}

export interface MatchInput {
  fullName: string;
  romanizedName?: string;
  dob: string | null;
  nationality: string;
  walletAddress: string;
}

/** Date of birth comparison. List entries that carry only a year match at year granularity. */
function dobCorroborates(subject: string | null, entryDobs: string[]): boolean {
  if (!subject || entryDobs.length === 0) return false;
  const sy = subject.slice(0, 4);
  return entryDobs.some(d => d === subject || (d.length === 4 && d === sy) || d.slice(0, 4) === sy);
}

export function screenNames(corpus: Corpus, input: MatchInput): ScreeningHit[] {
  const hits: ScreeningHit[] = [];
  const seen = new Set<string>();

  const push = (c: Candidate, type: MatchType, inferred: boolean) => {
    const key = `${c.entry.listId}:${c.entry.entryId}`;
    const corro: ('dob' | 'nationality' | 'wallet')[] = [];
    if (dobCorroborates(input.dob, c.entry.dobs)) corro.push('dob');
    if (input.nationality && c.entry.countries.includes(input.nationality)) corro.push('nationality');
    // A hit found through expansion is an inference, so it needs corroboration to count
    const corroborated = inferred ? corro.length > 0 : true;
    const prev = hits.find(h => `${h.listId}:${h.entryId}` === key);
    if (prev) {
      if (c.score > prev.score) { prev.score = c.score; prev.matchType = type; }
      if (corroborated) { prev.corroborated = true; prev.corroboration = corro; }
      return;
    }
    seen.add(key);
    hits.push({
      listId: c.entry.listId, listVersion: 0, entryId: c.entry.entryId,
      matchedName: c.matchedName, score: Number(c.score.toFixed(3)), matchType: type,
      corroborated, corroboration: corro.length ? corro : undefined,
    });
  };

  // 1. wallet address, the strongest signal and not an inference
  const w = (input.walletAddress ?? '').toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(w)) {
    const ei = corpus.byWallet.get(w);
    if (ei !== undefined) {
      const e = corpus.entries[ei];
      hits.push({
        listId: e.listId, listVersion: 0, entryId: e.entryId, matchedName: e.primaryName,
        score: 1, matchType: 'wallet', corroborated: true, corroboration: ['wallet'],
      });
      seen.add(`${e.listId}:${e.entryId}`);
    }
  }

  // 2. the name as written
  const givenNorm = normalizeName(input.romanizedName || input.fullName);
  const givenToks = contentTokens(tokenize(givenNorm));
  if (givenToks.length) {
    for (const c of candidatesFor(corpus, givenToks, 'fuzzy', 0.72)) {
      push(c, c.score >= 0.999 ? 'exact' : c.matchType, false);
    }
  }

  // 3. romanised expansion for Hangul input, marked inferred
  if (hasHangul(input.fullName)) {
    for (const v of romanizeVariants(input.fullName)) {
      const toks = contentTokens(tokenize(normalizeName(v)));
      if (!toks.length) continue;
      for (const c of candidatesFor(corpus, toks, 'romanized', 0.85)) push(c, 'romanized', true);
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 25);
}
