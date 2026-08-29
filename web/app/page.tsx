'use client';

import { useState } from 'react';

type MethodGroup = { group: string; note: string; items: { key: string; label: string; set: boolean }[] };
type Hit = {
  listId: string; entryId: string; matchedName: string; score: number;
  matchType: string; corroborated: boolean; corroboration?: string[];
};
type Result = {
  decision: 'ALLOW' | 'BLOCK' | 'REVIEW';
  reviewReason: string | null;
  riskBand: number;
  hits: Hit[];
  methodsHex: string;
  methodGroups: MethodGroup[];
  engineVersion: string;
  listVersions: Record<string, number>;
  listCounts: Record<string, number>;
  evidenceDigest: string;
  elapsedMs: number;
};

const PRESETS = [
  { label: '김정은 · KP', hint: 'Hangul → romanized, corroborated by DOB + country',
    v: { fullName: '김정은', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '' } },
  { label: '최영호 · KR', hint: 'Romanized expansion collides with a listed name — but nothing corroborates it',
    v: { fullName: '최영호', dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '' } },
  { label: 'Sanctioned wallet', hint: 'Name is irrelevant — the address itself is on the OFAC list',
    v: { fullName: 'Totally Unrelated Person', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US',
         walletAddress: '0x252a8bd2319d8a555b872990601221b3a2053bce' } },
  { label: '박서준 · KR', hint: 'An ordinary Korean name — must pass cleanly',
    v: { fullName: '박서준', dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '' } },
];

const DECISION_STYLE: Record<string, string> = {
  ALLOW:  'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  REVIEW: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  BLOCK:  'border-rose-400/40 bg-rose-400/10 text-rose-300',
};

export default function Home() {
  const [form, setForm] = useState(PRESETS[3].v);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function screen(payload = form) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/screen', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'screening failed');
      setRes(j);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-10 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Live sanctions screening</h1>
        <p className="mt-3 text-sm leading-relaxed text-white/55">
          Real lists, not fixtures — OFAC SDN, UN Consolidated and EU FSF are parsed from source XML.
          The engine records <em className="not-italic text-white/80">what it actually checked</em>, and nothing more.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
        {/* ── input ── */}
        <section className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <div className="space-y-3">
              {([
                ['fullName', 'Full name', 'text'], ['dateOfBirth', 'Date of birth', 'text'],
                ['nationality', 'Nationality (ISO-2)', 'text'], ['residence', 'Residence (ISO-2)', 'text'],
                ['walletAddress', 'Wallet address', 'text'],
              ] as const).map(([k, label]) => (
                <label key={k} className="block">
                  <span className="mb-1 block text-xs text-white/45">{label}</span>
                  <input
                    value={form[k]} onChange={set(k)} spellCheck={false}
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-white/30"
                    placeholder={k === 'walletAddress' ? '0x… (optional)' : ''}
                  />
                </label>
              ))}
            </div>
            <button
              onClick={() => screen()} disabled={busy}
              className="mt-4 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition hover:bg-white/90 disabled:opacity-40"
            >
              {busy ? 'Screening…' : 'Run screening'}
            </button>
            {err && <p className="mt-3 text-xs text-rose-300">{err}</p>}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-white/40">Try these</h2>
            <div className="space-y-2">
              {PRESETS.map(p => (
                <button key={p.label} onClick={() => { setForm(p.v); screen(p.v); }}
                  className="w-full rounded-lg border border-white/10 px-3 py-2.5 text-left transition hover:border-white/25 hover:bg-white/[0.03]">
                  <div className="text-sm">{p.label}</div>
                  <div className="mt-0.5 text-xs leading-snug text-white/40">{p.hint}</div>
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── result ── */}
        <section className="space-y-5">
          {!res && (
            <div className="rounded-xl border border-dashed border-white/10 p-16 text-center text-sm text-white/30">
              Run a screening to see the decision, the evidence, and — importantly — what was <em className="not-italic">not</em> checked.
            </div>
          )}

          {res && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`rounded-lg border px-4 py-2 text-sm font-semibold ${DECISION_STYLE[res.decision]}`}>
                  {res.decision}{res.reviewReason ? ` · ${res.reviewReason}` : ''}
                </span>
                <span className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/55">
                  Risk band <b className="text-white/85">{res.riskBand}</b>/5
                </span>
                <span className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/55">
                  {res.elapsedMs} ms
                </span>
                <span className="rounded-lg border border-white/10 px-3 py-2 font-mono text-xs text-white/40">
                  {res.engineVersion}
                </span>
              </div>

              {/* methods — the honesty surface */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
                <div className="mb-1 flex items-baseline justify-between">
                  <h2 className="text-sm font-medium">Checks performed</h2>
                  <code className="text-xs text-white/40">methods = {res.methodsHex}</code>
                </div>
                <p className="mb-4 text-xs leading-relaxed text-white/45">
                  A bit is set only when the check actually ran. An unset bit is not an omission we hide —
                  it is the reason a consumer policy is allowed to reject this mark.
                </p>
                <div className="space-y-4">
                  {res.methodGroups.map(g => (
                    <div key={g.group}>
                      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
                        <h3 className="text-xs font-medium text-white/70">{g.group}</h3>
                        <span className="text-[11px] text-white/35">{g.note}</span>
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-3">
                        {g.items.map(m => (
                          <div key={m.key}
                            className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                              m.set ? 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200'
                                    : 'border-white/[0.07] text-white/30'}`}>
                            <span className={m.set ? 'text-emerald-400' : 'text-white/20'}>{m.set ? '●' : '○'}</span>
                            <span>{m.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* hits */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
                <h2 className="mb-3 text-sm font-medium">
                  List matches <span className="text-white/40">({res.hits.length})</span>
                </h2>
                {res.hits.length === 0 ? (
                  <p className="text-xs text-white/35">No candidate matched above threshold.</p>
                ) : (
                  <div className="space-y-2">
                    {res.hits.map((h, i) => (
                      <div key={i} className="rounded-lg border border-white/10 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{h.matchedName}</span>
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
                            {h.matchType}
                          </span>
                          <span className="text-xs text-white/45">score {h.score}</span>
                          <span className="ml-auto font-mono text-[10px] text-white/35">
                            {h.listId}:{h.entryId}
                          </span>
                        </div>
                        <div className={`mt-1.5 text-xs ${h.corroborated ? 'text-amber-300/80' : 'text-white/40'}`}>
                          {h.corroborated
                            ? `corroborated by ${h.corroboration?.join(', ')} — this drives the decision`
                            : 'not corroborated — recorded in evidence, but does not hold the person'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* evidence */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
                <h2 className="mb-3 text-sm font-medium">Evidence</h2>
                <dl className="space-y-2 text-xs">
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-white/40">digest</dt>
                    <dd className="break-all font-mono text-white/70">{res.evidenceDigest}</dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-white/40">list versions</dt>
                    <dd className="font-mono text-white/60">
                      {Object.entries(res.listVersions).map(([k, v]) => `${k}=${v}`).join(' · ')}
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-white/40">entries loaded</dt>
                    <dd className="text-white/60">
                      {Object.entries(res.listCounts).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')}
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed text-white/40">
                  The evidence record contains <b className="text-white/70">no name in cleartext</b> — name fields are
                  keyed HMAC digests. Evidence is kept for audit; the vault can still be erased on request.
                  This is pseudonymisation, not anonymisation: the key holder can confirm a candidate, and that is the point.
                </p>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
