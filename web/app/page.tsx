'use client';

import { useEffect, useState } from 'react';
import { Button, LinkButton } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Section, Eyebrow } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';

type Decision = 'ALLOW' | 'BLOCK' | 'REVIEW';
type MethodGroup = { group: string; note: string; items: { key: string; label: string; set: boolean }[] };
type Hit = {
  listId: string; entryId: string; matchedName: string; score: number;
  matchType: string; corroborated: boolean; corroboration?: string[];
};
type Meta = {
  engineVersion: string; listVersions: Record<string, number>; listCounts: Record<string, number>;
  builtAt?: string; sourceUpdatedAt?: Record<string, string>;
};
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
  { label: 'Kim Jong Un · KP', hint: 'DOB and country corroborate the name match',
    v: { fullName: 'Kim Jong Un', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '' } },
  { label: 'Choi Yeong-ho · KR', hint: 'Collides with a listed name; nothing corroborates it',
    v: { fullName: 'Choi Yeong-ho', dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '' } },
  { label: 'Sanctioned wallet', hint: 'The address itself is on the OFAC list',
    v: { fullName: 'Totally Unrelated Person', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US',
         walletAddress: '0x252a8bd2319d8a555b872990601221b3a2053bce' } },
  { label: 'Park Seo-jun · KR', hint: 'An ordinary name. Must pass cleanly',
    v: { fullName: 'Park Seo-jun', dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '' } },
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
        eyebrow="Creditcoin compliance gateway"
        title="External credentials in. Policy-ready state on Creditcoin."
        lede="Proofmark normalizes what an identity provider actually checked, proves the source event through Attestcoin, and lets each Creditcoin application enforce its own frozen policy."
      />

      <div className="panel overflow-hidden">
        <div className="grid gap-px bg-line md:grid-cols-3">
          {[
            ['1 · Verify', 'A configured identity rail checks the document, account and sanctions sources. Sandbox results stay sandbox.'],
            ['2 · Prove', 'The issuer emits on Ethereum; Attestcoin proves that exact source transaction to the ASC on Creditcoin.'],
            ['3 · Enforce', 'The registry checks methods, regime, jurisdiction, freshness and issuer. A frozen policy gates the RWA note.'],
          ].map(([title, copy]) => (
            <div key={title} className="bg-surface p-4">
              <div className="text-sm font-semibold text-fg-strong">{title}</div>
              <p className="mt-1.5 text-[13px] leading-5 text-fg-muted">{copy}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
          <LinkButton href="/verify" variant="primary"><Icon name="user" size={16} />Run the full journey</LinkButton>
          <LinkButton href="/onchain"><Icon name="block" size={16} />Read live CC3 state</LinkButton>
        </div>
      </div>

      <div className="mb-4 mt-10">
        <Eyebrow>Live component</Eyebrow>
        <h2 className="mt-1 text-xl font-semibold text-fg-strong">Sanctions screening</h2>
        <p className="mt-1 text-sm text-fg-muted">OFAC SDN, UN Consolidated and EU FSF{totalEntries ? <> — <span className="text-fg-strong">{totalEntries.toLocaleString()}</span> entries</> : null}, parsed from source XML and rejected when stale.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
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
                <span className="mono ml-auto text-fg-muted">risk {res.riskBand}/5</span>
              </div>

              {/* checks */}
              <Section title="Checks performed" className="mt-6"
                aside={<>methods <Tag tone="gray" mono>{res.methodsHex}</Tag></>}
                lede="A bit is set only when the check ran. An unset bit is what lets a consumer policy reject this mark.">
                <div className="panel overflow-hidden">
                  <table className="tbl">
                    <thead><tr><th>Check</th><th className="w-32">Status</th></tr></thead>
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
                                : <span className="text-fg-muted">none · does not hold the person</span>}
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
                  <DetailRow label="Lists">
                    <span className="mono text-fg-muted">
                      {Object.entries(res.listVersions).map(([k, v]) => `${LIST[k]?.label ?? k} rev ${v}`).join(' · ')}
                    </span>
                  </DetailRow>
                  {res.sourceUpdatedAt && <DetailRow label="Source refresh"><span className="mono text-fg-muted">{Object.values(res.sourceUpdatedAt).sort()[0]}</span></DetailRow>}
                </DetailList>
                <Band tone="note" className="mt-3">
                  The record holds <b className="font-medium text-fg-strong">no name in cleartext</b> — name fields are keyed HMAC digests,
                  so the vault can be erased on request while the key holder can still confirm a candidate.
                </Band>
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Checks that ran get a row each; checks that did not collapse into one muted line per group. */
function Group({ group: g }: { group: MethodGroup }) {
  const run = g.items.filter(m => m.set);
  const idle = g.items.filter(m => !m.set);
  return (
    <>
      <tr className="grp">
        <td colSpan={2}>{g.group}<span className="note">{g.note}</span></td>
      </tr>
      {run.map(m => (
        <tr key={m.key}>
          <td className="font-medium text-fg-strong">{m.label}</td>
          <td><Tag tone="ok">Performed</Tag></td>
        </tr>
      ))}
      {idle.length > 0 && (
        <tr>
          <td className="text-fg-muted">{idle.map(m => m.label).join(' · ')}</td>
          <td><Tag tone="gray">Not run</Tag></td>
        </tr>
      )}
    </>
  );
}
