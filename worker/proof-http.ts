import { throwIfStopped } from './retry.js';

export class ProofHttpError extends Error {
  constructor(code: 'PROOF_HTTP_TIMEOUT' | 'PROOF_HTTP_NETWORK' | 'PROOF_HTTP_STATUS' | 'PROOF_HTTP_LIMIT' | 'PROOF_HTTP_INVALID') { super(code); }
}

/** Native fetch is aborted, not merely raced and left running. Byte limit includes decompression. */
export async function proofJson(url: string, options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number }): Promise<unknown> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 15000
    || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 8 * 1024 * 1024) throw new ProofHttpError('PROOF_HTTP_INVALID');
  throwIfStopped(options.signal);
  const controller = new AbortController(); let timedOut = false;
  const stop = () => controller.abort(); options.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new ProofHttpError('PROOF_HTTP_STATUS'); }
    const declared = res.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > options.maxBytes)) {
      void res.body?.cancel().catch(() => {}); throw new ProofHttpError('PROOF_HTTP_LIMIT');
    }
    if (!res.body) throw new ProofHttpError('PROOF_HTTP_INVALID');
    reader = res.body.getReader(); const buffer = new Uint8Array(options.maxBytes); let size = 0, chunks = 0;
    for (;;) {
      const { value, done } = await reader.read(); throwIfStopped(options.signal);
      if (done) break;
      if (++chunks > 65536 || value.byteLength > buffer.length - size) throw new ProofHttpError('PROOF_HTTP_LIMIT');
      buffer.set(value, size); size += value.byteLength;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))); }
    catch { throw new ProofHttpError('PROOF_HTTP_INVALID'); }
  } catch (error) {
    controller.abort(); if (reader) void reader.cancel().catch(() => {});
    throwIfStopped(options.signal);
    if (timedOut) throw new ProofHttpError('PROOF_HTTP_TIMEOUT');
    if (error instanceof ProofHttpError) throw error;
    throw new ProofHttpError('PROOF_HTTP_NETWORK');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
    try { reader?.releaseLock(); } catch { /* cancelled read cleanup */ }
  }
}
