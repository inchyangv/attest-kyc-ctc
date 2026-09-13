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
import { compareIdentity, identityConflicts, identityUnusable } from './identity.js';
import { deletionKeys, editGrams, editNameScore, missingTokenNameScore, withinOneEdit, withinSupportedEdits } from './edit-distance.js';

export class AmlMatchCapacityError extends Error {
  readonly code = 'AML_MATCH_CAPACITY';
  constructor(boundary: string) { super(`AML_MATCH_CAPACITY: ${boundary}`); this.name = 'AmlMatchCapacityError'; }
}

export interface MatchLimits {
  maxIndexNames: number;
  maxIndexTokenPostings: number;
  maxIndexGramPostings: number;
  maxQueryTokens: number;
  maxQueryTokenPostings: number;
  maxVocabularyCandidates: number;
  maxCandidateNames: number;
}
export const DEFAULT_MATCH_LIMITS: MatchLimits = {
  maxIndexNames: 250_000, maxIndexTokenPostings: 1_500_000, maxIndexGramPostings: 3_000_000,
  maxQueryTokens: 64, maxQueryTokenPostings: 300_000, maxVocabularyCandidates: 100_000, maxCandidateNames: 100_000,
};
const limitsOf = (overrides: Partial<MatchLimits> = {}): MatchLimits => {
  const limits = { ...DEFAULT_MATCH_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid AML match limit: ${key}`);
  return limits;
};

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
  /** Shared deletion signature -> distinct vocabulary tokens, verified before use. */
  byDeletion: Map<string, string[]>;
  /** Boundary bigram -> distinct tokens eligible for verified two-edit matching. */
  byGram: Map<string, string[]>;
  limits: MatchLimits;
  /** Lowercase EVM address to entry index */
  byWallet: Map<string, number>;
}

export function buildCorpus(entries: SanctionEntry[], limitOverrides: Partial<MatchLimits> = {}): Corpus {
  const limits = limitsOf(limitOverrides);
  const names: IndexedName[] = [];
  const byToken = new Map<string, number[]>();
  const byWallet = new Map<string, number>();
  const byDeletion = new Map<string, string[]>();
  const byGram = new Map<string, string[]>();
  let tokenPostings = 0, gramPostings = 0;

  entries.forEach((e, ei) => {
    for (const a of e.cryptoAddresses) if (/^0x[0-9a-fA-F]{40}$/.test(a)) byWallet.set(a.toLowerCase(), ei);
    e.names.forEach((raw, ni) => {
      const norm = normalizeName(raw);
      if (!norm) return;
      const toks = contentTokens(tokenize(norm));
      if (!toks.length) return;
      const idx = names.length;
      names.push({ entryIdx: ei, norm, tokens: toks, isAlias: ni > 0 });
      if (names.length > limits.maxIndexNames) throw new AmlMatchCapacityError('index names');
      for (const t of new Set(toks)) {
        let l = byToken.get(t); if (!l) { l = []; byToken.set(t, l); }
        l.push(idx); if (++tokenPostings > limits.maxIndexTokenPostings) throw new AmlMatchCapacityError('index token postings');
      }
    });
  });
  for (const token of byToken.keys()) for (const key of deletionKeys(token)) {
    let list = byDeletion.get(key); if (!list) { list = []; byDeletion.set(key, list); }
    list.push(token);
  }
  for (const token of byToken.keys()) for (const gram of editGrams(token)) {
    let list = byGram.get(gram); if (!list) { list = []; byGram.set(gram, list); }
    list.push(token); if (++gramPostings > limits.maxIndexGramPostings) throw new AmlMatchCapacityError('index gram postings');
  }
  return { entries, names, byToken, byDeletion, byGram, limits, byWallet };
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
  if (tokens.length > corpus.limits.maxQueryTokens) throw new AmlMatchCapacityError('query tokens');
  const candidateNames = new Set<number>();
  const matchingTokens = new Set(tokens);
  let postingVisits = 0;
  // Inferred romanization retains its separate, exact-token rule; do not compound two
  // inference layers without an independently evaluated multilingual policy.
  if (matchType !== 'romanized') for (const token of new Set(tokens)) {
    for (const key of deletionKeys(token)) for (const near of corpus.byDeletion.get(key) ?? []) {
      if (++postingVisits > corpus.limits.maxQueryTokenPostings) throw new AmlMatchCapacityError('query token postings');
      if (withinOneEdit(token, near)) matchingTokens.add(near);
    }
    const vocabulary = new Set<string>();
    for (const gram of editGrams(token)) for (const near of corpus.byGram.get(gram) ?? []) {
      if (++postingVisits > corpus.limits.maxQueryTokenPostings) throw new AmlMatchCapacityError('query token postings');
      vocabulary.add(near);
      if (vocabulary.size > corpus.limits.maxVocabularyCandidates) throw new AmlMatchCapacityError('query vocabulary candidates');
    }
    for (const near of vocabulary) if (withinSupportedEdits(token, near)) matchingTokens.add(near);
  }
  for (const t of matchingTokens) {
    const l = corpus.byToken.get(t); if (!l) continue;
    postingVisits += l.length;
    if (postingVisits > corpus.limits.maxQueryTokenPostings) throw new AmlMatchCapacityError('query token postings');
    for (const ni of l) {
      candidateNames.add(ni);
      if (candidateNames.size > corpus.limits.maxCandidateNames) throw new AmlMatchCapacityError('query candidate names');
    }
  }
  const best = new Map<number, Candidate>();
  for (const ni of candidateNames) {
    const n = corpus.names[ni];
    const s = Math.max(nameScore(tokens, n.tokens), matchType === 'romanized' ? 0 : editNameScore(tokens, n.tokens),
      matchType === 'romanized' ? 0 : missingTokenNameScore(tokens, n.tokens));
    if (s < minScore) continue;
    const prev = best.get(n.entryIdx);
    if (!prev || s > prev.score) {
      best.set(n.entryIdx, {
        entry: corpus.entries[n.entryIdx], matchedName: n.norm, score: s,
        matchType: n.isAlias && matchType === 'fuzzy' ? 'alias' : matchType,
      });
    }
  }
  // Do not truncate before identity comparison: the only corroborated entry may be last.
  return [...best.values()].sort((x, y) => y.score - x.score);
}

export interface MatchInput {
  fullName: string;
  romanizedName?: string;
  dob: string | null;
  nationality: string;
  walletAddress: string;
}

export function screenNames(corpus: Corpus, input: MatchInput): ScreeningHit[] {
  const hits: ScreeningHit[] = [];
  const byEntry = new Map<string, ScreeningHit>();

  const push = (c: Candidate, type: MatchType) => {
    const key = `${c.entry.listId}:${c.entry.entryId}`;
    const identityComparison = compareIdentity(input.dob, input.nationality, c.entry.dobs, c.entry.countries);
    const corro: ('dob' | 'nationality' | 'wallet')[] = [];
    if (identityComparison.dob === 'match' || identityComparison.dob === 'year-match') corro.push('dob');
    if (identityComparison.nationality === 'match') corro.push('nationality');
    const corroborated = corro.length > 0 && !identityConflicts(identityComparison) && !identityUnusable(identityComparison);
    const prev = byEntry.get(key);
    if (prev) {
      if (prev.matchType === 'wallet') return; // weaker name evidence must not rewrite wallet support
      if (type === 'romanized') prev.inferredNameScore = Math.max(prev.inferredNameScore ?? 0, c.score);
      else prev.directNameScore = Math.max(prev.directNameScore ?? 0, c.score);
      if (c.score > prev.score) { prev.score = c.score; prev.matchType = type; prev.matchedName = c.matchedName; }
      return;
    }
    const hit: ScreeningHit = {
      listId: c.entry.listId, listVersion: 0, entryId: c.entry.entryId,
      matchedName: c.matchedName, score: Number(c.score.toFixed(3)), matchType: type,
      corroborated, corroboration: corro.length ? corro : undefined, identityComparison,
      ...(type === 'romanized' ? { inferredNameScore: c.score } : { directNameScore: c.score }),
    };
    hits.push(hit); byEntry.set(key, hit);
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
      // Keep name evidence separate: a wallet hit must neither erase a name failure nor
      // lend its corroboration to an unrelated name comparison on the same list entry.
      byEntry.set(`${e.listId}:${e.entryId}:wallet`, hits.at(-1)!);
    }
  }

  // 2. the name as written
  // User-supplied romanization supplements, rather than suppresses, the original name.
  for (const supplied of new Set([input.fullName, input.romanizedName].filter((v): v is string => !!v))) {
    const givenNorm = normalizeName(supplied);
    const givenToks = contentTokens(tokenize(givenNorm));
    if (givenToks.length) {
      for (const c of candidatesFor(corpus, givenToks, 'fuzzy', 0.72)) {
        push(c, c.score >= 0.999 ? 'exact' : c.matchType);
      }
    }
  }

  // 3. romanised expansion for Hangul input, marked inferred
  if (hasHangul(input.fullName)) {
    for (const v of romanizeVariants(input.fullName)) {
      const toks = contentTokens(tokenize(normalizeName(v)));
      if (!toks.length) continue;
      for (const c of candidatesFor(corpus, toks, 'romanized', 0.85)) push(c, 'romanized');
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}
