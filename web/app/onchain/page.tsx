'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Stats, Stat } from '@/components/ui/Stat';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Section } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';
import { cc3Address, cc3Block, sepoliaAddress } from '@/lib/links';
import { METHOD_BITS, setBits } from '@/lib/methods';

type Policy = {
  id: number; name: string; requireAll: number; requireAllHex: string;
  minAssurance: number; maxAge: number; requiredRegime: number; requiredJurisdiction: number;
  trustedIssuer: string; requireRoster: boolean; exists: boolean; frozen: boolean; verified: boolean;
};
type Data = {
  subject: string; blockNumber: number;
  asc: { address: string; expectedChainKey: number; sourceContract: string };
  registry: { address: string; proofMode: boolean };
  tombstone: boolean;
  mark: {
    status: number; origin: number; kind: number; assurance: number; regime: number; jurisdiction: number;
    methods: number; methodsHex: string; issuedAt: number; expiry: number; epoch: number;
    claimsRoot: string; evidenceHash: string; issuer: string; issuerTombstoned: boolean;
  };
  policies: Policy[];
  epoch: { latestEpoch: number; root: string | null; validUntil: number; fresh: boolean };
};

/** An active sandbox mark and an unissued control tell the fail-closed story. */
const SUBJECTS = [
  { key: 'active', label: 'Active sandbox mark', subject: null as string | null, note: 'Issued by the pipeline with only the checks it ran.' },
  { key: 'control', label: 'Unissued control', subject: '0x00000000000000000000000000000000DeaDBeef', note: 'No mark exists, so every policy fails closed.' },
];

const STATUS: Record<number, { label: string; tone: Tone }> = {
  0: { label: 'NONE', tone: 'gray' }, 1: { label: 'ACTIVE', tone: 'ok' }, 2: { label: 'REVOKED', tone: 'bad' },
  3: { label: 'DENIED', tone: 'bad' }, 4: { label: 'SUSPENDED', tone: 'warn' },
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

function Header({ block }: { block?: number }) {
  return (
    <PageHeader
      title="On-chain state"
      lede="Read live from Creditcoin CC3 Testnet on every request. Nothing here is cached or staged."
      aside={block !== undefined
        ? <a href={cc3Block(block)} target="_blank" rel="noreferrer" className="link mono inline-flex items-center gap-1.5">
            <Icon name="block" size={14} />Block {block.toLocaleString()}<Icon name="external" size={12} className="text-fg-subtle" />
          </a>
        : <span className="mono text-fg-muted">reading chain…</span>}
    />
  );
}

function Loading() {
  return (
    <>
      <Header />
      <div className="h-8 w-56 animate-pulse rounded-sm bg-surface" />
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line lg:grid-cols-4">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-[68px] animate-pulse bg-surface" />)}
      </div>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {[0, 1].map(i => <div key={i} className="h-72 animate-pulse rounded-md bg-surface" />)}
      </div>
    </>
  );
}

