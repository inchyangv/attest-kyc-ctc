/**
 * Source XML for OFAC SDN, UN Consolidated and EU FSF into one common entry shape.
 * The three schemas have nothing in common, so each gets its own parser.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sax from './saxlite.js';
import { normalizeDob } from '../normalize.js';
import type { ListId } from '../types.js';

export interface SanctionEntry {
  listId: ListId;
  entryId: string;
  primaryName: string;
  names: string[];
  dobs: string[];
  countries: string[];
  programs: string[];
  cryptoAddresses: string[];
  type: 'individual' | 'entity' | 'vessel' | 'unknown';
}

/** First 32 bits of the file content hash, used as the edition number. Same bytes, same edition. */
export function listVersionOf(path: string): number {
  const h = createHash('sha256').update(readFileSync(path)).digest('hex');
  return parseInt(h.slice(0, 8), 16);
}

/** Country name to ISO-3166 alpha-2. Not exhaustive; weighted toward sanctions contexts. Unmapped names pass through. */
const COUNTRY: Record<string, string> = {
  "korea, north":"KP","north korea":"KP","democratic people's republic of korea":"KP","dprk":"KP",
  "korea, south":"KR","south korea":"KR","republic of korea":"KR","korea":"KR",
  "iran":"IR","islamic republic of iran":"IR","syria":"SY","syrian arab republic":"SY",
  "cuba":"CU","russia":"RU","russian federation":"RU","belarus":"BY","venezuela":"VE",
  "myanmar":"MM","burma":"MM","afghanistan":"AF","iraq":"IQ","libya":"LY","somalia":"SO",
  "sudan":"SD","south sudan":"SS","yemen":"YE","zimbabwe":"ZW","lebanon":"LB",
  "china":"CN","japan":"JP","united states":"US","united kingdom":"GB","germany":"DE",
  "france":"FR","ukraine":"UA","turkey":"TR","tuerkiye":"TR","pakistan":"PK","india":"IN",
  "nicaragua":"NI","mali":"ML","haiti":"HT","central african republic":"CF",
  "congo, democratic republic of the":"CD","bosnia and herzegowina":"BA","bosnia and herzegovina":"BA",
  "moldova, republic of":"MD","macedonia":"MK","north macedonia":"MK","serbia":"RS","montenegro":"ME",
  "cote d'ivoire":"CI","cote d ivoire":"CI","eritrea":"ER","guinea":"GN","guinea-bissau":"GW",
  "burundi":"BI","nigeria":"NG","tunisia":"TN","egypt":"EG","israel":"IL","palestine":"PS",
};
export function toIso2(v: string): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY[s.toLowerCase()] ?? '';
}

const CRYPTO_PREFIX = 'digital currency address';

// ───────────────────────────── OFAC SDN ─────────────────────────────
export async function parseOfac(path: string): Promise<SanctionEntry[]> {
  const out: SanctionEntry[] = [];
  await sax.streamElements(path, 'sdnEntry', (el) => {
    const uid = sax.text(el, 'uid');
    if (!uid) return;
    const first = sax.text(el, 'firstName'), last = sax.text(el, 'lastName');
    const primary = [first, last].filter(Boolean).join(' ').trim();
    const names = new Set<string>();
    if (primary) names.add(primary);
    for (const aka of sax.children(el, 'akaList', 'aka')) {
      const n = [sax.text(aka, 'firstName'), sax.text(aka, 'lastName')].filter(Boolean).join(' ').trim();
      if (n) names.add(n);
    }
    const dobs = new Set<string>();
    for (const d of sax.children(el, 'dateOfBirthList', 'dateOfBirthItem')) {
      const v = normalizeDob(sax.text(d, 'dateOfBirth')); if (v) dobs.add(v);
    }
    const countries = new Set<string>();
    for (const n of sax.children(el, 'nationalityList', 'nationality')) {
      const c = toIso2(sax.text(n, 'country')); if (c) countries.add(c);
    }
    for (const n of sax.children(el, 'citizenshipList', 'citizenship')) {
      const c = toIso2(sax.text(n, 'country')); if (c) countries.add(c);
    }
    const crypto = new Set<string>();
    for (const id of sax.children(el, 'idList', 'id')) {
      const t = sax.text(id, 'idType').toLowerCase();
      if (t.startsWith(CRYPTO_PREFIX)) {
        const a = sax.text(id, 'idNumber').trim(); if (a) crypto.add(a.toLowerCase());
      }
    }
    const st = sax.text(el, 'sdnType').toLowerCase();
    out.push({
      listId: 'OFAC_SDN', entryId: uid, primaryName: primary || [...names][0] || '',
      names: [...names], dobs: [...dobs], countries: [...countries],
      programs: sax.children(el, 'programList', 'program').map(p => sax.self(p)).filter(Boolean),
      cryptoAddresses: [...crypto],
      type: st === 'individual' ? 'individual' : st === 'vessel' ? 'vessel' : st === 'entity' ? 'entity' : 'unknown',
    });
  });
  return out;
}

