import { guardError, guardRequest } from '@/lib/request-guard';
import { readJsonObject } from '@/lib/request-body';
import { currentSumsubStatus, sumsubConfigStatus, sumsubPublicError } from '@/lib/sumsub-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'sumsub-config', limit: 30, windowMs: 60_000 });
    return Response.json(sumsubConfigStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return guardError(error) ?? sumsubPublicError(error); }
}

export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'sumsub-status', limit: 30, windowMs: 10 * 60_000, maxBodyBytes: 16_384, sameOrigin: true });
    const body = await readJsonObject(req, 16_384);
    return Response.json(await currentSumsubStatus(body.walletProof, body.providerProof), {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    });
  } catch (error) { return guardError(error) ?? sumsubPublicError(error); }
}
