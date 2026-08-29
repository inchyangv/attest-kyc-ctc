'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { StatCard } from '@/components/ui/StatCard';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { Section, Plate } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';
import { bitOf } from '@/lib/methods';

type Decision = 'ALLOW' | 'BLOCK' | 'REVIEW';
type MethodGroup = { group: string; note: string; items: { key: string; label: string; set: boolean }[] };
type Hit = {
  listId: string; entryId: string; matchedName: string; score: number;
  matchType: string; corroborated: boolean; corroboration?: string[];
};
type Meta = { engineVersion: string; listVersions: Record<string, number>; listCounts: Record<string, number> };
type Result = Meta & {
  decision: Decision;
  reviewReason: string | null;
  riskBand: number;
  hits: Hit[];
  methodsHex: string;
  methodGroups: MethodGroup[];
  evidenceDigest: string;
  elapsedMs: number;
};

const LIST: Record<string, { label: string; source: string }> = {
  OFAC_SDN: { label: 'OFAC SDN', source: 'US Treasury' },
  UN_CONSOLIDATED: { label: 'UN Consolidated', source: 'UN Security Council' },
  EU_FSF: { label: 'EU FSF', source: 'European Commission' },
};

const PRESETS = [
  { label: '김정은 · KP', hint: 'Hangul → romanized, corroborated by DOB + country',
    v: { fullName: '김정은', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '' } },
  { label: '최영호 · KR', hint: 'Romanized expansion collides with a listed name, but nothing corroborates it',
    v: { fullName: '최영호', dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '' } },
  { label: 'Sanctioned wallet', hint: 'The name does not matter. The address itself is on the OFAC list',
    v: { fullName: 'Totally Unrelated Person', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US',
         walletAddress: '0x252a8bd2319d8a555b872990601221b3a2053bce' } },
  { label: '박서준 · KR', hint: 'An ordinary Korean name. Must pass cleanly',
    v: { fullName: '박서준', dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '' } },
];

const DECISION: Record<Decision, { tone: Tone; band: 'ok' | 'warn' | 'bad'; text: string }> = {
  ALLOW: { tone: 'green', band: 'ok', text: 'No corroborated match. The mark may carry the sanctions bit.' },
  REVIEW: { tone: 'orange', band: 'warn', text: 'A candidate matched but nothing corroborates it. A person decides.' },
  BLOCK: { tone: 'red', band: 'bad', text: 'A listed party was corroborated. No mark is issued.' },
};

const FIELDS = [
  ['fullName', 'Full name', ''], ['dateOfBirth', 'Date of birth', 'YYYY-MM-DD'],
  ['nationality', 'Nationality', 'ISO-2'], ['residence', 'Residence', 'ISO-2'],
] as const;