// ────────────────────────── UN Consolidated ──────────────────────────
export async function parseUn(path: string): Promise<SanctionEntry[]> {
  const out: SanctionEntry[] = [];
  const handle = (kind: 'individual' | 'entity') => (el: sax.El) => {
    const id = sax.text(el, 'DATAID'); if (!id) return;
    const parts = ['FIRST_NAME','SECOND_NAME','THIRD_NAME','FOURTH_NAME'].map(t => sax.text(el, t)).filter(Boolean);
    const primary = parts.join(' ').trim();
    const names = new Set<string>(); if (primary) names.add(primary);
    const aliasTag = kind === 'individual' ? 'INDIVIDUAL_ALIAS' : 'ENTITY_ALIAS';
    for (const a of sax.direct(el, aliasTag)) {
      const n = sax.text(a, 'ALIAS_NAME').trim(); if (n) names.add(n);
    }
    const dobs = new Set<string>();
    for (const d of sax.direct(el, 'INDIVIDUAL_DATE_OF_BIRTH')) {
      for (const t of ['DATE','YEAR','FROM_YEAR','TO_YEAR']) {
        const v = normalizeDob(sax.text(d, t)); if (v) dobs.add(v);
      }
    }
    const countries = new Set<string>();
    for (const n of sax.direct(el, 'NATIONALITY')) {
      const c = toIso2(sax.text(n, 'VALUE')); if (c) countries.add(c);
    }
    out.push({
      listId: 'UN_CONSOLIDATED', entryId: id, primaryName: primary,
      names: [...names], dobs: [...dobs], countries: [...countries],
      programs: [sax.text(el, 'UN_LIST_TYPE')].filter(Boolean),
      cryptoAddresses: [], type: kind,
    });
  };
  await sax.streamElements(path, 'INDIVIDUAL', handle('individual'));
  await sax.streamElements(path, 'ENTITY', handle('entity'));
  return out;
}

// ─────────────────────────────  EU FSF  ─────────────────────────────
export async function parseEu(path: string): Promise<SanctionEntry[]> {
  const out: SanctionEntry[] = [];
  await sax.streamElements(path, 'sanctionEntity', (el) => {
    const id = sax.attr(el, 'logicalId') || sax.attr(el, 'euReferenceNumber');
    if (!id) return;
    const names = new Set<string>();
    for (const a of sax.direct(el, 'nameAlias')) {
      const whole = sax.attr(a, 'wholeName').trim();
      if (whole) names.add(whole);
      else {
        const n = [sax.attr(a,'firstName'), sax.attr(a,'middleName'), sax.attr(a,'lastName')].filter(Boolean).join(' ').trim();
        if (n) names.add(n);
      }
    }
    const dobs = new Set<string>();
    for (const b of sax.direct(el, 'birthdate')) {
      for (const k of ['birthdate','year']) {
        const v = normalizeDob(sax.attr(b, k)); if (v) dobs.add(v);
      }
    }
    const countries = new Set<string>();
    for (const c of sax.direct(el, 'citizenship')) {
      const v = toIso2(sax.attr(c, 'countryIso2Code') || sax.attr(c, 'countryDescription'));
      if (v) countries.add(v);
    }
    const st = sax.direct(el, 'subjectType')[0];
    const code = st ? sax.attr(st, 'code').toLowerCase() : '';
    out.push({
      listId: 'EU_FSF', entryId: String(id), primaryName: [...names][0] ?? '',
      names: [...names], dobs: [...dobs], countries: [...countries],
      programs: [], cryptoAddresses: [],
      type: code === 'person' ? 'individual' : code === 'enterprise' ? 'entity' : 'unknown',
    });
  });
  return out;
}
