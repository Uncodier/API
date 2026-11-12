import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Conservative PNG subset: fully inflated 8-bit RGB/RGBA, noninterlaced, bounded pixels.
 * Header-only checks cannot establish a decodable artifact. No remote URLs are followed.
 */
export function validateCustomerPng(value: unknown, size?: string, ratio?: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 22 * 1024 * 1024
      || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid image encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Invalid PNG');
  let offset = 8; let width = 0; let height = 0; let channels = 0;
  let ended = false; let dataEnded = false; const compressed: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('Invalid PNG checksum');
    if (offset === 8 && type !== 'IHDR') throw new Error('Missing PNG header');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('Invalid PNG header');
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 8_294_400
          || payload[8] !== 8 || ![2, 6].includes(payload[9]) || payload[10] || payload[11] || payload[12]) {
        throw new Error('Unsupported PNG format or dimensions');
      }
      channels = payload[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (dataEnded) throw new Error('Noncontiguous PNG data');
      compressed.push(payload);
    } else if (type === 'IEND') {
      if (length || end !== bytes.length || !compressed.length) throw new Error('Invalid PNG end');
      ended = true; break;
    } else {
      if (compressed.length) dataEnded = true;
      // Reject unknown critical chunks and animation; this adapter only accepts still RGB/RGBA.
      if (!/^[a-z]/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw new Error('Unsupported PNG chunk');
    }
    offset = end;
  }
  if (!ended) throw new Error('Incomplete PNG');
  if (size && size !== `${width}x${height}`) throw new Error('Image size mismatch');
  if (ratio) {
    const [w, h] = ratio.split(':').map(Number);
    if (width * h !== height * w) throw new Error('Image ratio mismatch');
  }
  const stride = width * channels + 1;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height });
  if (raw.length !== stride * height) throw new Error('Invalid PNG pixel data');
  for (let row = 0; row < height; row++) {
    if (raw[row * stride] > 4) throw new Error('Invalid PNG filter');
  }
  return value;
}