function SubjectTabs({ current }: { current: string | null }) {
  return (
    <div className="inline-flex h-8 items-center gap-0.5 rounded-sm border border-line bg-sunk p-0.5" role="tablist" aria-label="Subject">
      {SUBJECTS.map(s => {
        const active = (s.subject ?? null) === current;
        return (
          <Link key={s.key} role="tab" aria-selected={active} title={s.note}
            href={s.subject ? `/onchain?subject=${s.subject}` : '/onchain'}
            className={`inline-flex h-full items-center rounded-[3px] px-3 text-[13px] font-medium transition-colors ${
              active ? 'bg-surface-2 text-fg-strong' : 'text-fg-muted hover:text-fg-strong'}`}>
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}

function PolicyCard({ p, mark, revoked }: { p: Policy; mark: Data['mark']; revoked: boolean }) {
  const mask = mark.methods;
  const required = METHOD_BITS.filter(b => (p.requireAll & (1 << b.bit)) !== 0);
  const missing = required.filter(b => (mask & (1 << b.bit)) === 0);
  const why = p.verified
    ? 'Every required check is present on this mark.'
    : revoked
      ? 'Revoked. A tombstone outranks every policy: deny beats allow.'
      : missing.length
        ? `Missing ${missing.length} of ${required.length} required checks.`
        : p.requiredRegime && p.requiredRegime !== mark.regime
          ? `Regime mismatch: mark ${mark.regime}, policy ${p.requiredRegime}.`
          : p.requiredJurisdiction && p.requiredJurisdiction !== mark.jurisdiction
            ? `Jurisdiction mismatch: mark ${mark.jurisdiction}, policy ${p.requiredJurisdiction}.`
            : p.trustedIssuer !== '0x0000000000000000000000000000000000000000' && p.trustedIssuer.toLowerCase() !== mark.issuer.toLowerCase()
              ? 'Issuer is not the address pinned by this policy.'
              : 'Rejected on assurance, freshness or expiry.';
  return (
    <div className="panel flex flex-col overflow-hidden" data-policy={p.name} data-result={p.verified ? 'PASS' : 'FAIL'}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-5 text-fg-strong">{p.name}</div>
          <div className="mono mt-0.5 text-fg-muted">policy #{p.id} · {p.frozen ? 'frozen' : 'mutable'} · requireAll {p.requireAllHex}</div>
        </div>
        <Tag tone={p.verified ? 'ok' : 'bad'} size="lg">{p.verified ? 'PASS' : 'FAIL'}</Tag>
      </div>
      <ul className="flex-1 px-4">
        {required.map(b => {
          const ok = (mask & (1 << b.bit)) !== 0;
          return (
            <li key={b.key} data-missing={ok ? undefined : b.label}
              className="grid h-10 grid-cols-[16px_minmax(0,1fr)_64px_72px] items-center gap-3 border-b border-divider text-[13px] last:border-b-0">
              <Icon name={ok ? 'check' : 'x'} size={16} className={ok ? 'text-ok' : 'text-bad'} />
              <span className={`truncate ${ok ? 'font-medium text-fg-strong' : 'text-fg-muted'}`}>{b.label}</span>
              <span className="mono text-right text-fg-subtle">1 &lt;&lt; {b.bit}</span>
              <Tag tone={ok ? 'ok' : 'bad'} className="w-full justify-center">{ok ? 'present' : 'missing'}</Tag>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-line px-4 py-3">
        <div className={`text-[13px] leading-5 ${p.verified ? 'text-ok' : 'text-bad'}`}>{why}</div>
        <div className="mono mt-1 text-fg-muted">
          min assurance {p.minAssurance} · max age {days(p.maxAge)} · roster {p.requireRoster ? 'required' : 'not required'}
        </div>
        <div className="mono mt-1 text-fg-muted">
          regime {p.requiredRegime || 'any'} · jurisdiction {p.requiredJurisdiction || 'any'} · issuer {p.trustedIssuer.slice(0, 8)}…
        </div>
      </div>
    </div>
  );
}

/**
 * Mode B state, read from the ASC.
 *
 * Two states and no third. Before an epoch exists there is nothing to dress up: every mark on the
 * chain is `origin = Direct`, which proves issuance and is silent about a revocation nobody
 * submitted, and the page says exactly that. After one exists, the root and its expiry are shown
 * with the freshness the contract itself reports, because an expired roster verifies nobody.
 */
function EpochRoster({ e, proofMode }: { e: Data['epoch']; proofMode: boolean }) {
  const published = e.latestEpoch >= 1;
  return (
    <Section title="Epoch roster (Mode B)"
      aside={<Tag tone={published ? (e.fresh ? 'ok' : 'bad') : 'gray'}>{published ? (e.fresh ? 'fresh' : 'expired') : 'not published'}</Tag>}
      lede="Mode A carries one mark at a time. Mode B publishes the whole active set as one sorted-key Merkle root, so falling out of the root is the revocation.">
      <DetailList>
        <DetailRow label="Latest epoch" hint="ProofmarkASC.latestEpoch()">
          <span className="mono">{e.latestEpoch}</span>
          {!published && <span className="text-fg-muted"> · none published</span>}
        </DetailRow>
        <DetailRow label="Roster root" hint="ProofmarkASC.epochRoots(latestEpoch)">
          {e.root ? <Hash value={e.root} full /> : <span className="text-fg-muted">not set</span>}
        </DetailRow>
        <DetailRow label="Valid until" hint="ProofmarkASC.epochValidUntil()">
          <span className="mono">{e.validUntil ? ts(e.validUntil) : '—'}</span>
        </DetailRow>
        <DetailRow label="Freshness" hint="ProofmarkASC.isRosterFresh()">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Tag tone={e.fresh ? 'ok' : 'bad'}>{e.fresh ? 'fresh' : 'not fresh'}</Tag>
            <span className="text-fg-muted">
              {e.fresh
                ? (proofMode ? 'verifyWithRoster answers' : 'inside its validity window')
                : 'verifyWithRoster fails closed for every subject'}
            </span>
          </span>
        </DetailRow>
        <DetailRow label="Proof mode" hint="verifyWithRoster and proveNotInRoster in the deployed registry's runtime code">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Tag tone={proofMode ? 'ok' : 'warn'}>{proofMode ? 'in deployed registry' : 'not in deployed build'}</Tag>
            <span className="text-fg-muted">{proofMode ? 'the registry can answer against this root' : 'cache mode only, so this root is not read on chain yet'}</span>
          </span>
        </DetailRow>
      </DetailList>
      {/* Band takes no arbitrary props, so the marker attribute lives on the wrapper. */}
      <div data-epoch={published ? 'published' : 'none'}>
      <Band tone="note" className="mt-3">
        {published ? (
          <>
            <p>
              Membership in this root is the mark; absence from it is what <code className="mono text-fg-strong">proveNotInRoster</code> turns
              into positive evidence of revocation. Past <code className="mono text-fg-strong">validUntil</code>,
              {' '}<code className="mono text-fg-strong">verifyWithRoster</code> answers for nobody.
            </p>
            {!proofMode && (
              <p className="mt-1.5 text-fg-muted">
                The registry deployed here is an earlier build without the roster views, so this root is real but not yet read on chain.
                Cache mode — the policy cards above — is unaffected.
              </p>
            )}
          </>
        ) : (
          <p>
            No epoch has been published, so every mark here is <code className="mono text-fg-strong">origin = Direct</code>: proof of
            issuance, silent about a revocation nobody submitted cross-chain.
          </p>
        )}
      </Band>
      </div>
    </Section>
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
      <Header />
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
      <Header block={d.blockNumber} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubjectTabs current={subject} />
        <span className="inline-flex items-center gap-2 text-xs text-fg-muted">
          subject <Hash value={d.subject} href={cc3Address(d.subject)} head={10} tail={6} />
        </span>
      </div>

      {/* ── stats ── */}
      <Stats className="mt-4">
        <Stat label="Mark status" value={<Status tone={status.tone}>{status.label}</Status>} sub={d.tombstone ? 'tombstoned' : undefined} />
        <Stat label="Policies passed" value={`${passed} / ${d.policies.length}`} />
        <Stat label="Assurance" value={`Level ${m.assurance}`} sub={REGIME[m.regime]} />
        <Stat label="Jurisdiction" value={ISO_NUMERIC[m.jurisdiction]?.split(' · ')[0] ?? m.jurisdiction} sub={`ISO ${m.jurisdiction}`} />
      </Stats>

      {/* ── policies: the demo scene ── */}
      <Section title="Same mark, two policies"
        aside={<>methods <Tag tone="gray" mono>{m.methodsHex}</Tag></>}
        lede="The mark carries the checks that were performed; each consumer decides whether that meets its own regime.">
        <div className="grid gap-4 md:grid-cols-2">
          {d.policies.map(p => <PolicyCard key={p.id} p={p} mark={m} revoked={revoked} />)}
        </div>
      </Section>

      {revoked && (
        <Section title="Why this mark was revoked">
          <Band tone="bad">
            <p>
              Its <code className="mono text-fg-strong">methods</code> were hand-authored during pipeline validation, so it asserted checks that never
              happened — the failure this product exists to prevent. We revoked it on-chain
              (reason <code className="mono text-fg-strong">ISSUER_ERROR</code>); propagation back to Creditcoin took 8m 43s.
            </p>
            <p className="mt-1.5 text-fg-muted">A mark may not claim a check that did not happen.</p>
          </Band>
        </Section>
      )}

      {/* ── mark ── */}
      <Section title="Mark">
        <DetailList>
          <DetailRow label="Subject" hint="The wallet the mark is bound to"><Hash value={d.subject} href={cc3Address(d.subject)} full /></DetailRow>
          <DetailRow label="Issuer" hint="Address that issued on the source chain"><Hash value={m.issuer} href={sepoliaAddress(m.issuer)} full /></DetailRow>
          <DetailRow label="Status">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Tag tone={status.tone}>{status.label}</Tag>
              {d.tombstone && <Tag tone="bad">tombstone</Tag>}
            </span>
          </DetailRow>
          <DetailRow label="Origin · regime">
            {ORIGIN[m.origin] ?? m.origin} · kind {m.kind} · regime {m.regime}{REGIME[m.regime] ? ` (${REGIME[m.regime]})` : ''}
          </DetailRow>
          <DetailRow label="Jurisdiction">{ISO_NUMERIC[m.jurisdiction] ?? m.jurisdiction} <span className="text-fg-muted">· ISO 3166-1 numeric {m.jurisdiction}</span></DetailRow>
          <DetailRow label="Methods" hint="Checks the issuer claims to have performed">
            <span className="flex flex-wrap items-center gap-1.5">
              <Tag tone="gray" mono>{m.methodsHex}</Tag>
              {claims.map(c => <Tag key={c.key} tone="mint">{c.label}</Tag>)}
              {claims.length === 0 && <span className="text-fg-muted">no bits set</span>}
            </span>
          </DetailRow>
          <DetailRow label="Claims root"><Hash value={m.claimsRoot} full /></DetailRow>
          <DetailRow label="Evidence hash"><Hash value={m.evidenceHash} full /></DetailRow>
          <DetailRow label="Issued · expiry"><span className="mono">{ts(m.issuedAt)} <span className="text-fg-muted">→</span> {ts(m.expiry)}</span></DetailRow>
          <DetailRow label="Epoch"><span className="mono">{m.epoch}</span></DetailRow>
        </DetailList>
        <Band tone="note" className="mt-3">
          Two 32-byte commitments. No name, date of birth, document number, or account number is on chain. Wallet-linked metadata remains pseudonymous and linkable.
        </Band>
        {m.issuerTombstoned && (
          /* Band takes no arbitrary props, so the marker attribute lives on the wrapper. */
          <div data-note="issuer-reuse">
            <Band tone="note" className="mt-3">
              This mark&rsquo;s issuer is itself tombstoned as a subject here &mdash; testnet address reuse, not a compromised key.
              Verification never consults it: <code className="mono text-fg-strong">isVerified</code> checks the subject only.
            </Band>
          </div>
        )}
      </Section>

      {/* ── verifier ── */}
      <Section title="Verifier · ProofmarkASC" lede="What the Attestcoin Source Contract will accept. A proof from any other chain or contract reverts.">
        <DetailList>
          <DetailRow label="Contract"><Hash value={d.asc.address} href={cc3Address(d.asc.address)} full /></DetailRow>
          <DetailRow label="Expected chain key">
            <span className="inline-flex items-center gap-2"><Tag tone="gray" mono>{d.asc.expectedChainKey}</Tag>{CHAIN_KEY[d.asc.expectedChainKey] ?? 'unknown chain'}</span>
          </DetailRow>
          <DetailRow label="Source contract"><Hash value={d.asc.sourceContract} href={sepoliaAddress(d.asc.sourceContract)} full /></DetailRow>
          <DetailRow label="Registry"><Hash value={d.registry.address} href={cc3Address(d.registry.address)} full /></DetailRow>
        </DetailList>
      </Section>

      {/* ── epoch roster ── */}
      <EpochRoster e={d.epoch} proofMode={d.registry.proofMode} />
    </>
  );
}