export default function Home() {
  const [form, setForm] = useState(PRESETS[3].v);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { fetch('/api/screen').then(r => r.json()).then(setMeta).catch(() => {}); }, []);

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
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const info = res ?? meta;
  const totalEntries = info ? Object.values(info.listCounts).reduce((a, b) => a + b, 0) : null;

  return (
    <>
      {/* ── plate ── */}
      <Plate>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="text-xs font-medium uppercase tracking-wider text-plate-muted">Proofmark · KYC/AML attestation layer</div>
            <h1 className="mt-2 font-display text-[32px] font-semibold leading-tight text-mint sm:text-[40px]">Sanctions screening</h1>
            <p className="mt-3 text-base leading-6 text-plate-muted">
              OFAC SDN, UN Consolidated and EU FSF, parsed from the source XML.
              The engine records <span className="text-plate-fg">what it checked</span> and nothing more.
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2">
            {Object.keys(LIST).map(id => (
              <div key={id} className="min-w-0 rounded-md border border-plate-line px-3 py-2">
                <div className="text-[11px] font-medium text-plate-muted">{LIST[id].label}</div>
                <div className="mt-0.5 text-lg font-medium leading-6 text-plate-fg tabular-nums">
                  {info ? info.listCounts[id]?.toLocaleString() ?? '—' : <span className="text-plate-muted">…</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-plate-muted">{info?.listVersions[id] ? `rev ${info.listVersions[id]}` : 'loading'}</div>
              </div>
            ))}
          </div>
        </div>
      </Plate>

      {/* ── stats ── */}
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="database" label="Entries loaded" value={totalEntries?.toLocaleString() ?? '—'} sub="3 lists" />
        <StatCard icon="bolt" label="Engine" value={<span className="font-mono text-base">{info?.engineVersion ?? '—'}</span>} />
        <StatCard icon="shield" label="Last decision"
          value={res ? <Tag tone={DECISION[res.decision].tone}>{res.decision}</Tag> : <span className="text-fg-subtle">—</span>}
          sub={res ? `risk ${res.riskBand}/5` : undefined} />
        <StatCard icon="clock" label="Screening time" value={res ? res.elapsedMs : '—'} sub={res ? 'ms' : undefined} />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* ── input ── */}
        <div>
          <div className="rounded-lg bg-surface p-4">
            <div className="grid gap-3">
              {FIELDS.map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint || undefined}>
                  <Input value={form[k]} onChange={set(k)} spellCheck={false} />
                </Field>
              ))}
              <Field label="Wallet address" hint="optional">
                <Input value={form.walletAddress} onChange={set('walletAddress')} spellCheck={false} placeholder="0x…" className="font-mono" />
              </Field>
            </div>
            <Button onClick={() => screen()} disabled={busy} className="mt-4 w-full">
              <Icon name="search" size={18} />{busy ? 'Screening…' : 'Run screening'}
            </Button>
            {err && <Band tone="bad" className="mt-3">{err}</Band>}
          </div>

          <div className="mt-6">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">Try these</div>
            <div className="overflow-hidden rounded-lg border border-line">
              {PRESETS.map(p => (
                <button key={p.label} type="button" onClick={() => { setForm(p.v); screen(p.v); }} disabled={busy}
                  className="group flex w-full items-start gap-3 border-b border-divider px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface disabled:opacity-60">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-fg-strong group-hover:text-link">{p.label}</div>
                    <div className="mt-0.5 text-[13px] leading-snug text-fg-muted">{p.hint}</div>
                  </div>
                  <Icon name="arrow" size={16} className="mt-1 shrink-0 text-fg-subtle group-hover:text-link" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── result ── */}
        <div className="min-w-0">
          {!res && (
            <div className="flex flex-col items-center justify-center rounded-lg bg-surface px-6 py-20 text-center">
              <Icon name="shield" size={32} className="text-fg-subtle" />
              <div className="mt-3 text-base font-medium text-fg-strong">No screening yet</div>
              <p className="mt-1 max-w-sm text-sm text-fg-muted">
                Run one to see the decision, the evidence, and what was <em className="not-italic text-fg-strong">not</em> checked.
              </p>
            </div>
          )}

          {res && (
            <>
              <Band tone={DECISION[res.decision].band}>
                <span className="mr-2 font-semibold">{res.decision}</span>
                {DECISION[res.decision].text}
                {res.reviewReason && <Tag tone="gray" mono className="ml-2 align-middle">{res.reviewReason}</Tag>}
              </Band>

              {/* checks */}
              <Section title="Checks performed" className="mt-6"
                aside={<Tag tone="gray" mono>methods = {res.methodsHex}</Tag>}
                lede="A bit is set only when the check ran. An unset bit is what lets a consumer policy reject this mark.">
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Check</th><th className="w-24">Bit</th><th className="w-32">Status</th></tr></thead>
                    <tbody>
                      {res.methodGroups.map(g => (
                        <Group key={g.group} group={g} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* hits */}
              <Section title={<>List matches <span className="text-fg-muted">({res.hits.length})</span></>}>
                {res.hits.length === 0 ? (
                  <div className="rounded-md bg-surface px-4 py-3 text-sm text-fg-muted">No candidate matched above threshold.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="tbl">
                      <thead><tr><th>Matched name</th><th>Type</th><th className="num">Score</th><th>Source</th><th>Corroboration</th></tr></thead>
                      <tbody>
                        {res.hits.map((h, i) => (
                          <tr key={i}>
                            <td className="text-fg-strong">{h.matchedName}</td>
                            <td><Tag tone={h.corroborated ? 'orange' : 'blue'}>{h.matchType}</Tag></td>
                            <td className="num">{h.score}</td>
                            <td><span className="font-mono text-[13px] text-fg-muted">{LIST[h.listId]?.label ?? h.listId} · {h.entryId}</span></td>
                            <td>
                              {h.corroborated
                                ? <span className="inline-flex flex-wrap gap-1">{h.corroboration?.map(c => <Tag key={c} tone="red">{c}</Tag>)}</span>
                                : <span className="text-fg-muted">none. Recorded, but does not hold the person</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              {/* evidence */}
              <Section title="Evidence">
                <DetailList className="rounded-lg border border-line px-4">
                  <DetailRow label="Digest" hint="keccak over the evidence record"><Hash value={res.evidenceDigest} full /></DetailRow>
                  <DetailRow label="List versions">
                    <span className="flex flex-wrap gap-1.5">
                      {Object.entries(res.listVersions).map(([k, v]) => <Tag key={k} tone="gray" mono>{LIST[k]?.label ?? k} · rev {v}</Tag>)}
                    </span>
                  </DetailRow>
                  <DetailRow label="Entries loaded">
                    {Object.entries(res.listCounts).map(([k, v]) => `${LIST[k]?.label ?? k} ${v.toLocaleString()}`).join(' · ')}
                  </DetailRow>
                  <DetailRow label="Engine"><span className="font-mono text-[13px]">{res.engineVersion}</span></DetailRow>
                  <DetailRow label="Elapsed">{res.elapsedMs} ms</DetailRow>
                </DetailList>
                <Band tone="note" className="mt-3">
                  The evidence record holds <b>no name in cleartext</b>. Name fields are keyed HMAC digests. Evidence is kept for audit;
                  the vault can still be erased on request. The key holder can still confirm a candidate, which is the point of pseudonymisation.
                </Band>
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Group({ group: g }: { group: MethodGroup }) {
  return (
    <>
      <tr className="group">
        <td colSpan={3}>
          {g.group}
          <span className="ml-2 text-xs font-normal text-fg-muted">{g.note}</span>
        </td>
      </tr>
      {g.items.map(m => {
        const bit = bitOf(m.key);
        return (
          <tr key={m.key}>
            <td className={m.set ? 'text-fg-strong' : 'text-fg-muted'}>{m.label}</td>
            <td><span className="font-mono text-[13px] text-fg-muted">{bit !== undefined ? `1 << ${bit}` : '—'}</span></td>
            <td>{m.set ? <Tag tone="green">Performed</Tag> : <Tag tone="gray">Not run</Tag>}</td>
          </tr>
        );
      })}
    </>
  );
}
