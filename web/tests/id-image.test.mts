import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createIdImageValidator, ID_IMAGE_POLICY } from '../lib/id-image';
import { RequestGuardError } from '../lib/request-guard';

const raster = (width = 32, height = 24) => sharp({ create: { width, height, channels: 3, background: '#aabbcc' } });
const png = await raster().png().toBuffer(); const jpeg = await raster().jpeg().toBuffer();
const status = (n: number) => (e: unknown) => e instanceof RequestGuardError && e.status === n;

test('actual native decode accepts JPEG/PNG without mutating original evidence bytes', async () => {
  const validate = createIdImageValidator();
  for (const [format, input] of [['jpeg', jpeg], ['png', png]] as const) {
    const original = Buffer.from(input);
    assert.deepEqual(await validate(input, `image/${format}`), { format, width: 32, height: 24 });
    assert.deepEqual(input, original);
  }
  const progressive = await raster().jpeg({ progressive: true }).toBuffer();
  assert.deepEqual(await validate(progressive, 'image/jpeg'), { format: 'jpeg', width: 32, height: 24 });
});

test('MIME/magic mismatch, unsupported formats, empty/oversize and incomplete containers fail', async () => {
  const validate = createIdImageValidator();
  for (const mime of ['image/svg+xml', 'image/gif', 'image/webp', 'application/pdf', '', 'image/jpg']) {
    await assert.rejects(validate(png, mime), status(415));
  }
  await assert.rejects(validate(png, 'image/jpeg'), status(422));
  await assert.rejects(validate(jpeg, 'image/png'), status(422));
  await assert.rejects(validate(Buffer.from('<svg/>'), 'image/png'), status(422));
  await assert.rejects(validate(Buffer.alloc(0), 'image/png'), status(400));
  await assert.rejects(validate(Buffer.alloc(ID_IMAGE_POLICY.maxBytes + 1), 'image/png'), status(413));
  await assert.rejects(validate(png.subarray(0, -1), 'image/png'), status(422));
  await assert.rejects(validate(Buffer.concat([png, Buffer.from('extra')]), 'image/png'), status(422));
  await assert.rejects(validate(jpeg.subarray(0, -2), 'image/jpeg'), status(422));
  await assert.rejects(validate(Buffer.concat([jpeg, jpeg]), 'image/jpeg'), status(422));
  await assert.rejects(validate(Buffer.concat([jpeg, Buffer.from('extra')]), 'image/jpeg'), status(422));
  const mpf = Buffer.from([255, 226, 0, 6, 77, 80, 70, 0]);
  await assert.rejects(validate(Buffer.concat([jpeg.subarray(0, 2), mpf, jpeg.subarray(2)]), 'image/jpeg'), status(422));
});

test('metadata-readable but damaged compressed pixels fail full decode', async () => {
  const validate = createIdImageValidator();
  const damaged = Buffer.from(jpeg);
  const sos = damaged.indexOf(Buffer.from([255, 218])); assert.ok(sos > 0);
  const truncated = Buffer.concat([damaged.subarray(0, sos + 14), Buffer.from([255, 217])]);
  assert.equal((await sharp(truncated).metadata()).width, 32);
  await assert.rejects(validate(truncated, 'image/jpeg'), status(422));
  const brokenPng = Buffer.from(png); const idat = brokenPng.indexOf('IDAT'); assert.ok(idat > 0);
  brokenPng[idat + 4] ^= 255;
  await assert.rejects(validate(brokenPng, 'image/png'), status(422));
});

test('compressed oversized dimensions/pixel count and APNG are rejected', async () => {
  const validate = createIdImageValidator();
  const tooWide = await raster(8193, 1).png().toBuffer();
  const tooMany = await raster(3000, 4001).png().toBuffer();
  assert.ok(tooMany.length < ID_IMAGE_POLICY.maxBytes);
  await assert.rejects(validate(tooWide, 'image/png'), status(422));
  await assert.rejects(validate(tooMany, 'image/png'), status(422));
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write('acTL', 4); chunk.writeUInt32BE(2, 8);
  await assert.rejects(validate(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]), 'image/png'), status(422));
});

test('exact pixel-count and side-length boundaries still decode', async () => {
  const validate = createIdImageValidator();
  for (const [width, height] of [[3000, 4000], [8192, 1]]) {
    const input = await raster(width, height).png().toBuffer();
    assert.deepEqual(await validate(input, 'image/png'), { format: 'png', width, height });
  }
});

test('worker receives no inherited credentials and excess output fails closed', async () => {
  process.env.CODEF_CLIENT_SECRET = 'synthetic-parent-only-do-not-inherit';
  process.env.ISSUER_PRIVATE_KEY = 'synthetic-parent-only-not-a-key';
  const validate = createIdImageValidator({ workerPath: fileURLToPath(new URL('./fixtures/image-worker-protocol.mjs', import.meta.url)) });
  try {
    assert.deepEqual(await validate(jpeg, 'image/jpeg'), { format: 'jpeg', width: 32, height: 24 });
    await assert.rejects(validate(png, 'image/png'), status(503));
  } finally { delete process.env.CODEF_CLIENT_SECRET; delete process.env.ISSUER_PRIVATE_KEY; }
});

test('two hung workers exhaust admission; timeout kills and eventually restores slots', async () => {
  const validate = createIdImageValidator({ workerPath: fileURLToPath(new URL('./fixtures/hostile-image-worker.mjs', import.meta.url)), timeoutMs: 200 });
  const a = assert.rejects(validate(png, 'image/png'), status(503));
  const b = assert.rejects(validate(png, 'image/png'), status(503));
  await assert.rejects(validate(png, 'image/png'), /capacity reached/);
  await Promise.all([a, b]);
  // A timeout response alone must not release capacity; child close is asynchronous.
  await delay(100);
  await assert.rejects(validate(png, 'image/png'), e => status(503)(e) && !String(e).includes('capacity'));
});

test('aborted request and missing decoder fail closed without unhandled pipe errors', async () => {
  const missing = createIdImageValidator({ workerPath: '/nonexistent-proofmark-test-image-worker.mjs' });
  await assert.rejects(missing(png, 'image/png'), status(503));
  const validate = createIdImageValidator({ workerPath: fileURLToPath(new URL('./fixtures/hostile-image-worker.mjs', import.meta.url)) });
  const controller = new AbortController();
  const pending = assert.rejects(validate(png, 'image/png', controller.signal), status(408));
  controller.abort(); await pending;
  await assert.rejects(validate(png, 'image/png', controller.signal), status(408));
});
