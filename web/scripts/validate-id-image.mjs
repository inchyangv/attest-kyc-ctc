// Fixed child-process entry point. Input/output are pipes, never filenames or identity logs.
import sharp from 'sharp';
import policy from '../lib/id-image-policy.json' with { type: 'json' };

sharp.cache(false);
sharp.concurrency(1);
const reject = () => { throw new Error('invalid image'); };
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > policy.maxBytes) reject();
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks, size);
  const options = { failOn: 'warning', limitInputPixels: policy.maxPixels, limitInputChannels: 4, unlimited: false };
  const metadata = await sharp(input, options).metadata();
  const { format, width, height } = metadata;
  if (!['jpeg', 'png'].includes(format) || !width || !height || width > policy.maxDimension || height > policy.maxDimension
    || width * height > policy.maxPixels || (metadata.pages ?? 1) !== 1) reject();
  // metadata() does not decode the pixel stream. Force full bounded 8-bit RGBA output.
  // Do not send the output back or replace the original document/hash with a re-encoding.
  const { data, info } = await sharp(input, options).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
    .timeout({ seconds: 2 }).toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 4 || data.length !== width * height * 4) reject();
  process.stdout.write(JSON.stringify({ format, width, height }));
} catch {
  // No native error strings, image bytes, filenames, EXIF or other identity data in output.
  process.stdout.write('invalid');
  process.exitCode = 2;
}
