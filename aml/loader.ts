import { parseOfac, parseUn, parseEu, listVersionOf } from './ingest/parse.js';
import type { SanctionEntry } from './ingest/parse.js';

export async function loadLists(root = 'data/raw') {
  const files = {
    OFAC_SDN: `${root}/ofac_sdn.xml`,
    UN_CONSOLIDATED: `${root}/un_consolidated.xml`,
    EU_FSF: `${root}/eu_fsf.xml`,
  };
  const [ofac, un, eu] = await Promise.all([parseOfac(files.OFAC_SDN), parseUn(files.UN_CONSOLIDATED), parseEu(files.EU_FSF)]);
  const entries: SanctionEntry[] = [...ofac, ...un, ...eu];
  const listVersions = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, listVersionOf(p)]));
  return { entries, listVersions, counts: { OFAC_SDN: ofac.length, UN_CONSOLIDATED: un.length, EU_FSF: eu.length } };
}
