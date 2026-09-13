import { guardError, guardRequest } from '@/lib/request-guard';
import { readJsonObject } from '@/lib/request-body';
import { createSumsubSdkToken, sumsubPublicError } from '@/lib/sumsub-server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'sumsub-sdk-token', limit: 10, windowMs: 10 * 60_000, maxBodyBytes: 16_384, sameOrigin: true });
    const body = await readJsonObject(req, 16_384);
    return Response.json(await createSumsubSdkToken(body.walletProof, body.providerProof), {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    });
  } catch (error) { return guardError(error) ?? sumsubPublicError(error); }
}
