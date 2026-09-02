import { NextResponse } from 'next/server';
import { ConfigError, TokenError, assertSameFlow, codeDigest, codeMatches, flowBinding, flowFromWalletToken, isDemo, maskName, open, requireBankVendor, seal, type FlowBinding } from '@/lib/kyc-server';
import { guardError, guardRequest } from '@/lib/request-guard';
import { VendorError, isKrBankCode, type BankAccountResult } from '@pipeline/adapters/kr.js';

export const runtime = 'nodejs';

const MAX_ATTEMPTS = 5;

const fail = (e: unknown) => {
  const guarded = guardError(e); if (guarded) return guarded;
  if (e instanceof ConfigError) return NextResponse.json({ error: e.message, missing: e.missing }, { status: 503 });
  if (e instanceof TokenError) return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof VendorError) return NextResponse.json({ error: e.message, code: e.code ?? null, ref: e.ref ?? null }, { status: 422 });
  return NextResponse.json({ error: 'internal bank verification error' }, { status: 500 });
};

interface Challenge extends FlowBinding {
  bankCode: string;
  accountNumber: string;
  holderName: string;
  codeDigest: string;
  ref: string | null;
  vendor: string;
  live: boolean;
  attempts: number;
}

/**
 * Step 2. JSON.
 *   action=start   holder name from the bank, compared with the declared name; then one won with a
 *                  code in the memo. The code never leaves the server: the browser gets a sealed
 *                  challenge holding its digest.
 *   action=verify  the customer reads the code back. Five tries, then start over.
 */
export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'kyc-bank', limit: 20, windowMs: 10 * 60_000, maxBodyBytes: 32_768, sameOrigin: true });
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const wallet = flowFromWalletToken(body.walletProof);
    const binding = flowBinding(wallet);
    const action = String(body.action ?? '');
    const adapter = requireBankVendor();
    const vendor = adapter.bankVendor!;

    if (action === 'start') {
      const bankCode = String(body.bankCode ?? '');
      const accountNumber = String(body.accountNumber ?? '').replace(/\D/g, '');
      const birthDate = String(body.birthDate ?? '').replace(/\D/g, '');
      const declaredName = String(body.declaredName ?? '').trim();
      if (!isKrBankCode(bankCode)) return NextResponse.json({ error: 'bankCode is not a Korean bank code' }, { status: 400 });
      if (!declaredName) return NextResponse.json({ error: 'declaredName is required' }, { status: 400 });

      const holder = await adapter.lookupHolder({ bankCode, accountNumber, birthDate, declaredName });
      if (!holder.matches) {
        return NextResponse.json({
          error: `The bank says this account belongs to ${maskName(holder.holderName)}, which is not ${maskName(declaredName)}.`,
          code: 'HOLDER_MISMATCH', ref: holder.ref ?? null,
        }, { status: 422 });
      }

      const won = await adapter.sendOneWon({ bankCode, accountNumber, holderName: holder.holderName });
      const challenge: Challenge = {
        bankCode, accountNumber, holderName: holder.holderName, codeDigest: codeDigest(won.authCode),
        ref: won.ref ?? holder.ref ?? null, vendor: vendor.name, live: vendor.live, attempts: 0,
        ...binding,
      };
      return NextResponse.json({
        challenge: seal('bankChallenge', challenge as unknown as Record<string, unknown>, 10 * 60),
        holderNameMasked: maskName(holder.holderName),
        vendor: vendor.name,
        live: vendor.live,
        ref: challenge.ref,
        // Demo only, and only when no real deposit happened: there is no statement to read the code
        // off, so the page shows it in place of the bank app. A live rail never reveals it.
        demoCode: isDemo() && !vendor.live ? won.authCode : undefined,
      });
    }

    if (action === 'verify') {
      const c = open<Challenge>('bankChallenge', body.challenge);
      assertSameFlow(wallet, c, 'bank challenge');
      const code = String(body.code ?? '').trim();
      if (!code) return NextResponse.json({ error: 'code is required' }, { status: 400 });
      if (!codeMatches(code, c.codeDigest)) {
        const attempts = c.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          return NextResponse.json({ error: 'Too many wrong codes. Start the bank step again.', code: 'TOO_MANY_ATTEMPTS' }, { status: 422 });
        }
        const { exp: _exp, typ: _typ, ...rest } = c as Challenge & { exp: number; typ: string };
        void _exp; void _typ;
        return NextResponse.json({
          error: `That is not the code on the deposit (${MAX_ATTEMPTS - attempts} tries left).`,
          code: 'CODE_MISMATCH',
          challenge: seal('bankChallenge', { ...rest, attempts } as unknown as Record<string, unknown>, Math.max(30, Math.floor((c.exp - Date.now()) / 1000))),
        }, { status: 422 });
      }
      const result: BankAccountResult = {
        bankCode: c.bankCode, holderName: c.holderName, holderVerified: true, oneWonVerified: true,
        vendor: c.vendor, live: c.live, ref: c.ref ?? undefined,
      };
      return NextResponse.json({
        status: 'verified',
        bankProof: seal('bank', { ...result, ...binding } as unknown as Record<string, unknown>, 30 * 60),
        summary: { bankCode: c.bankCode, holderNameMasked: maskName(c.holderName), vendor: c.vendor, live: c.live, ref: c.ref },
      });
    }

    return NextResponse.json({ error: 'action must be start or verify' }, { status: 400 });
  } catch (e) { return fail(e); }
}
