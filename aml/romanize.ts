/**
 * Hangul to romanised forms.
 *
 * What this produces is our inference, not something any list asserts.
 * A hit found through expansion is marked corroborated=false and never blocks without
 * support from a date of birth or a country.
 *
 * Why: strip the diacritics and both yeong and yong collapse to yong, which once scored
 * Choi Yeong-ho at 100 against a different listed person, Choi Yong-ho.
 */

const CHO = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const JUNG = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const JONG = ['','k','k','k','n','n','n','t','l','l','l','l','l','l','l','l','m','p','p','t','t','ng','t','t','k','t','p','t'];

/** Surnames as people actually spell them. These differ from the RR rules. */
const SURNAME_VARIANTS: Record<string, string[]> = {
  '김': ['kim','gim'],           '이': ['lee','yi','rhee','ri','i'],
  '박': ['park','pak','bak'],    '최': ['choi','choe','chwe'],
  '정': ['jung','jeong','chung','jong'], '강': ['kang','gang'],
  '조': ['cho','jo'],            '윤': ['yoon','yun'],
  '장': ['jang','chang'],        '임': ['lim','im','rim'],
  '한': ['han'],                 '오': ['oh','o'],
  '서': ['seo','suh','so'],      '신': ['shin','sin'],
  '권': ['kwon','gwon'],         '황': ['hwang'],
  '안': ['ahn','an'],            '송': ['song'],
  '전': ['jeon','jun','chun'],   '홍': ['hong'],
  '유': ['yoo','yu','ryu'],      '고': ['ko','go'],
  '문': ['moon','mun'],          '양': ['yang'],
  '손': ['son','sohn'],          '배': ['bae','pae'],
  '백': ['baek','paek','back'],  '노': ['noh','no','roh'],
  '허': ['heo','hur','huh'],     '심': ['shim','sim'],
};

/** DPRK official spellings. International lists carry these forms. */
const DPRK_VARIANTS: Record<string, string[]> = {
  '김': ['kim'], '리': ['ri','li','lee'], '박': ['pak'], '최': ['choe'],
  '정': ['jong','jung'], '주': ['ju','chu'], '은': ['un','eun'], '일': ['il'],
  '성': ['song','sung'], '철': ['chol','cheol'], '영': ['yong','young'], '남': ['nam'],
};

function isHangulSyllable(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 0xAC00 && c <= 0xD7A3;
}

/** One syllable to its RR form */
function syllableRR(ch: string): string {
  const c = ch.charCodeAt(0) - 0xAC00;
  const cho = Math.floor(c / (21 * 28));
  const jung = Math.floor((c % (21 * 28)) / 28);
  const jong = c % 28;
  return CHO[cho] + JUNG[jung] + JONG[jong];
}

export function hasHangul(s: string): boolean {
  return [...s].some(isHangulSyllable);
}

/**
 * A Hangul name to the set of plausible romanised forms.
 * Assumes a one-syllable surname and the rest as a given name, the dominant Korean shape.
 * Two-syllable surnames also get a whole-name RR form so they are not missed.
 */
export function romanizeVariants(name: string): string[] {
  const chars = [...name.replace(/\s+/g, '')].filter(isHangulSyllable);
  if (chars.length === 0) return [];

  const out = new Set<string>();
  const surname = chars[0];
  const given = chars.slice(1);

  const surnameForms = new Set<string>([syllableRR(surname)]);
  for (const v of SURNAME_VARIANTS[surname] ?? []) surnameForms.add(v);
  for (const v of DPRK_VARIANTS[surname] ?? []) surnameForms.add(v);

  // Given name: per-syllable RR combined with DPRK spellings
  const givenForms = new Set<string>();
  if (given.length) {
    givenForms.add(given.map(syllableRR).join(''));
    givenForms.add(given.map(syllableRR).join(' '));
    givenForms.add(given.map(syllableRR).join('-'));
    const alts = given.map(g => [syllableRR(g), ...(DPRK_VARIANTS[g] ?? [])]);
    for (const combo of cartesian(alts)) {
      givenForms.add(combo.join(''));
      givenForms.add(combo.join(' '));
      givenForms.add(combo.join('-'));
    }
  }

  for (const s of surnameForms) {
    if (givenForms.size === 0) { out.add(s); continue; }
    for (const g of givenForms) {
      out.add(`${s} ${g}`);   // Kim Jong Un
      out.add(`${g} ${s}`);   // Jong Un Kim, western order
    }
  }
  out.add(chars.map(syllableRR).join(''));   // whole-name form, for two-syllable surnames
  return [...out];
}

function cartesian(arrs: string[][]): string[][] {
  if (arrs.length === 0) return [[]];
  if (arrs.length > 4) arrs = arrs.slice(0, 4);   // cap the combinatorial blowup
  return arrs.reduce<string[][]>((acc, cur) => {
    const next: string[][] = [];
    for (const a of acc) for (const c of cur) next.push([...a, c]);
    return next;
  }, [[]]);
}
