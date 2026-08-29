'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Tag, type Tone } from '@/components/ui/Tag';
import { StatCard } from '@/components/ui/StatCard';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageTitle, Section } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';
import { cc3Address, cc3Block, sepoliaAddress } from '@/lib/links';
import { METHOD_BITS, setBits } from '@/lib/methods';

type Policy = {
  id: number; name: string; requireAll: number; requireAllHex: string;
  minAssurance: number; maxAge: number; requireRoster: boolean; exists: boolean; verified: boolean;
};
type Data = {
  subject: string; blockNumber: number;
  asc: { address: string; expectedChainKey: number; sourceContract: string };
  registry: { address: string };
  tombstone: boolean;
  mark: {
    status: number; origin: number; kind: number; assurance: number; regime: number; jurisdiction: number;
    methods: number; methodsHex: string; issuedAt: number; expiry: number; epoch: number;
    claimsRoot: string; evidenceHash: string; issuer: string;
  };
  policies: Policy[];
};

/** Two subjects tell the story. The default (no query) is whatever the API considers the current honest mark. */
const SUBJECTS = [
  { key: 'honest', label: 'Honest mark', subject: null as string | null, note: 'Issued by the pipeline with only the checks it ran.' },
  { key: 'revoked', label: 'Revoked mark', subject: '0xFD1222e35a536A62f180aA44826656940e86bD5E', note: 'Claimed checks that never happened, so we revoked it.' },
];

const STATUS: Record<number, { label: string; tone: Tone }> = {
  0: { label: 'NONE', tone: 'gray' }, 1: { label: 'ACTIVE', tone: 'green' }, 2: { label: 'REVOKED', tone: 'red' },
  3: { label: 'DENIED', tone: 'red' }, 4: { label: 'SUSPENDED', tone: 'orange' },
};
const ORIGIN = ['None', 'Direct', 'Roster'];
const REGIME: Record<number, string> = { 1: 'production', 2: 'sandbox' };
const CHAIN_KEY: Record<number, string> = { 1: 'Ethereum Sepolia' };
const ISO_NUMERIC: Record<number, string> = { 410: 'KR · Korea', 840: 'US · United States', 276: 'DE · Germany', 826: 'GB · United Kingdom', 392: 'JP · Japan' };

