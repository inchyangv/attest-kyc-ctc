import 'server-only';
import { assertBodyHeaders, RequestGuardError } from './request-guard';

export const BODY_LIMITS = Object.freeze({ wallet: 16_384, bank: 32_768, issue: 65_536, screen: 32_768, id: 6 * 1024 * 1024 });

/** Bound bytes BEFORE JSON/multipart parsing, independent of Content-Length or chunk size.
 * Fixed storage avoids one allocation per attacker-controlled tiny chunk. This bounds this
 * reader's buffer, not reverse-proxy buffering, parser overhead or fleet concurrency. */
export async function readBoundedBody(req: Request, maxBytes: number, timeoutMs = 10_000): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid request body limits');
  const declaredLength = assertBodyHeaders(req, maxBytes);
  if (req.signal.aborted) throw new RequestGuardError('request body was interrupted', 400);
  if (!req.body) {
    if (declaredLength) throw new RequestGuardError('content-length does not match body', 400);
    return new Uint8Array(0);
  }
  const reader = req.body.getReader();
  const storage = new Uint8Array(maxBytes);
  let size = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestGuardError('request body timed out', 408)), timeoutMs);
    abort = () => reject(new RequestGuardError('request body was interrupted', 400));
    req.signal.addEventListener('abort', abort, { once: true });
  });
  const consume = async () => {
    let chunks = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (stopped) throw new RequestGuardError('request body was interrupted', 400);
      if (done) break;
      if (++chunks > 65_536) throw new RequestGuardError('too many request body chunks', 413);
      if (!(value instanceof Uint8Array)) throw new RequestGuardError('invalid request body stream', 400);
      if (value.byteLength > maxBytes - size) throw new RequestGuardError('request body is too large', 413);
      storage.set(value, size); size += value.byteLength;
    }
    if (declaredLength !== undefined && declaredLength !== size) throw new RequestGuardError('content-length does not match body', 400);
    return storage.subarray(0, size);
  };
  try {
    // Race once, not once per chunk: repeated races retain deadline handlers for tiny chunks.
    return await Promise.race([consume(), interrupted]);
  } catch (error) {
    // A hostile/stalled underlying cancel must not delay the error response.
    void reader.cancel().catch(() => {});
    if (error instanceof RequestGuardError) throw error;
    throw new RequestGuardError('request body was interrupted', 400);
  } finally {
    stopped = true;
    clearTimeout(timer); req.signal.removeEventListener('abort', abort); reader.releaseLock();
  }
}

export async function readJsonObject(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestGuardError('content-type must be application/json', 415);
  const bytes = await readBoundedBody(req, maxBytes);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch { throw new RequestGuardError('request body must be a valid JSON object', 400); }
}

export async function readBoundedForm(req: Request, maxBytes: number): Promise<FormData> {
  const type = req.headers.get('content-type');
  if (type?.split(';', 1)[0].trim().toLowerCase() !== 'multipart/form-data') throw new RequestGuardError('content-type must be multipart/form-data', 415);
  const bytes = await readBoundedBody(req, maxBytes, 30_000);
  try {
    const form = await new Response(bytes, { headers: { 'content-type': type! } }).formData();
    const seen = new Set<string>();
    for (const [name, value] of form) {
      if (seen.has(name) || seen.size >= 24 || name.length > 100 || (typeof value === 'string' && value.length > 16_384)) {
        throw new Error('invalid form fields');
      }
      seen.add(name);
    }
    return form;
  } catch { throw new RequestGuardError('invalid multipart form or field limits exceeded', 400); }
}
