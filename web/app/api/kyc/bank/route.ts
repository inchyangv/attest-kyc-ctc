import { privateJson } from '@/lib/private-response';
import { randomUUID } from 'node:crypto';
import { TokenError, assertSameFlow, codeDigest, codeMatches, flowBinding, flowFromWalletToken, isDemo, maskName, open, requireBankVendor, seal, type FlowBinding } from '@/lib/kyc-server';
import { publicConfigFailure, publicVendorFailure } from '@/lib/public-errors';
import { guardError, guardRequest } from '@/lib/request-guard';
import { BODY_LIMITS, readJsonObject } from '@/lib/request-body';
import { isKrBankCode, type BankAccountResult } from '@pipeline/adapters/kr.js';
import { BankStateError } from '@pipeline/bank-state.js';
import { bankStateKey, bankStateStore } from '@/lib/bank-state';
import { requireSyntheticSampleMode, SyntheticSampleError } from '@pipeline/synthetic-samples.js';
import { authorizeCurrentProcessing } from '@/lib/privacy-processing-policy-server';
import { authorizeCurrentRetention } from '@/lib/retention-policy-server';

export const runtime = 'nodejs';

const fail = (e: unknown) => {
  if (e instanceof SyntheticSampleError) return privateJson({ error: e.message, code: e.code }, { status: 409 });
  const guarded = guardError(e); if (guarded) return guarded;
  const configured = publicConfigFailure(e); if (configured) return configured;
  if (e instanceof TokenError) return privateJson({ error: e.message }, { status: 400 });
  const vendor = publicVendorFailure(e); if (vendor) return vendor;
  if (e instanceof BankStateError) return privateJson({ error: e.message, code: e.code }, {
    status: e.code === 'STATE_UNAVAILABLE' || e.code === 'INVALID_STATE_CONFIG' ? 503 : e.code === 'START_BUDGET_EXCEEDED' ? 429 : 422,
  });
  return privateJson({ error: 'internal bank verification error' }, { status: 500 });
};

interface Challenge extends FlowBinding {
  challengeId: string;
  requestKey: string;
  bankCode: string;
  holderName: string;
  codeDigest: string;
  ref: string | null;
  vendor: string;
  live: boolean;
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
    guardRequest(req, { bucket: 'kyc-bank', limit: 20, windowMs: 10 * 60_000, maxBodyBytes: BODY_LIMITS.bank, sameOrigin: true });
    const body = await readJsonObject(req, BODY_LIMITS.bank);
    const wallet = flowFromWalletToken(body.walletProof);
    const binding = flowBinding(wallet);
    const action = String(body.action ?? '');
    const adapter = requireBankVendor();
    requireSyntheticSampleMode(body.syntheticSample, isDemo(), adapter.idVendor, adapter.bankVendor);
    const syntheticSample = body.syntheticSample === true || body.syntheticSample === '1';
    const vendor = adapter.bankVendor!;
    const processingPolicy = authorizeCurrentProcessing(isDemo(), wallet.processingPolicy, {
      stage: 'bank_account', recipient: vendor.name,
      data: ['bank_account', 'birth_date_fragment', 'account_holder_name'],
    });
    authorizeCurrentRetention(isDemo(), processingPolicy.customerId, wallet.retentionPolicy);
    const state = bankStateStore(vendor.name === 'demo:bank');
    const flowKey = bankStateKey('flow', [wallet.address.toLowerCase(), wallet.flowId]);

