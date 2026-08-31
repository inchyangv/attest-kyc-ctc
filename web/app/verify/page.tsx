'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { Status } from '@/components/ui/Status';
import { Stats, Stat } from '@/components/ui/Stat';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageHeader, Eyebrow } from '@/components/ui/Page';
import { Icon } from '@/components/ui/Icon';
import { sepoliaTx } from '@/lib/links';
import { METHOD_BITS } from '@/lib/methods';

/**
 * The KR issuance flow, end to end, against the connected vendors.
 *   0 wallet control        EIP-4361 signature, checked server side
 *   1 ID document           CODEF OCR, then Government24 (resident registration card) or
 *                           Traffic Civil Service 24 (driver licence) authenticity
 *   2 bank account          holder name against the real-name number, one won with a code, code read back
 *   3 screen and issue      reconciliation, sanctions lists, claims commitment, ComplianceSource.issue on Sepolia
 * Every step hands the next an opaque sealed token. The browser never holds a holder name or a code.
 */

type Side = { configured: boolean; vendor: string | null; live: boolean; demo: boolean; env: string | null; missing: string[]; error?: string };
type Config = {
  demo: boolean; sandboxBits: boolean; id: Side; bank: Side;
  issuer: { configured: boolean; address: string | null; missing: string[] }; banks: { code: string; name: string }[];
};
type IdSummary = { docType: 'RRC' | 'DL'; docHash: string; authenticityChecked: boolean; authentic: boolean; live: boolean; vendor: string; ref: string | null; code: string | null };
type BankSummary = { bankCode: string; holderNameMasked: string; vendor: string; live: boolean; ref: string | null };
type TwoWay = { token: string; method: string; message: string | null; imageBase64: string | null };
type Onchain = { sent: boolean; txHash?: string; issuer?: string; blockNumber?: number | null; reverted?: boolean | null; reason?: string };
type Issued = {
  status: 'ISSUED' | 'DENIED' | 'REVIEW' | 'REJECTED'; reason?: string; subject?: string;
  attrs?: string; claimsRoot?: string; evidenceHash: string; methodsHex?: string; methodNames?: string[];
  regime?: number; assurance?: number; expiry?: number; passesKrProduction?: boolean; claims?: unknown; evidence: unknown; onchain?: Onchain;
};

declare global {
  interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }
}

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    const missing = Array.isArray(j.missing) && j.missing.length ? ` (${(j.missing as string[]).join(', ')})` : '';
    throw new ApiError(`${String(j.error ?? `HTTP ${r.status}`)}${missing}`, r.status, j);
  }
  return j as T;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const utf8Hex = (s: string) => '0x' + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
const isoOf = (ymd8: string) => (ymd8.length === 8 ? `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6)}` : '');
const digits = (s: string) => s.replace(/\D/g, '');

const selectCls = 'h-9 w-full rounded-sm border border-line bg-sunk px-3 text-[13px] text-fg-strong transition-colors hover:border-line-strong focus:border-mint disabled:opacity-50';

