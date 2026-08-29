'use client';

import { useEffect, useState } from 'react';

const STATUS = ['NONE', 'ACTIVE', 'REVOKED', 'DENIED', 'SUSPENDED'];
const ORIGIN = ['None', 'Direct', 'Roster'];

const METHOD_BITS: [number, string][] = [
  [0,'Wallet control'],[1,'ID doc image'],[2,'ID doc authenticity'],[3,'Face match'],[4,'Liveness'],
  [5,'Bank account'],[6,'Mobile carrier'],[7,'Video call'],[8,'In person'],[9,'ePassport NFC'],[10,'Gov eID'],
  [16,'Sanctions screened'],[17,'PEP screened'],[18,'Adverse media'],[19,'Jurisdiction check'],[20,'On-chain exposure'],
];
const bits = (mask: number) => METHOD_BITS.filter(([b]) => (mask & (1 << b)) !== 0).map(([, l]) => l);
const missing = (mask: number, req: number) =>
  METHOD_BITS.filter(([b]) => (req & (1 << b)) !== 0 && (mask & (1 << b)) === 0).map(([, l]) => l);

export default function OnChain() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/onchain').then(r => r.json())
      .then(j => (j.error ? setErr(j.error) : setD(j)))
      .catch(e => setErr(String(e)));
  }, []);

  if (err) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-rose-300">{err}</main>;
  if (!d) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-white/40">Reading CC3 Testnet…</main>;

  const m = d.mark;
  const revoked = d.tombstone || m.status === 2;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">On-chain state</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
        Read live from Creditcoin CC3 Testnet at block {d.blockNumber.toLocaleString()}. Nothing here is cached or staged.
      </p>

      {/* trust anchors */}
      <section className="mt-8 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-3 text-sm font-medium">What the ASC will accept</h2>
        <dl className="space-y-2 text-xs">
          <div className="flex gap-3"><dt className="w-40 shrink-0 text-white/40">expectedChainKey</dt>
            <dd className="text-white/80">{d.asc.expectedChainKey} <span className="text-white/35">— Sepolia only. A proof from any other chain reverts.</span></dd></div>
          <div className="flex gap-3"><dt className="w-40 shrink-0 text-white/40">sourceContract</dt>
            <dd className="break-all font-mono text-white/70">{d.asc.sourceContract}</dd></div>
        </dl>
      </section>

      {/* the mark */}
      <section className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Mark</h2>
          <code className="text-xs text-white/40">{d.subject.slice(0, 10)}…{d.subject.slice(-6)}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`rounded-lg border px-3 py-1.5 text-xs ${revoked
            ? 'border-rose-400/40 bg-rose-400/10 text-rose-300'
            : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'}`}>
            {STATUS[m.status] ?? m.status}{d.tombstone ? ' · tombstoned' : ''}
          </span>
          <span className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60">origin {ORIGIN[m.origin]}</span>
          <span className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60">assurance {m.assurance}</span>
          <span className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60">jurisdiction {m.jurisdiction}</span>
          <span className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-xs text-white/60">methods {m.methodsHex}</span>
        </div>
        {m.methods > 0 && (
          <p className="mt-3 text-xs text-white/45">Claims: {bits(m.methods).join(' · ')}</p>
        )}
        <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-xs">
          <div className="flex gap-3"><dt className="w-28 shrink-0 text-white/40">claimsRoot</dt><dd className="break-all font-mono text-white/60">{m.claimsRoot}</dd></div>
          <div className="flex gap-3"><dt className="w-28 shrink-0 text-white/40">evidenceHash</dt><dd className="break-all font-mono text-white/60">{m.evidenceHash}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-white/35">
          Two 32-byte commitments. No name, no date of birth, no document number — on-chain PII is zero bytes.
        </p>
      </section>

      {/* the point: same mark, different policies */}
      <section className="mt-5">
        <h2 className="mb-1 text-sm font-medium">Same mark, two policies</h2>
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-white/45">
          We do not claim Korean KYC equals EU KYC. The mark carries the checks that were performed;
          each consumer decides whether that meets its own regime.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {d.policies.map((p: any) => {
            const gaps = missing(m.methods, p.requireAll);
            return (
              <div key={p.id} className={`rounded-xl border p-4 ${p.verified
                ? 'border-emerald-400/30 bg-emerald-400/[0.05]' : 'border-white/10 bg-white/[0.02]'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className={`text-xs font-semibold ${p.verified ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {p.verified ? 'PASS' : 'FAIL'}
                  </span>
                </div>
                <code className="mt-1 block text-[11px] text-white/40">
                  policyId {p.id} · requireAll {p.requireAllHex} · minAssurance {p.minAssurance}
                  {p.requireRoster ? ' · roster required' : ''}
                </code>
                <p className="mt-2 text-xs leading-snug text-white/45">
                  {p.verified
                    ? 'Every required check is present on this mark.'
                    : revoked
                      ? 'Revoked — a tombstone outranks every policy (deny beats allow).'
                      : gaps.length
                        ? <>Missing: <span className="text-amber-300/80">{gaps.join(', ')}</span></>
                        : 'Rejected on assurance, freshness or expiry.'}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {revoked && (
        <section className="mt-5 rounded-xl border border-rose-400/25 bg-rose-400/[0.05] p-5">
          <h2 className="text-sm font-medium text-rose-200">Why this mark was revoked</h2>
          <p className="mt-2 text-xs leading-relaxed text-white/60">
            Its <code className="text-white/80">methods</code> were hand-authored while we were validating the
            cross-chain pipeline, so the mark asserted checks we had never performed —
            document authenticity and bank-account verification. That is precisely the failure this product exists
            to prevent, so we revoked it on-chain (reason <code className="text-white/80">ISSUER_ERROR</code>).
            Propagation back to Creditcoin took 8m 43s.
          </p>
          <p className="mt-2 text-xs text-white/40">
            We hold ourselves to the rule we sell. A mark may not claim a check that did not happen.
          </p>
        </section>
      )}
    </main>
  );
}
