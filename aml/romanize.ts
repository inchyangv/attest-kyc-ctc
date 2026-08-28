/**
 * 한글 → 로마자 전개.
 *
 * ⚠️ 여기서 만드는 표기는 **우리가 만든 추론**이지 명단에 실린 사실이 아니다.
 * 전개 표기로 얻은 적중은 corroborated=false 로 표시하고,
 * 생년월일이나 국가 같은 뒷받침 없이는 차단하지 않는다.
 *
 * 왜: 발음기호를 뗀 표기에서 '영'과 '용'이 모두 yong 이 되어
 *     최영호가 명단의 다른 인물 최용호와 100점 일치하는 사고가 실제로 있었다.
 */

const CHO = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const JUNG = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const JONG = ['','k','k','k','n','n','n','t','l','l','l','l','l','l','l','l','m','p','p','t','t','ng','t','t','k','t','p','t'];

/** 성씨 관용 표기 — 사람들이 실제로 쓰는 철자. RR 규칙과 다르다. */
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

/** 북한 공식 표기 관용 — 국제 명단에 이 철자로 실린다 */
const DPRK_VARIANTS: Record<string, string[]> = {
  '김': ['kim'], '리': ['ri','li','lee'], '박': ['pak'], '최': ['choe'],
  '정': ['jong','jung'], '주': ['ju','chu'], '은': ['un','eun'], '일': ['il'],
  '성': ['song','sung'], '철': ['chol','cheol'], '영': ['yong','young'], '남': ['nam'],
};

function isHangulSyllable(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 0xAC00 && c <= 0xD7A3;
}

/** 음절 하나 → RR 표기 */
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
 * 한글 이름 → 가능한 로마자 표기 집합.
 * 성 1글자 + 이름 나머지를 가정한다 (한국 이름의 지배적 형태).
 * 복성(남궁·황보 등)은 이름 전체 RR 도 함께 반환해 놓치지 않게 한다.
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

  // 이름 부분: 음절별 RR + 북한 관용 표기 조합
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
      out.add(`${g} ${s}`);   // Jong Un Kim (서구식 어순)
    }
  }
  out.add(chars.map(syllableRR).join(''));   // 복성 대비 통짜 전개
  return [...out];
}

function cartesian(arrs: string[][]): string[][] {
  if (arrs.length === 0) return [[]];
  if (arrs.length > 4) arrs = arrs.slice(0, 4);          // 조합 폭발 방지
  return arrs.reduce<string[][]>((acc, cur) => {
    const next: string[][] = [];
    for (const a of acc) for (const c of cur) next.push([...a, c]);
    return next;
  }, [[]]);
}