    if (action === 'start') {
      const bankCode = String(body.bankCode ?? '');
      const accountNumber = String(body.accountNumber ?? '').replace(/\D/g, '');
      const birthDate = String(body.birthDate ?? '').replace(/\D/g, '');
      const declaredName = String(body.declaredName ?? '').trim();
      if (!isKrBankCode(bankCode)) return privateJson({ error: 'bankCode is not a Korean bank code' }, { status: 400 });
      if (!declaredName || declaredName.length > 200 || !/^\d{8,16}$/.test(accountNumber) || !/^\d{6}$/.test(birthDate)) {
        return privateJson({ error: 'Valid name, 8–16 digit account and YYMMDD birthDate are required' }, { status: 400 });
      }
      const startRequestId = String(body.startRequestId ?? 'default');
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(startRequestId)) return privateJson({ error: 'invalid startRequestId' }, { status: 400 });
      const reservation = {
        requestKey: bankStateKey('request', [flowKey, startRequestId === 'default' ? `${bankCode}|${accountNumber}` : startRequestId]),
        flowKey,
        // Every visitor receives the same public fixture account. Keep the ordinary account
        // abuse budget intact, but do not let three unrelated demo visitors exhaust that one
        // shared fixture for everyone else. Wallet/global/flow limits still apply.
        accountKey: syntheticSample
          ? bankStateKey('synthetic-account', [wallet.address.toLowerCase(), bankCode, accountNumber])
          : bankStateKey('account', [bankCode, accountNumber]),
        walletKey: bankStateKey('wallet', [wallet.address.toLowerCase()]),
        fingerprint: bankStateKey('payload', [bankCode, accountNumber, birthDate, declaredName]), challengeId: randomUUID(),
      };
      // Reserve budgets and idempotency BEFORE any vendor call. An ambiguous vendor failure leaves
      // a pending record; automatically retrying the deposit would risk sending it twice.
      const reserved = await state.reserve(reservation);
      if (reserved.status === 'cached') {
        const cached = open<Record<string, unknown>>('bankStartResult', reserved.response);
        const { exp: _exp, typ: _typ, ...response } = cached;
        void _exp; void _typ;
        return privateJson(response);
      }

      const holder = await adapter.lookupHolder({ bankCode, accountNumber, birthDate, declaredName });
      if (!holder.matches) {
        return privateJson({
          error: 'The bank account holder does not match the declared identity.',
          code: 'HOLDER_MISMATCH', ref: null,
        }, { status: 422 });
      }

      const won = await adapter.sendOneWon({ bankCode, accountNumber, holderName: holder.holderName });
      const challenge: Challenge = {
        challengeId: reservation.challengeId, requestKey: reservation.requestKey,
        bankCode, holderName: holder.holderName, codeDigest: codeDigest(won.authCode),
        ref: won.ref ?? holder.ref ?? null, vendor: vendor.name, live: vendor.live,
        ...binding,
      };
      const ttl = Math.floor((reserved.expiresAt - Date.now()) / 1000);
      if (ttl <= 0) throw new BankStateError('CHALLENGE_EXPIRED');
      const response = {
        challenge: seal('bankChallenge', challenge, ttl),
        holderNameMasked: maskName(holder.holderName),
        vendor: vendor.name,
        live: vendor.live,
        ref: challenge.ref,
        // Demo only, and only when no real deposit happened: there is no statement to read the code
        // off, so the page shows it in place of the bank app. A live rail never reveals it.
        demoCode: isDemo() && !vendor.live ? won.authCode : undefined,
        stateMode: state.mode,
      };
      await state.activate(reservation, seal('bankStartResult', response, ttl));
      return privateJson(response);
    }

    if (action === 'verify') {
      const c = open<Challenge>('bankChallenge', body.challenge);
      assertSameFlow(wallet, c, 'bank challenge');
      const code = String(body.code ?? '').trim();
      if (!c.challengeId || !c.requestKey) throw new TokenError('Legacy bank challenge is no longer supported. Start the bank step again.');
      const attempt = await state.verify({ challengeId: c.challengeId, requestKey: c.requestKey, flowKey }, /^\d{4}$/.test(code) && codeMatches(code, c.codeDigest));
      if (attempt.status === 'mismatch') {
        return privateJson({
          error: `That is not the code on the deposit (${attempt.remaining} tries left).`,
          code: 'CODE_MISMATCH',
          // The exact same token can be retried: the server, not the browser, owns the count.
          challenge: body.challenge,
        }, { status: 422 });
      }
      const result: BankAccountResult = {
        bankCode: c.bankCode, holderName: c.holderName, holderVerified: true, oneWonVerified: true,
        vendor: c.vendor, live: c.live, ref: c.ref ?? undefined,
      };
      return privateJson({
        status: 'verified',
        bankProof: seal('bank', { ...result, ...binding } as unknown as Record<string, unknown>, 30 * 60),
        summary: { bankCode: c.bankCode, holderNameMasked: maskName(c.holderName), vendor: c.vendor, live: c.live, ref: c.ref },
      });
    }

    return privateJson({ error: 'action must be start or verify' }, { status: 400 });
  } catch (e) { return fail(e); }
}
