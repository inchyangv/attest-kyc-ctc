import { parseOfac, parseUn, parseEu, listVersionOf } from './ingest/parse.js';
const t0 = Date.now();
const R = 'data/raw';
const [ofac, un, eu] = await Promise.all([
  parseOfac(`${R}/ofac_sdn.xml`), parseUn(`${R}/un_consolidated.xml`), parseEu(`${R}/eu_fsf.xml`),
]);
const all = [...ofac, ...un, ...eu];
const sum = (a: any[], f: (x: any) => number) => a.reduce((s, x) => s + f(x), 0);
for (const [n, l, p] of [['OFAC_SDN', ofac, 'ofac_sdn.xml'], ['UN_CONSOLIDATED', un, 'un_consolidated.xml'], ['EU_FSF', eu, 'eu_fsf.xml']] as const) {
  console.log(`${n.padEnd(17)} entries ${String(l.length).padStart(6)} names ${String(sum(l, x => x.names.length)).padStart(6)} dobs ${String(sum(l, x => x.dobs.length)).padStart(5)} countries ${String(sum(l, x => x.countries.length)).padStart(5)} crypto ${sum(l, x => x.cryptoAddresses.length)} edition ${listVersionOf(`${R}/${p}`)}`);
}
const evm = new Set<string>();
for (const e of all) for (const a of e.cryptoAddresses) if (/^0x[0-9a-f]{40}$/.test(a)) evm.add(a);
console.log(`\ntotal entries ${all.length}, names ${sum(all, x => x.names.length)}, sanctioned EVM addresses ${evm.size}`);
console.log(`parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('\nsample:', JSON.stringify(all.find(e => e.names.some(n => /kim jong un/i.test(n))) ?? all[0], null, 1).slice(0, 500));
