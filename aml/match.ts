/**
 * 매칭 — 토큰 블로킹 인덱스 + 어순 무관 점수.
 *
 * 설계 원칙 두 가지:
 *  1) 재현율 우선으로 후보를 넓게 잡고, 차단 결정은 뒷받침(corroboration)으로 좁힌다.
 *  2) 로마자 전개는 우리가 만든 추론이므로 단독 차단 근거가 되지 못한다.
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
  /** 토큰 → 이름 인덱스 목록. 전수 비교(78k×N)를 피하는 유일한 수단. */
  byToken: Map<string, number[]>;
  /** 소문자 EVM 주소 → 엔트리 인덱스 */
  byWallet: Map<string, number>;
}

/** 흔한 토큰은 블로킹 키로 쓸모가 없다 — 후보를 수천 개로 부풀린다. */
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

/** 자카드 + 완전포함 보정. 어순에 의존하지 않는다. */
export function nameScore(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  if (inter === 0) return 0;
  const jac = inter / (A.size + B.size - inter);
  // 포함 보정은 **짧은 쪽이 3토큰 이상**일 때만 준다.
  // 2토큰끼리 겹치면 contain=1.0 이 되어 'ji' 같은 흔한 조각이 만점을 받는다 —
  // 한국 이름 평가에서 오탐 33%가 전부 여기서 나왔다.
  const small = Math.min(A.size, B.size);
  if (small < 3) return jac;
  const contain = (inter / small) * 0.95;
  // 길이 차가 크면 포함 보정을 깎는다 (2토큰 ⊂ 6토큰은 우연일 확률이 높다)
  const ratio = small / Math.max(A.size, B.size);
  return Math.max(jac, contain * (0.6 + 0.4 * ratio));
}

export interface Candidate {
  entry: SanctionEntry;
  matchedName: string;
  score: number;
  matchType: MatchType;
}

/** 블로킹으로 후보를 좁힌 뒤 점수. minScore 미만은 버린다. */
function candidatesFor(corpus: Corpus, tokens: string[], matchType: MatchType, minScore: number): Candidate[] {
  const counts = new Map<number, number>();
  for (const t of new Set(tokens)) {
    const l = corpus.byToken.get(t); if (!l) continue;
    if (l.length > 4000) continue;                      // 과도하게 흔한 토큰은 건너뛴다
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

/** 생년월일 대조 — 연도만 있는 명단 항목도 연 단위로 맞춘다. */
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
    // 전개 표기(추론)로 잡힌 적중은 뒷받침이 있어야 확정으로 본다
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

  // ① 지갑 주소 — 가장 강한 신호. 추론이 아니다.
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

  // ② 표기된 이름 그대로
  const givenNorm = normalizeName(input.romanizedName || input.fullName);
  const givenToks = contentTokens(tokenize(givenNorm));
  if (givenToks.length) {
    for (const c of candidatesFor(corpus, givenToks, 'fuzzy', 0.72)) {
      push(c, c.score >= 0.999 ? 'exact' : c.matchType, false);
    }
  }

  // ③ 한글이면 로마자 전개 — 추론이므로 inferred=true
  if (hasHangul(input.fullName)) {
    for (const v of romanizeVariants(input.fullName)) {
      const toks = contentTokens(tokenize(normalizeName(v)));
      if (!toks.length) continue;
      for (const c of candidatesFor(corpus, toks, 'romanized', 0.85)) push(c, 'romanized', true);
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 25);
}