const ts = (sec: number) => (sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const days = (sec: number) => (sec ? `${Math.round(sec / 86400)} d` : 'no limit');

export default function OnChain() {
  return <Suspense fallback={<Loading />}><OnChainView /></Suspense>;
}

function Loading() {
  return (
    <>
      <PageTitle lede="Reading Creditcoin CC3 Testnet…">On-chain state</PageTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-surface" />)}
      </div>
      <div className="mt-8 h-64 animate-pulse rounded-lg bg-surface" />
    </>
  );
}

function SubjectTabs({ current }: { current: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Subject">
      {SUBJECTS.map(s => {
        const active = (s.subject ?? null) === current;
        return (
          <Link key={s.key} role="tab" aria-selected={active} title={s.note}
            href={s.subject ? `/onchain?subject=${s.subject}` : '/onchain'}
            className={`inline-flex h-10 items-center rounded-md px-4 text-base font-semibold transition-colors ${
              active ? 'bg-surface-2 text-fg-strong' : 'text-fg hover:text-link'}`}>
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}

function PolicyCard({ p, mask, revoked }: { p: Policy; mask: number; revoked: boolean }) {
  const required = METHOD_BITS.filter(b => (p.requireAll & (1 << b.bit)) !== 0);
  const missing = required.filter(b => (mask & (1 << b.bit)) === 0);
  const why = p.verified
    ? 'Every required check is present on this mark.'
    : revoked
      ? 'Revoked. A tombstone outranks every policy: deny beats allow.'
      : missing.length
        ? `Missing ${missing.length} of ${required.length} required checks.`
        : 'Rejected on assurance, freshness or expiry.';
  return (
    <div className="overflow-hidden rounded-lg border border-line" data-policy={p.name} data-result={p.verified ? 'PASS' : 'FAIL'}>
      <div className="flex items-center justify-between gap-3 bg-surface px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-base font-medium text-fg-strong">{p.name}</div>
          <div className="font-mono text-xs text-fg-muted">policy #{p.id} · requireAll {p.requireAllHex}</div>
        </div>
        <Tag tone={p.verified ? 'green' : 'red'} size="lg">{p.verified ? 'PASS' : 'FAIL'}</Tag>
      </div>
      <ul className="px-4 py-2">
        {required.map(b => {
          const ok = (mask & (1 << b.bit)) !== 0;
          return (
            <li key={b.key} data-missing={ok ? undefined : b.label}
              className="flex items-center gap-2 border-b border-divider py-2 text-sm last:border-b-0">
              <Icon name={ok ? 'check' : 'x'} size={18} className={ok ? 'text-ok' : 'text-bad'} />
              <span className={`flex-1 font-medium ${ok ? 'text-fg-strong' : 'text-fg-muted'}`}>{b.label}</span>
              <span className="font-mono text-xs text-fg-subtle">1 &lt;&lt; {b.bit}</span>
              <Tag tone={ok ? 'green' : 'red'}>{ok ? 'present' : 'missing'}</Tag>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-divider px-4 py-3 text-sm">
        <div className={p.verified ? 'text-ok-fg' : 'text-bad-fg'}>{why}</div>
        <div className="mt-1 text-xs text-fg-muted">
          min assurance {p.minAssurance} · max age {days(p.maxAge)} · roster {p.requireRoster ? 'required' : 'not required'}
        </div>
      </div>
    </div>
  );
}

function OnChainView() {
  const params = useSearchParams();
  const subject = params.get('subject');
  /* Keyed by subject so switching tabs shows the loading state without a synchronous reset. */
  const [state, setState] = useState<{ key: string | null; data?: Data; err?: string }>({ key: '__init' });

  useEffect(() => {
    let live = true;
    fetch(subject ? `/api/onchain?subject=${subject}` : '/api/onchain').then(r => r.json())
      .then(j => live && setState({ key: subject, ...(j.error ? { err: String(j.error) } : { data: j as Data }) }))
      .catch(e => live && setState({ key: subject, err: String(e) }));
    return () => { live = false; };
  }, [subject]);

  const current = state.key === subject ? state : null;
  const d = current?.data ?? null;
  const err = current?.err ?? null;

  if (err) return (
    <>
      <PageTitle>On-chain state</PageTitle>
      <SubjectTabs current={subject} />
      <Band tone="bad" className="mt-4">{err}</Band>
    </>
  );
  if (!d) return <Loading />;

  const m = d.mark;
  const status = STATUS[m.status] ?? { label: String(m.status), tone: 'gray' as Tone };
  const revoked = d.tombstone || m.status === 2;
  const claims = setBits(m.methods);
  const passed = d.policies.filter(p => p.verified).length;

  return (
    <>
      <PageTitle
        aside={<a href={cc3Block(d.blockNumber)} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1.5 text-sm font-medium">
          <Icon name="block" size={16} /> Block {d.blockNumber.toLocaleString()} <Icon name="external" size={14} />
        </a>}
        lede="Read live from Creditcoin CC3 Testnet on every request. Nothing here is cached or staged.">
        On-chain state
      </PageTitle>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubjectTabs current={subject} />
        <Hash value={d.subject} href={cc3Address(d.subject)} head={10} tail={6} />
      </div>

      {/* ── stats ── */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="shield" label="Mark status"
          value={<Tag tone={status.tone}>{status.label}</Tag>} sub={d.tombstone ? 'tombstoned' : undefined} />
        <StatCard icon="policy" label="Policies passed" value={`${passed} / ${d.policies.length}`} />
        <StatCard icon="gauge" label="Assurance" value={`Level ${m.assurance}`} sub={REGIME[m.regime]} />
        <StatCard icon="globe" label="Jurisdiction" value={ISO_NUMERIC[m.jurisdiction]?.split(' · ')[0] ?? m.jurisdiction} sub={`ISO ${m.jurisdiction}`} />
      </div>

      {/* ── policies: the demo scene ── */}
      <Section title="Same mark, two policies"
        aside={<span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">methods <Tag tone="gray" mono>{m.methodsHex}</Tag></span>}
        lede="We do not claim Korean KYC equals EU KYC. The mark carries the checks that were performed; each consumer decides whether that meets its own regime.">
        <div className="grid gap-3 md:grid-cols-2">
          {d.policies.map(p => <PolicyCard key={p.id} p={p} mask={m.methods} revoked={revoked} />)}
        </div>
      </Section>

      {revoked && (
        <Section title="Why this mark was revoked">
          <Band tone="bad">
            <p>
              Its <code>methods</code> were hand-authored while we were validating the cross-chain pipeline, so the mark asserted
              checks we had never performed: document authenticity and bank-account verification. That is the failure this product
              exists to prevent, so we revoked it on-chain (reason <code>ISSUER_ERROR</code>). Propagation back to Creditcoin took 8m 43s.
            </p>
            <p className="mt-2 font-normal opacity-80">A mark may not claim a check that did not happen.</p>
          </Band>
        </Section>
      )}

      {/* ── mark ── */}
      <Section title="Mark">
        <DetailList className="rounded-lg border border-line px-4">
          <DetailRow label="Subject" hint="The wallet the mark is bound to"><Hash value={d.subject} href={cc3Address(d.subject)} full /></DetailRow>
          <DetailRow label="Issuer" hint="Address that issued on the source chain"><Hash value={m.issuer} href={sepoliaAddress(m.issuer)} full /></DetailRow>
          <DetailRow label="Status">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Tag tone={status.tone}>{status.label}</Tag>
              {d.tombstone && <Tag tone="red">tombstone</Tag>}
            </span>
          </DetailRow>
          <DetailRow label="Origin · regime">
            {ORIGIN[m.origin] ?? m.origin} · kind {m.kind} · regime {m.regime}{REGIME[m.regime] ? ` (${REGIME[m.regime]})` : ''}
          </DetailRow>
          <DetailRow label="Jurisdiction">{ISO_NUMERIC[m.jurisdiction] ?? m.jurisdiction} <span className="text-fg-muted">(ISO 3166-1 numeric {m.jurisdiction})</span></DetailRow>
          <DetailRow label="Methods" hint="Checks the issuer claims to have performed">
            <span className="flex flex-wrap items-center gap-1.5">
              <Tag tone="gray" mono>{m.methodsHex}</Tag>
              {claims.map(c => <Tag key={c.key} tone="blue">{c.label}</Tag>)}
              {claims.length === 0 && <span className="text-fg-muted">no bits set</span>}
            </span>
          </DetailRow>
          <DetailRow label="Claims root"><Hash value={m.claimsRoot} full /></DetailRow>
          <DetailRow label="Evidence hash"><Hash value={m.evidenceHash} full /></DetailRow>
          <DetailRow label="Issued · expiry">{ts(m.issuedAt)} <span className="text-fg-muted">→</span> {ts(m.expiry)}</DetailRow>
          <DetailRow label="Epoch">{m.epoch}</DetailRow>
        </DetailList>
        <Band tone="note" className="mt-3">
          Two 32-byte commitments. No name, date of birth or document number. On-chain PII is zero bytes.
        </Band>
      </Section>

      {/* ── verifier ── */}
      <Section title="Verifier (ProofmarkASC)" lede="What the Attestcoin Source Contract will accept. A proof from any other chain or contract reverts.">
        <DetailList className="rounded-lg border border-line px-4">
          <DetailRow label="Contract"><Hash value={d.asc.address} href={cc3Address(d.asc.address)} full /></DetailRow>
          <DetailRow label="Expected chain key">
            <span className="inline-flex items-center gap-2"><Tag tone="gray" mono>{d.asc.expectedChainKey}</Tag>{CHAIN_KEY[d.asc.expectedChainKey] ?? 'unknown chain'}</span>
          </DetailRow>
          <DetailRow label="Source contract"><Hash value={d.asc.sourceContract} href={sepoliaAddress(d.asc.sourceContract)} full /></DetailRow>
          <DetailRow label="Registry"><Hash value={d.registry.address} href={cc3Address(d.registry.address)} full /></DetailRow>
        </DetailList>
      </Section>
    </>
  );
}
