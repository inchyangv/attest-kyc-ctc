/**
 * Name normalisation, the defence against evasion.
 * Miss something here and a listed person walks straight through.
 * Change a rule and ENGINE_VERSION must go up, or evidence stops being reproducible.
 */

export const ENGINE_VERSION = 'aml-1.0.0';

/** Invisible characters, slipped between letters to break matching. An old trick. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­͏]/g;

/**
 * Homoglyphs. Cyrillic and Greek letters that look Latin.
 * The P in 'Реtrov' is Cyrillic U+0420, not Latin P.
 */
const HOMOGLYPH: Record<string, string> = {
  // Cyrillic to Latin
  'а':'a','в':'b','с':'c','е':'e','н':'h','к':'k','м':'m','о':'o','р':'p','т':'t','х':'x','у':'y','і':'i','ј':'j','ѕ':'s',
  'А':'a','В':'b','С':'c','Е':'e','Н':'h','К':'k','М':'m','О':'o','Р':'p','Т':'t','Х':'x','У':'y','І':'i','Ј':'j','Ѕ':'s',
  // Greek to Latin
  'α':'a','β':'b','ε':'e','ι':'i','κ':'k','ν':'v','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x','Α':'a','Β':'b','Ε':'e','Ι':'i',
  'Κ':'k','Μ':'m','Ν':'n','Ο':'o','Ρ':'p','Τ':'t','Υ':'y','Χ':'x','Ζ':'z','Η':'h',
};

/** Full width to half width */
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
 * The normalisation pipeline. Order matters.
 * Map homoglyphs to Latin before stripping diacritics, or Cyrillic composites leak through.
 */
export function normalizeName(raw: string): string {
  let s = raw ?? '';
  s = s.replace(INVISIBLE, '');
  s = toHalfWidth(s);
  s = s.toLowerCase();
  s = mapHomoglyphs(s);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');   // strip diacritics
  s = s.replace(/[''`´ʻʼ]/g, "'");
  s = s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ');   // punctuation to space
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Tokens for order-independent matching. Single characters are initials, so they stay. */
export function tokenize(normalized: string): string[] {
  return normalized.split(/[\s'-]+/).filter(t => t.length > 0);
}

/** Honorifics and particles around a name. Matching noise, so they are dropped. */
const TITLES = new Set(['mr','mrs','ms','dr','prof','sheikh','haji','al','el','bin','ibn','abu','von','van','de','del','della','di','da','dos','das','la','le']);
export function contentTokens(tokens: string[]): string[] {
  const kept = tokens.filter(t => !TITLES.has(t));
  return kept.length ? kept : tokens;   // keep the original if everything was an honorific
}

export function normalizeCountry(v: string): string {
  return (v ?? '').trim().toUpperCase().slice(0, 2);
}

/** Normalise a date of birth to YYYY-MM-DD, or YYYY when only a year is known, or null. */
export function normalizeDob(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);   // "12 Jan 1970", the OFAC and UN format
  if (m) {
    const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  m = s.match(/(\d{4})/);   // salvage the year from "circa 1965" and from ranges
  return m ? m[1] : null;
}
