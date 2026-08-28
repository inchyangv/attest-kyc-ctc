/**
 * 이름 정규화 — 회피 수법 방어.
 * 여기서 놓치면 명단에 있는 사람이 그냥 통과한다.
 * 규칙을 바꾸면 ENGINE_VERSION 을 올려야 한다 (증적 재현성).
 */

export const ENGINE_VERSION = 'aml-1.0.0';

/** 보이지 않는 문자 — 이름 사이에 끼워 넣어 매칭을 깨는 고전 수법 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­͏]/g;

/**
 * 동형문자(homoglyph) — 키릴/그리스 문자가 라틴처럼 보인다.
 * 'Реtrov' 의 Р 은 키릴 U+0420 이고 라틴 P 가 아니다.
 */
const HOMOGLYPH: Record<string, string> = {
  // 키릴 → 라틴
  'а':'a','в':'b','с':'c','е':'e','н':'h','к':'k','м':'m','о':'o','р':'p','т':'t','х':'x','у':'y','і':'i','ј':'j','ѕ':'s',
  'А':'a','В':'b','С':'c','Е':'e','Н':'h','К':'k','М':'m','О':'o','Р':'p','Т':'t','Х':'x','У':'y','І':'i','Ј':'j','Ѕ':'s',
  // 그리스 → 라틴
  'α':'a','β':'b','ε':'e','ι':'i','κ':'k','ν':'v','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x','Α':'a','Β':'b','Ε':'e','Ι':'i',
  'Κ':'k','Μ':'m','Ν':'n','Ο':'o','Ρ':'p','Τ':'t','Υ':'y','Χ':'x','Ζ':'z','Η':'h',
};

/** 전각 → 반각 */
function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
          .replace(/　/g, ' ');
}

function mapHomoglyphs(s: string): string {
  let out = '';
  for (const ch of s) out += HOMOGLYPH[ch] ?? ch;
  return out;
}

/**
 * 정규화 파이프라인. 순서가 중요하다 —
 * 동형문자를 라틴으로 바꾼 뒤에 발음기호를 떼야 키릴 'й' 같은 것이 새지 않는다.
 */
export function normalizeName(raw: string): string {
  let s = raw ?? '';
  s = s.replace(INVISIBLE, '');
  s = toHalfWidth(s);
  s = s.toLowerCase();
  s = mapHomoglyphs(s);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');   // 발음기호 제거
  s = s.replace(/[''`´ʻʼ]/g, "'");
  s = s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ');                 // 구두점 → 공백
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 어순 무관 매칭을 위한 토큰. 한 글자 토큰은 이니셜이라 버리지 않는다. */
export function tokenize(normalized: string): string[] {
  return normalized.split(/[\s'-]+/).filter(t => t.length > 0);
}

/** 이름 접두·접미의 경칭/호칭 — 매칭 잡음이라 제거 대상으로 표시만 한다 */
const TITLES = new Set(['mr','mrs','ms','dr','prof','sheikh','haji','al','el','bin','ibn','abu','von','van','de','del','della','di','da','dos','das','la','le']);
export function contentTokens(tokens: string[]): string[] {
  const kept = tokens.filter(t => !TITLES.has(t));
  return kept.length ? kept : tokens;   // 전부 경칭이면 원본 유지
}

export function normalizeCountry(v: string): string {
  return (v ?? '').trim().toUpperCase().slice(0, 2);
}

/** 생년월일 정규화 → YYYY-MM-DD 또는 null. 연도만 있으면 YYYY. */
export function normalizeDob(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);   // "12 Jan 1970" (OFAC/UN 형식)
  if (m) {
    const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  m = s.match(/(\d{4})/);          // "circa 1965", 범위 등에서 연도만 건짐
  return m ? m[1] : null;
}
