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
  '\uAE40': ['kim','gim'],           '\uC774': ['lee','yi','rhee','ri','i'],
  '\uBC15': ['park','pak','bak'],    '\uCD5C': ['choi','choe','chwe'],
  '\uC815': ['jung','jeong','chung','jong'], '\uAC15': ['kang','gang'],
  '\uC870': ['cho','jo'],            '\uC724': ['yoon','yun'],
  '\uC7A5': ['jang','chang'],        '\uC784': ['lim','im','rim'],
  '\uD55C': ['han'],                 '\uC624': ['oh','o'],
  '\uC11C': ['seo','suh','so'],      '\uC2E0': ['shin','sin'],
  '\uAD8C': ['kwon','gwon'],         '\uD669': ['hwang'],
  '\uC548': ['ahn','an'],            '\uC1A1': ['song'],
  '\uC804': ['jeon','jun','chun'],   '\uD64D': ['hong'],
  '\uC720': ['yoo','yu','ryu'],      '\uACE0': ['ko','go'],
  '\uBB38': ['moon','mun'],          '\uC591': ['yang'],
  '\uC190': ['son','sohn'],          '\uBC30': ['bae','pae'],
  '\uBC31': ['baek','paek','back'],  '\uB178': ['noh','no','roh'],
  '\uD5C8': ['heo','hur','huh'],     '\uC2EC': ['shim','sim'],
};

/** DPRK official spellings. International lists carry these forms. */
const DPRK_VARIANTS: Record<string, string[]> = {
  '\uAE40': ['kim'], '\uB9AC': ['ri','li','lee'], '\uBC15': ['pak'], '\uCD5C': ['choe'],
  '\uC815': ['jong','jung'], '\uC8FC': ['ju','chu'], '\uC740': ['un','eun'], '\uC77C': ['il'],
  '\uC131': ['song','sung'], '\uCCA0': ['chol','cheol'], '\uC601': ['yong','young'], '\uB0A8': ['nam'],
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
