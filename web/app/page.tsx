'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Stats, Stat } from '@/components/ui/Stat';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Section, Eyebrow } from '@/components/ui/Page';
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

const DECISION: Record<Decision, { tone: Tone; edge: string; text: string }> = {
  ALLOW: { tone: 'ok', edge: 'border-l-ok', text: 'No corroborated match. The mark may carry the sanctions bit.' },
  REVIEW: { tone: 'warn', edge: 'border-l-warn', text: 'A candidate matched but nothing corroborates it. A person decides.' },
  BLOCK: { tone: 'bad', edge: 'border-l-bad', text: 'A listed party was corroborated. No mark is issued.' },
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
      <PageHeader
        eyebrow="Proofmark · KYC/AML attestation layer"
        title="Sanctions screening"
        lede="OFAC SDN, UN Consolidated and EU FSF, parsed from the source XML. The engine records what it checked and nothing more."
        aside={<span className="mono text-fg-muted">engine <span className="text-fg-strong">{info?.engineVersion ?? '—'}</span></span>}
      />

      {/* ── lists ── */}
      <Stats>
        {Object.keys(LIST).map(id => (
          <Stat key={id}
            label={<>{LIST[id].label} <span className="text-fg-subtle">· {LIST[id].source}</span></>}
            value={info ? info.listCounts[id]?.toLocaleString() ?? '—' : '…'}
            sub={info?.listVersions[id] ? <span className="mono">rev {info.listVersions[id]}</span> : undefined} />
        ))}
        <Stat label="Entries loaded" value={totalEntries?.toLocaleString() ?? '…'} sub="3 lists" />
      </Stats>

      <div className="mt-8 grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ── input ── */}
        <div>
          <div className="panel p-4">
            <div className="grid gap-3.5">
              {FIELDS.map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint || undefined}>
                  <Input value={form[k]} onChange={set(k)} spellCheck={false} />
                </Field>
              ))}
              <Field label="Wallet address" hint="optional">
                <Input value={form.walletAddress} onChange={set('walletAddress')} spellCheck={false} placeholder="0x…" className="mono" />
              </Field>
            </div>
            <Button onClick={() => screen()} disabled={busy} className="mt-4 w-full">
              <Icon name="search" size={16} />{busy ? 'Screening…' : 'Run screening'}
            </Button>
            {err && <Band tone="bad" className="mt-3">{err}</Band>}
          </div>

          <Eyebrow className="mb-2 mt-6">Try these</Eyebrow>
          <div className="panel overflow-hidden">
            {PRESETS.map(p => (
              <button key={p.label} type="button" onClick={() => { setForm(p.v); screen(p.v); }} disabled={busy}
                className="group flex w-full items-start gap-3 border-b border-divider px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-2 disabled:opacity-60">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium leading-5 text-fg-strong">{p.label}</div>
                  <div className="mt-0.5 text-xs leading-4 text-fg-muted">{p.hint}</div>
                </div>
                <Icon name="arrow" size={14} className="mt-[3px] shrink-0 text-fg-subtle transition-colors group-hover:text-mint" />
              </button>
            ))}
          </div>
        </div>

        {/* ── result ── */}
        <div className="min-w-0">
          {!res && (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-md border border-dashed border-line-strong px-6 text-center">
              <Icon name="shield" size={24} className="text-fg-subtle" />
              <div className="mt-3 text-sm font-medium text-fg-strong">No screening yet</div>
              <p className="mt-1 max-w-xs text-[13px] leading-5 text-fg-muted">
                Run one to see the decision, the evidence, and what was <span className="text-fg-strong">not</span> checked.
              </p>
            </div>
          )}

          {res && (
            <>
              {/* verdict */}
              <div className={`panel flex flex-wrap items-center gap-x-4 gap-y-2 border-l-2 px-4 py-3 ${DECISION[res.decision].edge}`}>
                <Status tone={DECISION[res.decision].tone} className="text-base leading-6">{res.decision}</Status>
                <span className="text-[13px] leading-5 text-fg">{DECISION[res.decision].text}</span>
                {res.reviewReason && <Tag tone="gray" mono>{res.reviewReason}</Tag>}
                <span className="mono ml-auto text-fg-muted">risk {res.riskBand}/5 · {res.elapsedMs} ms</span>
              </div>

              {/* checks */}
              <Section title="Checks performed" className="mt-6"
                aside={<>methods <Tag tone="gray" mono>{res.methodsHex}</Tag></>}
                lede="A bit is set only when the check ran. An unset bit is what lets a consumer policy reject this mark.">
                <div className="panel overflow-hidden">
                  <table className="tbl">
                    <thead><tr><th>Check</th><th className="num w-24">Bit</th><th className="w-32">Status</th></tr></thead>
                    <tbody>
                      {res.methodGroups.map(g => <Group key={g.group} group={g} />)}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* hits */}
              <Section title={<>List matches <span className="font-normal text-fg-muted">{res.hits.length}</span></>}>
                {res.hits.length === 0 ? (
                  <div className="panel px-4 py-3 text-[13px] text-fg-muted">No candidate matched above threshold.</div>
                ) : (
                  <div className="panel overflow-x-auto">
                    <table className="tbl">
                      <thead><tr><th>Matched name</th><th>Type</th><th className="num">Score</th><th>Source</th><th>Corroboration</th></tr></thead>
                      <tbody>
                        {res.hits.map((h, i) => (
                          <tr key={i}>
                            <td className="font-medium text-fg-strong">{h.matchedName}</td>
                            <td><Tag tone={h.corroborated ? 'warn' : 'gray'}>{h.matchType}</Tag></td>
                            <td className="num">{h.score}</td>
                            <td className="mono text-fg-muted">{LIST[h.listId]?.label ?? h.listId} · {h.entryId}</td>
                            <td>
                              {h.corroborated
                                ? <span className="inline-flex flex-wrap gap-1">{h.corroboration?.map(c => <Tag key={c} tone="bad">{c}</Tag>)}</span>
                                : <span className="text-fg-muted">none · recorded, but does not hold the person</span>}
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
                <DetailList>
                  <DetailRow label="Digest" hint="keccak over the evidence record"><Hash value={res.evidenceDigest} full /></DetailRow>
                  <DetailRow label="List versions">
                    <span className="flex flex-wrap gap-1.5">
                      {Object.entries(res.listVersions).map(([k, v]) => <Tag key={k} tone="gray" mono>{LIST[k]?.label ?? k} · rev {v}</Tag>)}
                    </span>
                  </DetailRow>
                  <DetailRow label="Entries loaded">
                    {Object.entries(res.listCounts).map(([k, v]) => `${LIST[k]?.label ?? k} ${v.toLocaleString()}`).join(' · ')}
                  </DetailRow>
                  <DetailRow label="Engine"><span className="mono">{res.engineVersion}</span></DetailRow>
                  <DetailRow label="Elapsed"><span className="mono">{res.elapsedMs} ms</span></DetailRow>
                </DetailList>
                <Band tone="note" className="mt-3">
                  The evidence record holds <b className="font-medium text-fg-strong">no name in cleartext</b>. Name fields are keyed HMAC digests. Evidence is kept for audit;
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
      <tr className="grp">
        <td colSpan={3}>{g.group}<span className="note">{g.note}</span></td>
      </tr>
      {g.items.map(m => {
        const bit = bitOf(m.key);
        return (
          <tr key={m.key}>
            <td className={m.set ? 'font-medium text-fg-strong' : 'text-fg-muted'}>{m.label}</td>
            <td className="num mono text-fg-muted">{bit !== undefined ? `1 << ${bit}` : '—'}</td>
            <td>{m.set ? <Tag tone="ok">Performed</Tag> : <Tag tone="gray">Not run</Tag>}</td>
          </tr>
        );
      })}
    </>
  );
}
