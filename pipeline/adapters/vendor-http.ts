import { VendorError } from './kr.js';

export const VENDOR_HTTP_LIMITS = Object.freeze({
  tokenTimeoutMs: 10_000, productTimeoutMs: 30_000,
  tokenBytes: 64 * 1024, productBytes: 2 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024, concurrent: 4, chunks: 65_536,
});

export function vendorTimeouts(options: { tokenTimeoutMs?: number; productTimeoutMs?: number }) {
  const token = options.tokenTimeoutMs ?? VENDOR_HTTP_LIMITS.tokenTimeoutMs;
  const product = options.productTimeoutMs ?? VENDOR_HTTP_LIMITS.productTimeoutMs;
  if (!Number.isSafeInteger(token) || token < 1 || token > VENDOR_HTTP_LIMITS.tokenTimeoutMs
    || !Number.isSafeInteger(product) || product < 1 || product > VENDOR_HTTP_LIMITS.productTimeoutMs) throw new Error('invalid vendor timeout policy');
  return { token, product };
}

/** Safe diagnostics only: no upstream response, URL, credentials or submitted identity. */
export class VendorTransportError extends VendorError {
  constructor(code: 'VENDOR_TIMEOUT' | 'VENDOR_CAPACITY' | 'VENDOR_HTTP' | 'VENDOR_RESPONSE_LIMIT' | 'VENDOR_BAD_RESPONSE' | 'VENDOR_NETWORK' | 'VENDOR_REQUEST_LIMIT',
    readonly upstreamStatus?: number) {
    super('Institution request could not be confirmed; do not automatically repeat it.', code);
    this.name = 'VendorTransportError';
  }
}

/** One bounded HTTP exchange, including headers and the entire decoded response stream.
 * No retries or redirects. A non-cooperative injected fetch retains its slot until it settles. */
export class VendorHttp {
  private active = 0;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async text(url: string, init: RequestInit, options: { timeoutMs: number; maxBytes: number }): Promise<string> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > VENDOR_HTTP_LIMITS.productTimeoutMs
      || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > VENDOR_HTTP_LIMITS.productBytes) throw new Error('invalid vendor HTTP limits');
    if (typeof init.body === 'string' && Buffer.byteLength(init.body) > VENDOR_HTTP_LIMITS.requestBytes) throw new VendorTransportError('VENDOR_REQUEST_LIMIT');
    if (this.active >= VENDOR_HTTP_LIMITS.concurrent) throw new VendorTransportError('VENDOR_CAPACITY');
    this.active++;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let cleanup: Promise<unknown> | undefined;
    const cancel = (body?: ReadableStream<Uint8Array> | null) => {
      if (!cleanup) {
        if (reader) cleanup = reader.cancel().catch(() => {});
        else if (body && !body.locked) cleanup = body.cancel().catch(() => {});
      }
    };
    const operation = async () => {
      try {
        const res = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual', cache: 'no-store', credentials: 'omit' });
        if (timedOut) { cancel(res.body); throw new VendorTransportError('VENDOR_TIMEOUT'); }
        if (!res.ok || res.redirected) { cancel(res.body); throw new VendorTransportError('VENDOR_HTTP', res.status); }
        const declared = res.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
          cancel(res.body); throw new VendorTransportError('VENDOR_BAD_RESPONSE');
        }
        if (declared !== null && Number(declared) > options.maxBytes) { cancel(res.body); throw new VendorTransportError('VENDOR_RESPONSE_LIMIT'); }
        if (!res.body) throw new VendorTransportError('VENDOR_BAD_RESPONSE');
        reader = res.body.getReader();
        const buffer = new Uint8Array(options.maxBytes); let size = 0; let chunks = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (timedOut) throw new VendorTransportError('VENDOR_TIMEOUT');
          if (done) break;
          if (++chunks > VENDOR_HTTP_LIMITS.chunks || value.byteLength > buffer.length - size) throw new VendorTransportError('VENDOR_RESPONSE_LIMIT');
          buffer.set(value, size); size += value.byteLength;
        }
        // fetch may decompress content; content-length then describes compressed bytes.
        if (!res.headers.get('content-encoding') && declared !== null && Number(declared) !== size) throw new VendorTransportError('VENDOR_BAD_RESPONSE');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
        catch { throw new VendorTransportError('VENDOR_BAD_RESPONSE'); }
      } catch (e) {
        controller.abort();
        cancel();
        if (e instanceof VendorTransportError) throw e;
        throw new VendorTransportError(timedOut ? 'VENDOR_TIMEOUT' : 'VENDOR_NETWORK');
      } finally {
        try { reader?.releaseLock(); } catch { /* outstanding cancelled read */ }
        // An error response need not wait for cancellation, but the slot must do so.
        if (cleanup) void cleanup.then(() => { this.active--; });
        else this.active--;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true; controller.abort();
        cancel();
        reject(new VendorTransportError('VENDOR_TIMEOUT'));
      }, options.timeoutMs);
    });
    try { return await Promise.race([operation(), deadline]); }
    finally { clearTimeout(timer); }
  }
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VendorTransportError('VENDOR_BAD_RESPONSE');
  return value as Record<string, unknown>;
}

export function parseVendorJson(text: string): Record<string, unknown> {
  try { return jsonObject(JSON.parse(text)); }
  catch { throw new VendorTransportError('VENDOR_BAD_RESPONSE'); }
}

/** OAuth acquisition is single-flight per client. Invalidated tokens cannot clear newer tokens. */
export class VendorTokenCache {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  constructor(private readonly now: () => number, private readonly maxAgeSeconds: number) {}
  invalidate(value: string) { if (this.token?.value === value) this.token = null; }
  get(load: () => Promise<Record<string, unknown>>, force = false): Promise<string> {
    if (this.pending) return this.pending;
    if (!force && this.token && this.token.expiresAt > this.now() + 60_000) return Promise.resolve(this.token.value);
    this.token = null;
    this.pending = (async () => {
      const j = await load(); const token = j.access_token;
      const age = j.expires_in === undefined ? this.maxAgeSeconds : typeof j.expires_in === 'string' && /^\d+$/.test(j.expires_in) ? Number(j.expires_in) : j.expires_in;
      if (typeof token !== 'string' || token.length < 1 || token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)
        || typeof age !== 'number' || !Number.isSafeInteger(age) || age < 1 || age > this.maxAgeSeconds) throw new VendorTransportError('VENDOR_BAD_RESPONSE');
      this.token = { value: token, expiresAt: this.now() + age * 1000 };
      return token;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
