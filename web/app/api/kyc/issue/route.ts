import { NextResponse } from 'next/server';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { ConfigError, TokenError, getAdapter, open } from '@/lib/kyc-server';
import { getEngine } from '@/lib/aml-server';
import { runIssuance, toIssueCall } from '@pipeline/issue.js';
import { Methods } from '@pipeline/methods.js';
import type { BankAccountResult, IdDocumentResult } from '@pipeline/adapters/kr.js';

export const runtime = 'nodejs';
export const maxDuration = 120;

const fail = (e: unknown) => {
  if (e instanceof ConfigError) return NextResponse.json({ error: e.message, missing: e.missing }, { status: 503 });
  if (e instanceof TokenError) return NextResponse.json({ error: e.message }, { status: 400 });
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
};

const sourceAbi = parseAbi(['function issue(address subject, bytes32 attrs, bytes32 claimsRoot, bytes32 evidenceHash)']);

const ISO2 = /^[A-Z]{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Steps 3 to 6. JSON: { walletProof, declared, idProof?, bankProof? }.
 * Reconciliation, AML screening against the source lists, the claims commitment, attrs packing,
 * then `ComplianceSource.issue()` on Sepolia from the issuer key. The worker carries it to CC3.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const wallet = open<{ address: string }>('wallet', body.walletProof);
    const idDocument = body.idProof ? stripToken<IdDocumentResult>(open<IdDocumentResult>('id', body.idProof)) : null;
    const bankAccount = body.bankProof ? stripToken<BankAccountResult>(open<BankAccountResult>('bank', body.bankProof)) : null;

    const d = (body.declared ?? {}) as Record<string, unknown>;
    const declared = {
      fullName: String(d.fullName ?? '').trim().slice(0, 200),
      dateOfBirth: String(d.dateOfBirth ?? '').trim(),
      nationality: String(d.nationality ?? '').trim().toUpperCase(),
      residence: String(d.residence ?? d.nationality ?? '').trim().toUpperCase(),
    };
    if (!declared.fullName) return NextResponse.json({ error: 'declared.fullName is required' }, { status: 400 });
    if (!ISO_DATE.test(declared.dateOfBirth)) return NextResponse.json({ error: 'declared.dateOfBirth must be YYYY-MM-DD' }, { status: 400 });
    if (!ISO2.test(declared.nationality) || !ISO2.test(declared.residence)) return NextResponse.json({ error: 'nationality and residence must be ISO-3166 alpha-2' }, { status: 400 });

    const { adapter, status } = getAdapter();
    const { engine } = getEngine();

    // The issuer's own grade: 3 when both regulatory checks passed on rails the adapter counts
    // (live, or anything under the demo switch, which the regime then discloses), else 1.
    const counts = (r: { live: boolean }) => r.live || status.sandboxBits;
    const idOk = !!idDocument && counts(idDocument) && idDocument.authenticityChecked && idDocument.authentic;
    const bankOk = !!bankAccount && counts(bankAccount) && bankAccount.holderVerified && bankAccount.oneWonVerified;
    const assurance = idOk && bankOk ? 3 : 1;

    const out = await runIssuance({
      wallet: wallet.address, declared, idDocument, bankAccount,
      walletControlProven: true, jurisdiction: 410, kind: 1, assurance,
    }, adapter, engine);

    if (out.status !== 'ISSUED') {
      return NextResponse.json({ status: out.status, reason: out.reason, evidenceHash: out.evidenceHash, evidence: out.evidence });
    }

    const KR_POLICY = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;
    const base = {
      status: 'ISSUED' as const,
      subject: wallet.address,
      attrs: out.attrs, claimsRoot: out.claimsRoot, evidenceHash: out.evidenceHash,
      methods: out.methods, methodsHex: '0x' + out.methods.toString(16), methodNames: out.methodNames,
      regime: out.regime, assurance, expiry: out.expiry,
      // Deployed policy #1: requireAll 0x10024 and minAssurance 2.
      passesKrProduction: (out.methods & KR_POLICY) === KR_POLICY && assurance >= 2,
      claims: out.claims, evidence: out.evidence,
    };

    if (!status.issuer.configured) {
      return NextResponse.json({ ...base, onchain: { sent: false, reason: `issuer not configured: ${status.issuer.missing.join(', ')}` } });
    }

    const account = privateKeyToAccount(process.env.ISSUER_PRIVATE_KEY as Hex);
    const transport = http(process.env.NEXT_PUBLIC_SEPOLIA_RPC);
    const walletClient = createWalletClient({ account, chain: sepolia, transport });
    const publicClient = createPublicClient({ chain: sepolia, transport });
    const call = toIssueCall(wallet.address, out);
    const txHash = await walletClient.writeContract({
      address: process.env.NEXT_PUBLIC_SOURCE as Address,
      abi: sourceAbi,
      functionName: 'issue',
      args: [call.subject as Address, call.attrs as Hex, call.claimsRoot as Hex, call.evidenceHash as Hex],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 }).catch(() => null);

    return NextResponse.json({
      ...base,
      onchain: {
        sent: true, txHash, issuer: account.address,
        blockNumber: receipt ? Number(receipt.blockNumber) : null,
        reverted: receipt ? receipt.status !== 'success' : null,
      },
    });
  } catch (e) { return fail(e); }
}

function stripToken<T extends object>(t: T & { exp: number }): T {
  const { exp: _exp, typ: _typ, ...rest } = t as T & { exp: number; typ?: string };
  void _exp; void _typ;
  return rest as T;
}
