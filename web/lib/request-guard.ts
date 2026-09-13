import 'server-only';
import { createHash } from 'node:crypto';

type GuardOptions = {
  bucket: string;
  limit: number;
  windowMs: number;
  maxBodyBytes?: number;
  sameOrigin?: boolean;
};

type Counter = { expiresAt: number; count: number };
const counters = new Map<string, Counter>();
export const MAX_LOCAL_BUCKETS = 10_000;
let nextSweepAt = 0;

export class RequestGuardError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
    this.name = 'RequestGuardError';
  }
}

/** Header hints can reject early, but callers must also bound actual streamed bytes. */
export function assertBodyHeaders(req: Request, maxBytes: number): number | undefined {
  const encoding = req.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new RequestGuardError('encoded request bodies are not supported', 415);
  const rawLength = req.headers.get('content-length');
  if (rawLength === null) return;
  if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) throw new RequestGuardError('invalid content-length', 400);
  const length = Number(rawLength);
  if (length > maxBytes) throw new RequestGuardError('request body is too large', 413);
  return length;
}

/** Per-instance protection for public Route Handlers. Host-level distributed limits are still
 * required in production because serverless instances do not share this map. */
export function guardRequest(req: Request, options: GuardOptions): void {
  if (options.maxBodyBytes) assertBodyHeaders(req, options.maxBodyBytes);

  if (options.sameOrigin) {
    const origin = req.headers.get('origin');
    if (origin && origin !== new URL(req.url).origin) {
      throw new RequestGuardError('cross-origin request rejected', 403);
    }
  }

  const now = Date.now();
  if (now >= nextSweepAt) {
    for (const [key, value] of counters) if (now >= value.expiresAt) counters.delete(key);
    nextSweepAt = now + 1000;
  }
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const client = forwarded || req.headers.get('x-real-ip') || 'unknown';
  // This header is trustworthy only behind a proxy that strips/rewrites inbound forwarding
  // headers. Hashing bounds stored key size; it does not authenticate the client's identity.
  const key = `${options.bucket}|${createHash('sha256').update(client).digest('hex')}`;
  const prior = counters.get(key);
  if (!prior && counters.size >= MAX_LOCAL_BUCKETS) {
    throw new RequestGuardError('local request capacity reached', 429, 1);
  }
  const counter = !prior || now >= prior.expiresAt
    ? { expiresAt: now + options.windowMs, count: 0 }
    : prior;
  counter.count += 1;
  counters.set(key, counter);
  if (counter.count > options.limit) {
    throw new RequestGuardError(
      'rate limit exceeded',
      429,
      Math.max(1, Math.ceil((counter.expiresAt - now) / 1000)),
    );
  }
}

export function guardError(e: unknown): Response | null {
  if (!(e instanceof RequestGuardError)) return null;
  const headers = { 'Cache-Control': 'no-store', ...(e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {}) };
  return Response.json({ error: e.message }, { status: e.status, headers });
}
