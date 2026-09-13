import 'server-only';
import { spawn } from 'node:child_process';
import path from 'node:path';
import policy from './id-image-policy.json';
import { RequestGuardError } from './request-guard';

export { policy as ID_IMAGE_POLICY };
export type IdImageMetadata = { format: 'jpeg' | 'png'; width: number; height: number };
const invalid = () => new RequestGuardError('invalid image: use a complete, single-frame JPEG or PNG, at most 12 megapixels and 8192 pixels per side', 422);
const unavailable = () => new RequestGuardError('document image validation is temporarily unavailable', 503, 1);

/** Frame the JPEG marker stream to reject appended images/MPO. Entropy decoding remains sharp's job. */
function checkJpeg(b: Buffer): void {
  if (b.length < 4 || b[0] !== 255 || b[1] !== 216) throw invalid();
  let offset = 2; let scan = false; let frames = 0; let scans = 0;
  while (offset < b.length) {
    if (scan) {
      const start = b.indexOf(255, offset); if (start < 0) throw invalid();
      offset = start + 1;
      while (b[offset] === 255) offset++;
      const code = b[offset];
      if (code === 0 || (code >= 208 && code <= 215)) { offset++; continue; }
      offset = start; scan = false;
    }
    if (b[offset++] !== 255) throw invalid();
    while (b[offset] === 255) offset++;
    const code = b[offset++];
    if (code === 217) {
      if (offset !== b.length || frames !== 1 || scans < 1) throw invalid();
      return;
    }
    if (!code || code === 216 || code === 1 || (code >= 208 && code <= 215) || offset + 2 > b.length) throw invalid();
    const length = b.readUInt16BE(offset);
    if (length < 2 || length > b.length - offset) throw invalid();
    if (code === 192 || code === 194) { if (++frames !== 1) throw invalid(); }
    // Admit only baseline/progressive DCT frames, not hierarchical/lossless/multi-picture JPEG.
    else if ([193, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(code)) throw invalid();
    if (code === 226 && length >= 6 && b.toString('ascii', offset + 2, offset + 6) === 'MPF\0') throw invalid();
    if (code === 218) { if (frames !== 1) throw invalid(); scans++; scan = true; }
    offset += length;
  }
  throw invalid();
}

function checkContainer(input: Uint8Array, mime: string): 'jpeg' | 'png' {
  if (input.byteLength === 0) throw new RequestGuardError('image is required', 400);
  if (input.byteLength > policy.maxBytes) throw new RequestGuardError('image must be 5 MiB or smaller', 413);
  if (mime !== 'image/jpeg' && mime !== 'image/png') throw new RequestGuardError('only image/jpeg and image/png are supported', 415);
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (mime === 'image/jpeg') {
    checkJpeg(b);
    return 'jpeg';
  }
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
  // PNG loaders may read only the first frame of APNG. Reject animation chunks explicitly.
  // This is container framing, not a replacement for the native decoder/CRC checks.
  let offset = 8;
  while (offset + 12 <= b.length) {
    const length = b.readUInt32BE(offset); const kind = b.toString('ascii', offset + 4, offset + 8);
    if (length > b.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(kind)) throw invalid();
    if (offset === 8 && (kind !== 'IHDR' || length !== 13)) throw invalid();
    offset += length + 12;
    if (kind === 'IEND') {
      if (length !== 0 || offset !== b.length) throw invalid();
      return 'png';
    }
  }
  throw invalid();
}

/** Options are a local test seam, never request fields or environment configuration. */
export function createIdImageValidator(options: { workerPath?: string; timeoutMs?: number } = {}) {
  const workerPath = options.workerPath ?? path.join(process.cwd(), 'scripts', 'validate-id-image.mjs');
  const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
  let active = 0;
  return async (input: Uint8Array, mime: string, signal?: AbortSignal): Promise<IdImageMetadata> => {
    const expectedFormat = checkContainer(input, mime);
    if (signal?.aborted) throw new RequestGuardError('document request aborted', 408);
    if (active >= policy.maxConcurrent) throw new RequestGuardError('document image validation capacity reached', 503, 1);
    active++;
    return new Promise<IdImageMetadata>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, ['--max-old-space-size=128', workerPath], {
          stdio: ['pipe', 'pipe', 'ignore'], shell: false,
          // Never inherit issuer keys, vendor credentials, NODE_OPTIONS or loader injection.
          env: { NODE_ENV: 'production', VIPS_CONCURRENCY: '1', UV_THREADPOOL_SIZE: '1' },
        });
      } catch { active--; reject(unavailable()); return; }
      let failure: RequestGuardError | undefined; let output = Buffer.alloc(0);
      const stop = (error: RequestGuardError) => {
        failure ??= error;
        child.kill('SIGKILL');
        // Respond promptly, but retain the admission slot until close confirms termination.
        reject(failure);
      };
      const abort = () => stop(new RequestGuardError('document request aborted', 408));
      const timer = setTimeout(() => stop(unavailable()), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.on('error', () => stop(unavailable()));
      child.stdin!.on('error', () => { /* close/exit decides; no unhandled EPIPE */ });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > 1024) { stop(unavailable()); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.on('close', (code) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); active--;
        if (failure) return;
        if (code === 2 && output.toString() === 'invalid') { reject(invalid()); return; }
        if (code !== 0) { reject(unavailable()); return; }
        try {
          const result = JSON.parse(output.toString()) as IdImageMetadata;
          if (!result || Object.keys(result).sort().join(',') !== 'format,height,width' || result.format !== expectedFormat
            || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1
            || result.width > policy.maxDimension || result.height > policy.maxDimension || result.width * result.height > policy.maxPixels) throw new Error();
          resolve(result);
        } catch { reject(unavailable()); }
      });
      child.stdin!.end(input);
    });
  };
}

export const validateIdImage = createIdImageValidator();
