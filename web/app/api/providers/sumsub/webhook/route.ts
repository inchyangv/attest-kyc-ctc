import { guardError, guardRequest } from '@/lib/request-guard';
import { readBoundedBody } from '@/lib/request-body';
import { acceptSumsubWebhook, sumsubPublicError } from '@/lib/sumsub-server';
import { SumsubError } from '@pipeline/providers/sumsub.js';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'sumsub-webhook', limit: 120, windowMs: 60_000, maxBodyBytes: 64 * 1024 });
    const raw = await readBoundedBody(req, 64 * 1024);
    return Response.json(await acceptSumsubWebhook(raw, req.headers), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SumsubError && error.code === 'SUMSUB_WEBHOOK_SIGNATURE_INVALID') {
      const rawAlgorithm = req.headers.get('x-payload-digest-alg');
      const algorithm = rawAlgorithm === 'HMAC_SHA256_HEX' || rawAlgorithm === 'HMAC_SHA512_HEX'
        || rawAlgorithm === 'HMAC_SHA1_HEX' ? rawAlgorithm : 'missing-or-unsupported';
      console.warn('Sumsub webhook signature rejected', {
        algorithm,
        digestLength: req.headers.get('x-payload-digest')?.length ?? 0,
      });
    }
    return guardError(error) ?? sumsubPublicError(error);
  }
}
