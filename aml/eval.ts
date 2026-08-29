/** Evaluation corpus. If we are going to claim a number, we measure it. */
import { loadLists } from './loader.js';
import { ListBackedAmlEngine } from './engine.js';
const EVIDENCE_KEY = 'test-only-evidence-key';

const { entries, listVersions, counts } = await loadLists();
const engine = new ListBackedAmlEngine({ entries, listVersions, evidenceKey: EVIDENCE_KEY, keyId: 'test-k1' });
console.log(`lists loaded: OFAC ${counts.OFAC_SDN}, UN ${counts.UN_CONSOLIDATED}, EU ${counts.EU_FSF} = ${entries.length}\n`);

// Recall: look up each listed individual with their own name, date of birth and country
const inds = entries.filter(e => e.type === 'individual' && e.dobs.length && e.countries.length && e.primaryName.split(/\s+/).length >= 2);
const step = Math.max(1, Math.floor(inds.length / 200));
const sample = inds.filter((_, i) => i % step === 0).slice(0, 200);
let blocked = 0, reviewed = 0, missed: string[] = [];
for (const e of sample) {
  const r = await engine.screen({
    fullName: e.primaryName, dateOfBirth: e.dobs[0].length === 4 ? `${e.dobs[0]}-01-01` : e.dobs[0],
    nationality: e.countries[0], residence: e.countries[0], walletAddress: '0x' + '1'.repeat(40),
  });
  if (r.decision === 'BLOCK') blocked++;
  else if (r.decision === 'REVIEW') reviewed++;
  else missed.push(`${e.listId}:${e.entryId} ${e.primaryName}`);
}
console.log(`recall (n=${sample.length}): BLOCK ${blocked}, REVIEW ${reviewed}, passed ${missed.length}`);
console.log(`  caught (BLOCK+REVIEW) ${(((blocked + reviewed) / sample.length) * 100).toFixed(1)}%`);
if (missed.length) console.log('  missed, for example:', missed.slice(0, 3));

// Specificity: ordinary names that are not on any list
const SUR = ['김','이','박','최','정','강','조','윤','장','임','한','오','서','신','권','황','안','송','전','홍','유','고','문','양','손','배','백','허','심','노'];
const GIV = ['철수','영희','민준','서연','우진','지훈','현우','서준','하은','도윤','지민','세훈','지우','예은','나은','민서','준호','재현','다인','승우'];
const KO: string[] = [];
for (const s2 of SUR) for (const g of GIV) KO.push(s2 + g);   // 600 people
const EN = ['James Anderson','Mary Thompson','Robert Wilson','Patricia Moore','Michael Clark','Linda Hall','David Young','Barbara King','Richard Wright','Susan Scott'];
let fp = 0; const fpEx: string[] = [];
for (const n of [...KO, ...EN]) {
  const r = await engine.screen({ fullName: n, dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '2'.repeat(40) });
  if (r.decision !== 'ALLOW') { fp++; fpEx.push(`${n} → ${r.decision}/${r.reviewReason ?? ''} ${r.hits[0]?.matchedName ?? ''}`); }
}
console.log(`\nspecificity (n=${KO.length + EN.length}): ${fp} false positive(s)  ${fp ? fpEx.slice(0,5).join(' | ') : 'none'}`);

// The Hangul path
console.log('\nHangul romanisation path:');
for (const [name, dob, nat] of [['김정은','1984-01-08','KP'],['최영호','1985-03-14','KR']] as const) {
  const r = await engine.screen({ fullName: name, dateOfBirth: dob, nationality: nat, residence: nat, walletAddress: '0x'+'3'.repeat(40) });
  const top = r.hits[0];
  console.log(`  ${name} (${nat}) → ${r.decision}${r.reviewReason ? '/'+r.reviewReason : ''} band ${r.riskBand}, ${r.hits.length} hit(s)${top ? ` , top "${top.matchedName}" ${top.score} ${top.corroborated?'corroborated':'uncorroborated'}` : ''}`);
}

// Evasion resistance
const target = inds.find(e => /^[a-zA-Z ]+$/.test(e.primaryName) && e.primaryName.split(' ').length >= 2)!;
const base = target.primaryName;
const evasions: [string,string][] = [
  ['original', base],
  ['invisible chars', base.split('').join('​')],
  ['cyrillic homoglyphs', base.replace(/a/gi,'а').replace(/e/gi,'е').replace(/o/gi,'о')],
  ['diacritics', base.replace(/a/gi,'á').replace(/e/gi,'ë')],
  ['full width', [...base].map(c => /[A-Za-z]/.test(c) ? String.fromCharCode(c.charCodeAt(0)+0xFEE0) : c).join('')],
  ['reversed order', base.split(' ').reverse().join(' ')],
  ['punctuation', base.split(' ').join('. ')],
];
console.log(`\nevasion resistance (target: ${base}, ${target.listId}:${target.entryId})`);
for (const [label, variant] of evasions) {
  const r = await engine.screen({ fullName: variant, dateOfBirth: target.dobs[0].length===4?`${target.dobs[0]}-01-01`:target.dobs[0], nationality: target.countries[0], residence: target.countries[0], walletAddress: '0x'+'4'.repeat(40) });
  console.log(`  ${(r.decision==='BLOCK'?'✅':'❌')} ${label.padEnd(16)} → ${r.decision} ${r.hits[0]?.score ?? ''}`);
}

// The wallet path
const walletEntry = entries.find(e => e.cryptoAddresses.some(a => /^0x[0-9a-f]{40}$/.test(a)))!;
const addr = walletEntry.cryptoAddresses.find(a => /^0x[0-9a-f]{40}$/.test(a))!;
const rw = await engine.screen({ fullName: 'Totally Unrelated Person', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US', walletAddress: addr });
console.log(`\nsanctioned wallet lookup ${addr.slice(0,12)}... -> ${rw.decision} band ${rw.riskBand} (${rw.hits[0]?.matchedName})`);

// methods bits
const r0 = await engine.screen({ fullName: 'Test Person', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x'+'5'.repeat(40) });
console.log(`\nmethodsApplied = 0x${r0.methodsApplied.toString(16)} , PEP bit ${(r0.methodsApplied & (1<<17)) ? 'SET (wrong)' : 'unset, no data'}`);
