import 'server-only';

type GuardOptions = {
  bucket: string;
  limit: number;
  windowMs: number;
  maxBodyBytes?: number;
  sameOrigin?: boolean;
};

type Counter = { startedAt: number; count: number };
const counters = new Map<string, Counter>();

export class RequestGuardError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
    this.name = 'RequestGuardError';
  }
}

/** Per-instance protection for public Route Handlers. Host-level distributed limits are still
 * required in production because serverless instances do not share this map. */
export function guardRequest(req: Request, options: GuardOptions): void {
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (options.maxBodyBytes && Number.isFinite(contentLength) && contentLength > options.maxBodyBytes) {
    throw new RequestGuardError('request body is too large', 413);
  }

  if (options.sameOrigin) {
    const origin = req.headers.get('origin');
    if (origin && origin !== new URL(req.url).origin) {
      throw new RequestGuardError('cross-origin request rejected', 403);
    }
  }

  const now = Date.now();
  if (counters.size > 10_000) {
    for (const [key, value] of counters) if (now - value.startedAt >= options.windowMs) counters.delete(key);
  }
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const client = forwarded || req.headers.get('x-real-ip') || 'unknown';
  const key = `${options.bucket}|${client}`;
  const prior = counters.get(key);
  const counter = !prior || now - prior.startedAt >= options.windowMs
    ? { startedAt: now, count: 0 }
    : prior;
  counter.count += 1;
  counters.set(key, counter);
  if (counter.count > options.limit) {
    throw new RequestGuardError(
      'rate limit exceeded',
      429,
      Math.max(1, Math.ceil((counter.startedAt + options.windowMs - now) / 1000)),
    );
  }
}

export function guardError(e: unknown): Response | null {
  if (!(e instanceof RequestGuardError)) return null;
  const headers = e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : undefined;
  return Response.json({ error: e.message }, { status: e.status, headers });
}
