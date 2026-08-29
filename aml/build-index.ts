/**
 * 심사에 필요한 것만 뽑아 경량 인덱스로 굽는다.
 * 원본 57MB XML 을 서버리스에서 매 요청 파싱할 수 없다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadLists } from './loader.js';

const { entries, listVersions, counts } = await loadLists();

// 이름·생년월일·국가·암호주소만 남긴다. 프로그램·주소·비고는 심사에 안 쓴다.
const slim = entries.map(e => ({
  l: e.listId === 'OFAC_SDN' ? 0 : e.listId === 'UN_CONSOLIDATED' ? 1 : 2,
  i: e.entryId,
  p: e.primaryName,
  n: e.names,
  d: e.dobs,
  c: e.countries,
  w: e.cryptoAddresses.filter(a => /^0x[0-9a-f]{40}$/.test(a)),
  t: e.type === 'individual' ? 0 : e.type === 'entity' ? 1 : 2,
}));

mkdirSync('web/data', { recursive: true });
const payload = JSON.stringify({ v: 1, listVersions, counts, entries: slim });
const gz = gzipSync(Buffer.from(payload), { level: 9 });
writeFileSync('web/data/sanctions-index.json.gz', gz);

console.log(`엔트리 ${slim.length} · 이름 ${slim.reduce((s,e)=>s+e.n.length,0)}`);
console.log(`원본 JSON ${(payload.length/1e6).toFixed(1)}MB → gzip ${(gz.length/1e6).toFixed(2)}MB`);
console.log(`판본:`, listVersions);