export default function Verify() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ step: string; text: string } | null>(null);

  // 0 wallet
  const [wallet, setWallet] = useState<{ address: string; proof: string } | null>(null);
  // 1 identity
  const [docType, setDocType] = useState<'RRC' | 'DL'>('RRC');
  const [image, setImage] = useState<File | null>(null);
  const [doc, setDoc] = useState({ fullName: '', birthDate: '', rrn: '', issueDate: '', licenseNumber: '', serialNo: '' });
  const [ocrNote, setOcrNote] = useState<string | null>(null);
  const [twoWay, setTwoWay] = useState<TwoWay | null>(null);
  const [secureNo, setSecureNo] = useState('');
  const [id, setId] = useState<{ proof: string; summary: IdSummary } | null>(null);
  // 2 bank
  const [bank, setBank] = useState({ bankCode: '004', accountNumber: '' });
  const [challenge, setChallenge] = useState<{ token: string; holderNameMasked: string; vendor: string; live: boolean; ref: string | null; demoCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [bankRes, setBankRes] = useState<{ proof: string; summary: BankSummary } | null>(null);
  // 3 issue
  const [country, setCountry] = useState({ nationality: 'KR', residence: 'KR' });
  const [issued, setIssued] = useState<Issued | null>(null);

  useEffect(() => { api<Config>('/api/kyc/status').then(setCfg).catch((e) => setErr({ step: 'config', text: String(e.message) })); }, []);

  const declared = useMemo(() => ({
    fullName: doc.fullName.trim(), dateOfBirth: isoOf(digits(doc.birthDate)), ...country,
  }), [doc.fullName, doc.birthDate, country]);

  async function run(step: string, fn: () => Promise<void>) {
    setBusy(step); setErr(null);
    try { await fn(); } catch (e) { setErr({ step, text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(null); }
  }

  // ── 0 wallet ──
  const connect = () => run('wallet', async () => {
    if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another EIP-1193 wallet.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[];
    const address = accounts[0];
    if (!address) throw new Error('The wallet returned no account.');
    const { message, token } = await api<{ message: string; token: string }>(`/api/kyc/wallet?address=${address}`);
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [utf8Hex(message), address] }) as string;
    const r = await api<{ address: string; walletProof: string }>('/api/kyc/wallet', json({ token, signature }));
    setWallet({ address: r.address, proof: r.walletProof });
  });

  // ── 1 identity ──
  const idForm = (action: 'ocr' | 'verify', extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set('action', action); f.set('docType', docType); if (image) f.set('image', image);
    for (const [k, v] of Object.entries({ ...doc, ...extra })) f.set(k, v);
    return f;
  };
  const readDocument = () => run('ocr', async () => {
    if (!image) throw new Error('Choose a photo of the document first.');
    const r = await api<{ fields: Partial<typeof doc & { docType: string }> }>('/api/kyc/id', { method: 'POST', body: idForm('ocr') });
    const f = r.fields;
    setDoc((d) => ({
      fullName: f.fullName ?? d.fullName, birthDate: f.birthDate ?? d.birthDate, rrn: f.rrn ?? d.rrn,
      issueDate: f.issueDate ?? d.issueDate, licenseNumber: f.licenseNumber ?? d.licenseNumber, serialNo: f.serialNo ?? d.serialNo,
    }));
    const read = Object.entries(f).filter(([k, v]) => k !== 'docType' && v).map(([k]) => k);
    setOcrNote(read.length ? `Read from the image: ${read.join(', ')}. Check every field against the card before verifying.` : 'Nothing could be read. Type the fields from the card.');
  });
  const handleIdResponse = (r: { status: string; idProof?: string; summary?: IdSummary; challenge?: Omit<TwoWay, 'token'>; twoWayToken?: string }) => {
    if (r.status === 'two_way' && r.challenge && r.twoWayToken) {
      setTwoWay({ token: r.twoWayToken, ...r.challenge }); setSecureNo('');
      return;
    }
    setTwoWay(null);
    if (r.idProof && r.summary) setId({ proof: r.idProof, summary: r.summary });
  };
  const verifyDocument = () => run('id', async () => {
    if (!image) throw new Error('A photo of the document is required.');
    setId(null);
    handleIdResponse(await api('/api/kyc/id', { method: 'POST', body: idForm('verify') }));
  });
  const answerTwoWay = () => run('id', async () => {
    if (!twoWay) return;
    const extra: Record<string, string> = twoWay.method === 'secureNo'
      ? { twoWayToken: twoWay.token, secureNo }
      : { twoWayToken: twoWay.token, simpleAuth: '1' };
    handleIdResponse(await api('/api/kyc/id', { method: 'POST', body: idForm('verify', extra) }));
  });

  // ── 2 bank ──
  const startBank = () => run('bank', async () => {
    setBankRes(null); setChallenge(null); setCode('');
    const r = await api<{ challenge: string; holderNameMasked: string; vendor: string; live: boolean; ref: string | null; demoCode?: string }>('/api/kyc/bank', json({
      action: 'start', bankCode: bank.bankCode, accountNumber: bank.accountNumber,
      birthDate: digits(doc.birthDate).slice(2), declaredName: declared.fullName,
    }));
    setChallenge({ token: r.challenge, holderNameMasked: r.holderNameMasked, vendor: r.vendor, live: r.live, ref: r.ref, demoCode: r.demoCode });
  });
  const confirmCode = () => run('bank', async () => {
    if (!challenge) return;
    try {
      const r = await api<{ bankProof: string; summary: BankSummary }>('/api/kyc/bank', json({ action: 'verify', challenge: challenge.token, code }));
      setBankRes({ proof: r.bankProof, summary: r.summary });
    } catch (e) {
      if (e instanceof ApiError && typeof e.body.challenge === 'string') setChallenge({ ...challenge, token: e.body.challenge });
      if (e instanceof ApiError && e.body.code === 'TOO_MANY_ATTEMPTS') setChallenge(null);
      throw e;
    }
  });

  // ── 3 issue ──
  const issue = () => run('issue', async () => {
    if (!wallet) throw new Error('Connect the wallet first.');
    setIssued(await api<Issued>('/api/kyc/issue', json({
      walletProof: wallet.proof, declared, idProof: id?.proof ?? null, bankProof: bankRes?.proof ?? null,
    })));
  });
  const download = () => {
    if (!issued) return;
    const blob = new Blob([JSON.stringify({ subject: issued.subject, attrs: issued.attrs, claimsRoot: issued.claimsRoot,
      evidenceHash: issued.evidenceHash, claims: issued.claims, evidence: issued.evidence, onchain: issued.onchain }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `proofmark-${(issued.subject ?? 'mark').slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const walletDone = !!wallet;
  const idDone = !!id?.summary.authentic;
  const bankDone = !!bankRes;
  const canBank = walletDone && idDone && declared.fullName.length > 0 && digits(doc.birthDate).length === 8;
  const canIssue = walletDone && idDone && bankDone;
  const vendorsMissing = cfg && (!cfg.id.configured || !cfg.bank.configured);
  const testbed = cfg && cfg.bank.configured && !cfg.bank.demo && !cfg.bank.live;
  const demoSides = cfg ? [cfg.id.demo && 'ID document', cfg.bank.demo && 'bank account'].filter(Boolean) as string[] : [];
  const bankName = (c: string) => cfg?.banks.find((b) => b.code === c)?.name ?? c;
  const sideLabel = (s: Side) => s.demo ? 'demo' : s.vendor ?? 'not configured';

  return (
    <>
      <PageHeader
        eyebrow="Proofmark · KR · FSC non-face-to-face identification"
        title="Verify and issue"
        lede="ID document against the issuing authority, one won into the account, sanctions screening, then a mark on Sepolia. Every check that runs sets its bit; nothing else does."
        aside={cfg && (
          <span className="mono text-fg-muted">
            id <span className={cfg.id.configured ? (cfg.id.demo ? 'text-warn' : 'text-fg-strong') : 'text-bad'}>{sideLabel(cfg.id)}</span>
            <span className="mx-2 text-fg-subtle">·</span>
            bank <span className={cfg.bank.configured ? (cfg.bank.demo ? 'text-warn' : 'text-fg-strong') : 'text-bad'}>{sideLabel(cfg.bank)}</span>
          </span>
        )}
      />

      {err?.step === 'config' && <Band tone="bad" className="mb-4">{err.text}</Band>}
      {cfg?.demo && demoSides.length > 0 && (
        <Band tone="warn" className="mb-4">
          <div className="font-medium text-fg-strong">Demo mode. No real vendor behind: {demoSides.join(' and ')}.</div>
          <div className="mt-1">
            The demo vendor takes the same inputs and runs the same procedure, but asks no institution. The mark is issued with regime
            <span className="mono"> KR_FSC_NONFACE_SANDBOX</span>, the evidence names <span className="mono">demo:*</span>,
            {cfg.sandboxBits
              ? <> and the bits are set anyway (<span className="mono">KYC_DEMO_BITS=1</span>). The one-won code appears on this page in place of the bank app.</>
              : <> and the bits stay unset (<span className="mono">KYC_DEMO_BITS=0</span>).</>}
            {' '}Try a name containing <span className="mono">FAKE</span> for a rejected document, or an account ending in <span className="mono">99</span> for a holder mismatch.
          </div>
        </Band>
      )}
      {vendorsMissing && (
        <Band tone="warn" className="mb-4">
          <div className="font-medium text-fg-strong">A vendor is not configured on this deployment, so that step cannot run. There is no mock.</div>
          {!cfg.id.configured && <div className="mt-1">ID document (CODEF): {cfg.id.error ?? <span className="mono">{cfg.id.missing.join(' ')}</span>}</div>}
          {!cfg.bank.configured && <div className="mt-1">Bank account ({cfg.bank.vendor ?? 'openbanking'}): {cfg.bank.error ?? <span className="mono">{cfg.bank.missing.join(' ')}</span>}</div>}
        </Band>
      )}
      {testbed && (
        <Band tone="note" className="mb-4">
          Bank vendor <span className="mono text-fg-strong">{cfg.bank.vendor}</span> is the KFTC testbed: the real API, canned answers, no money moves.
          The flow runs end to end, and the <span className="mono">BANK_ACCOUNT</span> bit stays unset because nothing was actually verified.
        </Band>
      )}
      {cfg && !cfg.issuer.configured && (
        <Band tone="note" className="mb-4">Issuer key not set (<span className="mono">{cfg.issuer.missing.join(' ')}</span>): the pipeline runs, the Sepolia transaction is skipped.</Band>
      )}

      <Stats>
        <Stat label="0 · Wallet control" value={walletDone ? <Status tone="ok">Signed</Status> : <Status tone="gray">Pending</Status>}
          sub={wallet ? <span className="mono">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span> : 'EIP-4361'} />
        <Stat label="1 · ID document" value={id ? (id.summary.authentic ? <Status tone="ok">Authentic</Status> : <Status tone="bad">Rejected</Status>) : twoWay ? <Status tone="warn">Captcha</Status> : <Status tone="gray">Pending</Status>}
          sub={id ? <span className="mono">{id.summary.vendor}{id.summary.live ? '' : ' · not live'}</span> : cfg?.id.demo ? 'demo vendor' : docType === 'RRC' ? 'Government24' : 'Traffic Civil Service 24'} />
        <Stat label="2 · Bank account" value={bankDone ? <Status tone="ok">Verified</Status> : challenge ? <Status tone="warn">₩1 sent</Status> : <Status tone="gray">Pending</Status>}
          sub={bankRes ? <span className="mono">{bankRes.summary.vendor}{bankRes.summary.live ? '' : ' · not live'}</span> : cfg?.bank.demo ? 'demo vendor' : 'holder name + one won'} />
        <Stat label="3 · Mark" value={issued ? <Status tone={issued.status === 'ISSUED' ? 'ok' : issued.status === 'REVIEW' ? 'warn' : 'bad'}>{issued.status}</Status> : <Status tone="gray">Pending</Status>}
          sub={issued?.onchain?.txHash ? <span className="mono">Sepolia</span> : 'screen · commit · issue'} />
      </Stats>

      <div className="mt-8 grid gap-4">
        {/* ── 0 wallet ── */}
        <Step n={0} title="Wallet control" state={walletDone ? 'done' : 'active'} tag={walletDone ? <Tag tone="ok">WALLET_CONTROL</Tag> : <Tag tone="gray">1 &lt;&lt; 0</Tag>}>
          <p className="text-[13px] leading-5 text-fg-muted">
            Sign an EIP-4361 message with the wallet the mark will be bound to. The server checks the signature; the message expires in ten minutes.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={connect} disabled={busy !== null || walletDone}><Icon name="wallet" size={16} />{walletDone ? 'Signed' : busy === 'wallet' ? 'Waiting for the wallet…' : 'Connect and sign'}</Button>
            {wallet && <Hash value={wallet.address} full />}
          </div>
          <StepError err={err} step="wallet" />
        </Step>

        {/* ── 1 identity ── */}
        <Step n={1} title="ID document" state={idDone ? 'done' : walletDone ? 'active' : 'locked'}
          tag={id ? <Tag tone={id.summary.authentic ? 'ok' : 'bad'}>{id.summary.authentic ? 'ID_DOC_AUTHENTICITY' : 'not confirmed'}</Tag> : <Tag tone="gray">1 &lt;&lt; 1 · 1 &lt;&lt; 2</Tag>}>
          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="grid content-start gap-3.5">
              <div>
                <Eyebrow className="mb-1.5">Document</Eyebrow>
                <div className="inline-flex h-9 w-full items-center gap-0.5 rounded-sm border border-line bg-sunk p-0.5" role="tablist">
                  {([['RRC', 'Resident registration card'], ['DL', 'Driver licence']] as const).map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={docType === k} disabled={!!id || !walletDone}
                      onClick={() => { setDocType(k); setTwoWay(null); }}
                      className={`h-full flex-1 rounded-[3px] text-[13px] font-medium transition-colors ${docType === k ? 'bg-surface-2 text-fg-strong' : 'text-fg-muted hover:text-fg-strong'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Photo of the card" hint="jpg · png · ≤ 5 MB">
                <input type="file" accept="image/*" capture="environment" disabled={!walletDone || !!id}
                  onChange={(e) => { setImage(e.target.files?.[0] ?? null); setId(null); setTwoWay(null); setOcrNote(null); }}
                  className="block w-full text-[13px] text-fg-muted file:mr-3 file:h-9 file:rounded-sm file:border file:border-line-strong file:bg-transparent file:px-3 file:text-[13px] file:font-medium file:text-fg-strong hover:file:bg-surface-2" />
              </Field>
              <Button variant="secondary" onClick={readDocument} disabled={!image || busy !== null || !!id}>
                <Icon name="search" size={16} />{busy === 'ocr' ? 'Reading…' : 'Read the fields (OCR)'}
              </Button>
              {ocrNote && <div className="text-xs leading-4 text-fg-muted">{ocrNote}</div>}
            </div>

            <div className="grid content-start gap-3.5 sm:grid-cols-2">
              <Field label="Name on the card"><Input value={doc.fullName} disabled={!!id} onChange={(e) => setDoc({ ...doc, fullName: e.target.value })} /></Field>
              <Field label="Date of birth" hint="YYYYMMDD"><Input className="mono" inputMode="numeric" value={doc.birthDate} disabled={!!id} onChange={(e) => setDoc({ ...doc, birthDate: digits(e.target.value).slice(0, 8) })} /></Field>
              {docType === 'RRC' ? (
                <>
                  <Field label="Resident registration number" hint="13 digits · never stored">
                    <Input className="mono" inputMode="numeric" type="password" autoComplete="off" value={doc.rrn} disabled={!!id} onChange={(e) => setDoc({ ...doc, rrn: digits(e.target.value).slice(0, 13) })} />
                  </Field>
                  <Field label="Issue date" hint="YYYYMMDD"><Input className="mono" inputMode="numeric" value={doc.issueDate} disabled={!!id} onChange={(e) => setDoc({ ...doc, issueDate: digits(e.target.value).slice(0, 8) })} /></Field>
                </>
              ) : (
                <>
                  <Field label="Licence number" hint="12 digits"><Input className="mono" inputMode="numeric" value={doc.licenseNumber} disabled={!!id} onChange={(e) => setDoc({ ...doc, licenseNumber: digits(e.target.value).slice(0, 12) })} /></Field>
                  <Field label="Anti-forgery serial" hint="under the small photo"><Input className="mono" value={doc.serialNo} disabled={!!id} onChange={(e) => setDoc({ ...doc, serialNo: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6) })} /></Field>
                </>
              )}
              <div className="sm:col-span-2">
                <Button onClick={verifyDocument} disabled={!walletDone || !image || busy !== null || !!id || !!twoWay}>
                  <Icon name="shield" size={16} />{busy === 'id' && !twoWay ? 'Asking the authority…' : `Verify with ${docType === 'RRC' ? 'Government24' : 'Traffic Civil Service 24'}`}
                </Button>
              </div>
            </div>
          </div>

          {twoWay && (
            <div className="mt-4 rounded-sm border border-warn/20 bg-warn-tint p-4">
              <div className="text-[13px] font-medium text-fg-strong">{twoWay.method === 'secureNo' ? 'The authority asks for a captcha.' : 'The authority asks for approval in the certificate app.'}</div>
              {twoWay.message && <div className="mt-0.5 text-xs text-fg-muted">{twoWay.message}</div>}
              <div className="mt-3 flex flex-wrap items-end gap-3">
                {twoWay.imageBase64 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="captcha" src={`data:image/png;base64,${twoWay.imageBase64}`} className="h-12 rounded-sm border border-line bg-white" />
                )}
                {twoWay.method === 'secureNo' && (
                  <div className="w-40"><Field label="Characters"><Input className="mono" value={secureNo} onChange={(e) => setSecureNo(e.target.value)} autoFocus /></Field></div>
                )}
                <Button onClick={answerTwoWay} disabled={busy !== null || (twoWay.method === 'secureNo' && !secureNo)}>
                  {busy === 'id' ? 'Sending…' : twoWay.method === 'secureNo' ? 'Answer' : 'I approved it'}
                </Button>
                <Button variant="ghost" onClick={() => setTwoWay(null)} disabled={busy !== null}>Cancel</Button>
              </div>
              <div className="mt-2 text-xs text-fg-subtle">The authority holds this session for about three minutes.</div>
            </div>
          )}

          {id && (
            <DetailList className="mt-4">
              <DetailRow label="Authority answer">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Tag tone={id.summary.authentic ? 'ok' : 'bad'}>{id.summary.authentic ? 'genuine' : 'not confirmed'}</Tag>
                  <span className="mono text-fg-muted">resAuthenticity {id.summary.code ?? '—'}</span>
                  {!id.summary.live && <Tag tone="warn">{id.summary.vendor.startsWith('demo') ? 'demo' : 'sandbox'}{cfg?.sandboxBits ? ' · bit set under regime sandbox' : ' · bit not set'}</Tag>}
                </span>
              </DetailRow>
              <DetailRow label="Vendor · reference"><span className="mono">{id.summary.vendor} · {id.summary.ref ?? '—'}</span></DetailRow>
              <DetailRow label="Document hash" hint="keccak256 of the image; the only thing about the card that is kept"><Hash value={id.summary.docHash} full /></DetailRow>
            </DetailList>
          )}
          {id && !id.summary.authentic && (
            <Band tone="bad" className="mt-3">The issuing authority did not confirm this document. No mark will be issued from it. Check the fields against the card and <button type="button" className="link" onClick={() => setId(null)}>try again</button>.</Band>
          )}
          <StepError err={err} step="id" /><StepError err={err} step="ocr" />
        </Step>

        {/* ── 2 bank ── */}
        <Step n={2} title="Bank account" state={bankDone ? 'done' : canBank ? 'active' : 'locked'}
          tag={bankDone ? <Tag tone={bankRes!.summary.live ? 'ok' : 'warn'}>{bankRes!.summary.live ? 'BANK_ACCOUNT' : cfg?.sandboxBits ? 'BANK_ACCOUNT · regime sandbox' : 'not live · bit not set'}</Tag> : <Tag tone="gray">1 &lt;&lt; 5</Tag>}>
          <p className="text-[13px] leading-5 text-fg-muted">
            The bank confirms the holder of the account against the real-name number and the name on the document. Then one won arrives with a code as the sender; type the code back.
          </p>
          <div className="mt-3 grid gap-3.5 sm:grid-cols-[220px_minmax(0,1fr)_auto]">
            <Field label="Bank">
              <select className={selectCls} value={bank.bankCode} disabled={!canBank || !!challenge} onChange={(e) => setBank({ ...bank, bankCode: e.target.value })}>
                {(cfg?.banks ?? []).map((b) => <option key={b.code} value={b.code}>{b.name} · {b.code}</option>)}
              </select>
            </Field>
            <Field label="Account number" hint="digits only">
              <Input className="mono" inputMode="numeric" value={bank.accountNumber} disabled={!canBank || !!challenge} onChange={(e) => setBank({ ...bank, accountNumber: digits(e.target.value).slice(0, 16) })} />
            </Field>
            <div className="flex items-end">
              <Button onClick={startBank} disabled={!canBank || busy !== null || !!challenge || bank.accountNumber.length < 8}>
                <Icon name="bolt" size={16} />{busy === 'bank' && !challenge ? 'Asking the bank…' : 'Check holder and send ₩1'}
              </Button>
            </div>
          </div>
          {challenge && !bankDone && (
            <div className="mt-4 rounded-sm border border-line bg-sunk p-4">
              <div className="text-[13px] leading-5 text-fg-strong">
                Holder <span className="font-medium">{challenge.holderNameMasked}</span> matches the document. ₩1 was sent to {bankName(bank.bankCode)} ···{bank.accountNumber.slice(-4)}.
              </div>
              {challenge.demoCode ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 rounded-sm border border-warn/20 bg-warn-tint px-3 py-2">
                  <Tag tone="warn">demo</Tag>
                  <span className="text-xs text-fg-muted">No real deposit ({challenge.vendor}). This is what the bank statement would show as the sender:</span>
                  <span className="mono text-base font-semibold text-fg-strong">{challenge.vendor.startsWith('openbanking') ? 'PM' : ''}{challenge.demoCode}</span>
                </div>
              ) : (
                <div className="mt-0.5 text-xs text-fg-muted">
                  Open the bank app. The deposit&apos;s sender name carries the code
                  {challenge.vendor.startsWith('openbanking') ? <> as <span className="mono">PM</span> followed by four digits</> : <> as four digits</>}.
                  {!challenge.live && <> This is the testbed: no deposit will appear, and the code cannot be known.</>}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="w-40"><Field label="Code" hint="4 digits"><Input className="mono" inputMode="numeric" value={code} onChange={(e) => setCode(digits(e.target.value).slice(0, 6))} autoFocus /></Field></div>
                <Button onClick={confirmCode} disabled={busy !== null || code.length < 4}>{busy === 'bank' ? 'Checking…' : 'Confirm'}</Button>
                <Button variant="ghost" onClick={() => { setChallenge(null); setCode(''); }} disabled={busy !== null}>Start over</Button>
              </div>
            </div>
          )}
          {bankRes && (
            <DetailList className="mt-4">
              <DetailRow label="Account">{bankName(bankRes.summary.bankCode)} · holder {bankRes.summary.holderNameMasked}</DetailRow>
              <DetailRow label="Checks"><span className="inline-flex gap-2"><Tag tone="ok">holder name</Tag><Tag tone="ok">one-won code</Tag>{!bankRes.summary.live && <Tag tone="warn">{bankRes.summary.vendor.startsWith('demo') ? 'demo' : 'testbed'}</Tag>}</span></DetailRow>
              <DetailRow label="Vendor · reference"><span className="mono">{bankRes.summary.vendor} · {bankRes.summary.ref ?? '—'}</span></DetailRow>
            </DetailList>
          )}
          <StepError err={err} step="bank" />
        </Step>

        {/* ── 3 issue ── */}
        <Step n={3} title="Screen and issue" state={issued?.status === 'ISSUED' ? 'done' : canIssue ? 'active' : 'locked'}
          tag={issued ? <Tag tone={issued.status === 'ISSUED' ? 'ok' : issued.status === 'REVIEW' ? 'warn' : 'bad'}>{issued.status}</Tag> : <Tag tone="gray">reconcile · AML · commit</Tag>}>
          <div className="grid gap-3.5 sm:grid-cols-4">
            <Field label="Declared name"><Input value={declared.fullName} readOnly /></Field>
            <Field label="Date of birth"><Input className="mono" value={declared.dateOfBirth} readOnly /></Field>
            <Field label="Nationality" hint="ISO-2"><Input className="mono" value={country.nationality} maxLength={2} disabled={!!issued} onChange={(e) => setCountry({ ...country, nationality: e.target.value.toUpperCase() })} /></Field>
            <Field label="Residence" hint="ISO-2"><Input className="mono" value={country.residence} maxLength={2} disabled={!!issued} onChange={(e) => setCountry({ ...country, residence: e.target.value.toUpperCase() })} /></Field>
          </div>
          <p className="mt-3 text-[13px] leading-5 text-fg-muted">
            Declared details, the document and the account holder must agree. Then OFAC SDN, UN and EU lists, jurisdiction and on-chain exposure.
            The claims are salted and committed; the salts stay in this browser. Only two 32-byte commitments and the bits go to Sepolia.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={issue} disabled={!canIssue || busy !== null || issued?.status === 'ISSUED'}>
              <Icon name="check" size={16} />{busy === 'issue' ? 'Screening and issuing…' : 'Screen and issue the mark'}
            </Button>
            {issued && <Button variant="secondary" onClick={download}><Icon name="copy" size={16} />Save claims + evidence</Button>}
            {issued?.subject && <Link href={`/onchain?subject=${issued.subject}`} className="link text-[13px]">Watch it arrive on Creditcoin</Link>}
          </div>

          {issued && issued.status !== 'ISSUED' && (
            <Band tone={issued.status === 'REVIEW' ? 'warn' : 'bad'} className="mt-4">
              <span className="font-medium">{issued.status}.</span> {issued.reason}
              <div className="mono mt-1 text-fg-muted">evidence {issued.evidenceHash}</div>
            </Band>
          )}
          {issued?.status === 'ISSUED' && (
            <>
              {issued.onchain && (
                <Band tone={issued.onchain.sent ? (issued.onchain.reverted ? 'bad' : 'ok') : 'note'} className="mt-4">
                  {issued.onchain.sent
                    ? <>ComplianceSource.issue sent from <span className="mono">{issued.onchain.issuer}</span>
                        {issued.onchain.blockNumber ? <> and mined in block <span className="mono">{issued.onchain.blockNumber.toLocaleString()}</span>.</> : ', waiting for the block.'}
                        {issued.onchain.reverted && ' The transaction reverted.'}
                        {' '}The worker picks it up and the mark lands on CC3 in about eight minutes.</>
                    : <>Pipeline complete; the Sepolia transaction was not sent ({issued.onchain.reason}).</>}
                </Band>
              )}
              <DetailList className="mt-4">
                <DetailRow label="Subject"><Hash value={issued.subject ?? ''} full /></DetailRow>
                {issued.onchain?.txHash && <DetailRow label="Sepolia tx"><Hash value={issued.onchain.txHash} href={sepoliaTx(issued.onchain.txHash)} full /></DetailRow>}
                <DetailRow label="Methods" hint="checks that ran, and only those">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Tag tone="gray" mono>{issued.methodsHex}</Tag>
                    {METHOD_BITS.filter((b) => issued.methodNames?.includes(b.key)).map((b) => <Tag key={b.key} tone="mint">{b.label}</Tag>)}
                  </span>
                </DetailRow>
                <DetailRow label="KR VASP production" hint="policy #1: document authenticity, bank account, sanctions">
                  <Status tone={issued.passesKrProduction ? 'ok' : 'bad'}>{issued.passesKrProduction ? 'passes' : 'fails'}</Status>
                  {!issued.passesKrProduction && <span className="ml-2 text-fg-muted">a required check did not run against live rails</span>}
                  {issued.passesKrProduction && issued.regime === 2 && <span className="ml-2 text-fg-muted">under regime sandbox; the policy does not check regime yet</span>}
                </DetailRow>
                <DetailRow label="Regime · assurance"><span className="mono">{issued.regime === 1 ? 'KR_FSC_NONFACE' : 'KR_FSC_NONFACE_SANDBOX'} · level {issued.assurance}</span></DetailRow>
                <DetailRow label="Expiry"><span className="mono">{issued.expiry ? new Date(issued.expiry * 1000).toISOString().slice(0, 10) : '—'}</span></DetailRow>
                <DetailRow label="Claims root"><Hash value={issued.claimsRoot ?? ''} full /></DetailRow>
                <DetailRow label="Evidence hash"><Hash value={issued.evidenceHash} full /></DetailRow>
              </DetailList>
              <Band tone="note" className="mt-3">
                Save the file above. It holds the salted claims (yours to disclose selectively) and the evidence chain an auditor recomputes against the on-chain hash. The server keeps neither the salts nor the card.
              </Band>
            </>
          )}
          <StepError err={err} step="issue" />
        </Step>
      </div>
    </>
  );
}

function Step({ n, title, state, tag, children }: { n: number; title: string; state: 'locked' | 'active' | 'done'; tag: ReactNode; children: ReactNode }) {
  const tone: Tone = state === 'done' ? 'ok' : state === 'active' ? 'mint' : 'gray';
  return (
    <section className={`panel ${state === 'locked' ? 'opacity-60' : ''}`}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <span className={`mono inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${state === 'done' ? 'bg-ok-tint text-ok' : state === 'active' ? 'bg-mint-tint text-mint' : 'bg-surface-2 text-fg-muted'}`}>
          {state === 'done' ? <Icon name="check" size={14} /> : n}
        </span>
        <span className="whitespace-nowrap text-sm font-semibold text-fg-strong">{title}</span>
        <span className="ml-auto flex items-center gap-2">
          {state === 'locked' && <Status tone={tone}>waiting</Status>}
          {tag}
        </span>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function StepError({ err, step }: { err: { step: string; text: string } | null; step: string }) {
  if (!err || err.step !== step) return null;
  return <Band tone="bad" className="mt-3">{err.text}</Band>;
}
