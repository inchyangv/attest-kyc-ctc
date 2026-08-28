import { parseOfac, parseUn, parseEu, listVersionOf } from './ingest/parse.js';
const t0 = Date.now();
const R = 'data/raw';
const [ofac, un, eu] = await Promise.all([
  parseOfac(`${R}/ofac_sdn.xml`), parseUn(`${R}/un_consolidated.xml`), parseEu(`${R}/eu_fsf.xml`),
]);
const all = [...ofac, ...un, ...eu];
const sum = (a: any[], f: (x: any) => number) => a.reduce((s, x) => s + f(x), 0);
for (const [n, l, p] of [['OFAC_SDN', ofac, 'ofac_sdn.xml'], ['UN_CONSOLIDATED', un, 'un_consolidated.xml'], ['EU_FSF', eu, 'eu_fsf.xml']] as const) {
  console.log(`${n.padEnd(17)} 엔트리 ${String(l.length).padStart(6)} · 이름 ${String(sum(l, x => x.names.length)).padStart(6)} · 생년월일 ${String(sum(l, x => x.dobs.length)).padStart(5)} · 국가 ${String(sum(l, x => x.countries.length)).padStart(5)} · 암호주소 ${sum(l, x => x.cryptoAddresses.length)} · 판본 ${listVersionOf(`${R}/${p}`)}`);
}
const evm = new Set<string>();
for (const e of all) for (const a of e.cryptoAddresses) if (/^0x[0-9a-f]{40}$/.test(a)) evm.add(a);
console.log(`\n합계 엔트리 ${all.length} · 이름 ${sum(all, x => x.names.length)} · EVM 제재주소 ${evm.size}`);
console.log(`파싱 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
console.log('\n표본:', JSON.stringify(all.find(e => e.names.some(n => /kim jong un/i.test(n))) ?? all[0], null, 1).slice(0, 500));
