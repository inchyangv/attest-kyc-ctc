// The driver consumes untrusted deployment responses. These are fixed diagnostic codes,
// never response text, URLs, opaque proofs, parser errors or nested fetch causes.
export class DriverHttpError extends Error {
  constructor(code) { super(code); this.name = 'DriverHttpError'; this.code = code; }
}

export async function driverJsonRequest(url, init = {}, { maxBytes = 262144, timeoutMs = 30000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 262144 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new DriverHttpError('DRIVER_INVALID_LIMIT');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const type = (res.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!(type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)) || !res.body) {
      throw new DriverHttpError('DRIVER_RESPONSE_INVALID');
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      throw new DriverHttpError('DRIVER_RESPONSE_TOO_LARGE');
    }
    reader = res.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Fetch exposes decompressed bytes. Do not trust Content-Length or a small gzip body.
      if (total > maxBytes || chunks.length >= 4096) throw new DriverHttpError('DRIVER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); }
    catch { throw new DriverHttpError('DRIVER_RESPONSE_INVALID'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DriverHttpError('DRIVER_RESPONSE_INVALID');
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof DriverHttpError) throw error;
    throw new DriverHttpError(controller.signal.aborted ? 'DRIVER_REQUEST_TIMEOUT' : 'DRIVER_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
    controller.abort(); // Also closes an unread/rejected or over-limit body; no retry or redirect.
    reader?.releaseLock();
  }
}
