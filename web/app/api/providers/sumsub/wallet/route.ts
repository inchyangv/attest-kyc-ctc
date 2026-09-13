import { guardError, guardRequest } from '@/lib/request-guard';
import { BODY_LIMITS, readJsonObject } from '@/lib/request-body';
import { createSumsubWalletChallenge, sumsubPublicError, verifySumsubWalletChallenge } from '@/lib/sumsub-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'sumsub-wallet-message', limit: 30, windowMs: 10 * 60_000 });
    const url = new URL(req.url);
    return Response.json(createSumsubWalletChallenge(req.url, url.searchParams.get('address') ?? ''), {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    });
  } catch (error) { return guardError(error) ?? sumsubPublicError(error); }
}

export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'sumsub-wallet-signature', limit: 30, windowMs: 10 * 60_000,
      maxBodyBytes: BODY_LIMITS.wallet, sameOrigin: true });
    const body = await readJsonObject(req, BODY_LIMITS.wallet);
    return Response.json(await verifySumsubWalletChallenge(req.url, body.token, body.signature), {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    });
  } catch (error) { return guardError(error) ?? sumsubPublicError(error); }
}
