'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { deflateSync, inflateSync } = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { join } = require('node:path');
const { decodePdfImages } = require('../pdf-decoder.cjs');
const { rawPdfImage } = require('../pdf-pixels.cjs');
const { encodePng, resizeImage } = require('../png.cjs');

const childPath = join(__dirname, '../pdf-decoder.cjs');
const byteLimit = 8 * 1024 * 1024;
const childEnv = { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' };

// Entirely synthetic PDF with exact stream lengths and xref offsets.
function fixture({ count = 1, width = 9, height = 2, rgb = false, inline = false,
  mask = false, softMask = false, pixels, repeat = false, blank = false, pageCount = 1 } = {}) {
  const objects = [];
  const add = data => (objects.push(Buffer.from(data)), objects.length);
  const stream = (dict, data) => Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream'),
  ]);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('');
  const refs = [];
  const content = [];
  let alpha;
  if (softMask) alpha = add(stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(Buffer.alloc(width * height, 128))));
  for (let i = 0; i < (blank ? 0 : count); i++) {
    const data = pixels || (rgb ? Buffer.alloc(width * height * 3, 80) : Buffer.from([0xaa, 0xff, 0x55, 0x00]));
    const dict = `/Width ${width} /Height ${height} ${mask ? '/ImageMask true' : `/ColorSpace /${rgb ? 'DeviceRGB' : 'DeviceGray'}`} /BitsPerComponent ${rgb ? 8 : 1}`;
    if (inline) {
      content.push(Buffer.from(`q\nBI ${dict} ID\n`), data, Buffer.from('\nEI\nQ\n'));
    } else {
      const id = repeat && refs.length ? refs[0] : add(stream(`/Type /XObject /Subtype /Image ${dict} ${alpha ? `/SMask ${alpha} 0 R` : ''} /Filter /FlateDecode`, deflateSync(data)));
      refs.push(id);
      content.push(Buffer.from(`q 100 0 0 100 0 0 cm /Im${i} Do Q\n`));
    }
  }
  const contents = add(stream('', Buffer.concat(content)));
  objects[2] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << ${refs.map((id, i) => `/Im${i} ${id} 0 R`).join(' ')} >> >> /Contents ${contents} 0 R >>`);
  const pageIds = [3];
  for (let i = 1; i < pageCount; i++) pageIds.push(add(objects[2]));
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let size = parts[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(size);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(part);
    size += part.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function pngData(image) {
  const png = Buffer.from(image.data_url.split(',')[1], 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const idats = [];
  let ended = false;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idats.push(png.subarray(offset + 8, offset + 8 + size));
    if (type === 'IEND') ended = true;
    offset += size + 12;
  }
  assert.ok(ended);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25], data: inflateSync(Buffer.concat(idats)) };
}

function child(bytes, pages = [1], linuxLimits = false) {
  const args = ['--jitless', '--max-old-space-size=128', childPath, JSON.stringify(pages)];
  const options = { input: bytes, env: childEnv, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: byteLimit + 4096 };
  return linuxLimits
    ? spawnSync('/bin/sh', ['-c', 'ulimit -c 0 && ulimit -d 393216 && ulimit -t 8 && exec "$@"', 'pdf-test', process.execPath, ...args], options)
    // Trusted fixtures only: non-Linux has no production OS isolation path.
    : spawnSync(process.execPath, args, options);
}

test('ImageKind handling unpacks MSB-first 1bpp with per-row padding; no channel inference', () => {
  const raw = rawPdfImage({ width: 9, height: 2, kind: 1, data: Uint8Array.from([0xaa, 0xff, 0x55, 0]) });
  assert.deepEqual([...raw.data], [255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0]);
  for (const [kind, channels] of [[2, 3], [3, 4]]) {
    assert.equal(rawPdfImage({ width: 1, height: 1, kind, data: new Uint8Array(channels) }).channels, channels);
  }
  for (const image of [
    { width: 1, height: 1, data: new Uint8Array(3) },
    { width: 9, height: 2, kind: 1, data: new Uint8Array(3) },
    { width: 1, height: 1, kind: 2, data: new Uint8Array(4) },
    { width: 12000001, height: 1, kind: 1, data: new Uint8Array(0) },
  ]) assert.throws(() => rawPdfImage(image));
});

test('real monochrome XObject and inline fixtures have exact PNG pixels', async () => {
  for (const inline of [false, true]) {
    const result = await decodePdfImages(fixture({ inline }), [1]);
    assert.equal(result.images.length, 1);
    assert.equal(result.truncated, false);
    const png = pngData(result.images[0]);
    assert.equal(png.width, 9);
    assert.equal(png.height, 2);
    // PDF.js may expand inline pixels to RGB. Check every component, not inference.
    const channels = png.colorType === 0 ? 1 : png.colorType === 2 ? 3 : 4;
    const expected = [255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 9; x++) {
      for (let c = 0; c < Math.min(channels, 3); c++) assert.equal(png.data[y * (9 * channels + 1) + 1 + x * channels + c], expected[y * 9 + x]);
    }
  }
});

test('RGB, soft alpha masks, and stencil omission are explicit', async () => {
  const rgb = await decodePdfImages(fixture({ rgb: true, width: 2, height: 1 }), [1]);
  assert.deepEqual(pngData(rgb.images[0]).data, Buffer.from([0, 80, 80, 80, 80, 80, 80]));
  const rgba = await decodePdfImages(fixture({ rgb: true, softMask: true, width: 2, height: 1 }), [1]);
  assert.equal(pngData(rgba.images[0]).colorType, 6);
  assert.deepEqual(pngData(rgba.images[0]).data, Buffer.from([0, 80, 80, 80, 128, 80, 80, 80, 128]));
  const mask = await decodePdfImages(fixture({ mask: true, count: 40 }), [1]);
  assert.deepEqual(mask.images, []);
  assert.equal(mask.truncated, true);
  assert.match(mask.warnings.join(' '), /stencil image masks were omitted/);
});

test('many images cap at five, repeated XObjects deduplicate, blank pages warn', async () => {
  const many = await decodePdfImages(fixture({ count: 40 }), [1]);
  assert.equal(many.images.length, 5);
  assert.equal(many.truncated, true);
  assert.match(many.warnings.join(' '), /5-image or 8 MiB/);
  many.images.forEach(pngData);
  const repeat = await decodePdfImages(fixture({ count: 20, repeat: true }), [1, 1]);
  assert.equal(repeat.images.length, 1);
  assert.equal(repeat.truncated, false);
  const blank = await decodePdfImages(fixture({ blank: true }), [1]);
  assert.match(blank.warnings.join(' '), /no extractable embedded images/);
  assert.deepEqual(await decodePdfImages(fixture(), []), { images: [], warnings: [], truncated: false });
});

test('adaptive resize preserves complete PNGs within 8 MiB encoded data', async () => {
  const result = await decodePdfImages(fixture({ rgb: true, width: 1600, height: 1600, pixels: randomBytes(1600 * 1600 * 3) }), [1]);
  assert.equal(result.images.length, 1);
  assert.ok(result.images.reduce((n, image) => n + image.data_url.length, 0) <= byteLimit);
  assert.match(result.warnings.join(' '), /downsampled/);
  assert.ok(pngData(result.images[0]).width < 1600);
});

test('shared PNG runtime retains layout/dimension guards and downsampling', () => {
  assert.throws(() => encodePng({ width: 4000001, height: 1, channels: 1, data: new Uint8Array() }));
  assert.throws(() => encodePng({ width: 1, height: 1, channels: 3, data: new Uint8Array(2) }));
  const image = resizeImage({ width: 10000, height: 1, channels: 1, data: new Uint8Array(10000) });
  assert.equal(image.width, 8192);
});

test('plain CJS CLI emits only JSON under production Node flags; failures are bounded', () => {
  const result = child(fixture());
  assert.equal(result.status, 0, result.stderr.toString());
  const parsed = JSON.parse(result.stdout.toString());
  assert.deepEqual(Object.keys(parsed).sort(), ['images', 'truncated', 'warnings']);
  assert.equal(parsed.images[0].mime_type, 'image/png');
  assert.equal(parsed.images[0].page, 1);
  pngData(parsed.images[0]);
  for (const bytes of [Buffer.from('not a PDF'), Buffer.alloc(20 * 1024 * 1024 + 1)]) {
    const failed = child(bytes);
    assert.equal(failed.status, 1);
    const value = JSON.parse(failed.stdout.toString());
    assert.deepEqual(value.images, []);
    assert.equal(value.truncated, true);
    assert.ok(failed.stdout.length < 1024);
  }
  assert.equal(child(fixture(), ['untrusted']).status, 1);
});

test('Linux production data/CPU limits permit real small, mask, and many-image fixtures', { skip: process.platform !== 'linux' }, () => {
  for (const options of [{}, { mask: true, count: 100 }, { count: 100 }]) {
    const result = child(fixture(options), [1], true);
    assert.equal(result.status, 0, result.stderr.toString());
    const parsed = JSON.parse(result.stdout.toString());
    assert.ok(parsed.images.length <= 5);
    assert.ok(result.stdout.length <= byteLimit + 4096);
  }
});

test('Linux allocation-heavy images stay inside parent-enforced process bounds', { skip: process.platform !== 'linux' }, () => {
  const start = Date.now();
  const result = child(fixture({ count: 80, rgb: true, width: 1000, height: 1000 }), [1], true);
  assert.ok(Date.now() - start < 15000);
  assert.ok(result.stdout.length <= byteLimit + 4096);
  // A resource kill is expected/acceptable. Parent must treat it as truncation.
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout.toString());
    assert.ok(parsed.images.length <= 5);
    assert.equal(parsed.truncated, true);
  } else assert.ok(result.signal || result.status !== 0);
});

// Opt-in trusted-fixture profiling, not a production isolation bypass. /usr/bin/time
// measures the real CLI including package loading, decoding, PNG encoding and JSON.
test('benchmark two 4MP synthetic scan pages through the jitless CLI', {
  skip: process.env.PDF_DECODER_BENCHMARK !== '1' || !['darwin', 'linux'].includes(process.platform),
}, t => {
  const width = 2000;
  const height = 2000;
  const noise = randomBytes(width * height);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Noisy paper, dark pseudo-text strokes and a shaded illustration region.
    const ink = y > 100 && y < 1800 && y % 40 < 14 && x > 100 && x < 1800 && x % 24 < 16;
    const shade = x > 1200 && y > 1200 ? 128 : ink ? 16 : 224;
    const value = shade + (noise[y * width + x] & 31);
    pixels.fill(value, (y * width + x) * 3, (y * width + x + 1) * 3);
  }
  // Shared source XObject is decoded/extracted on both selected pages.
  const bytes = fixture({ rgb: true, width, height, pixels, pageCount: 2 });
  assert.ok(bytes.length <= 20 * 1024 * 1024);
  const started = performance.now();
  const result = spawnSync('/usr/bin/time', ['-p', process.execPath, '--jitless', '--max-old-space-size=128', childPath, '[1,2]'], {
    input: bytes, env: childEnv, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: byteLimit + 4096,
  });
  const wallMs = performance.now() - started;
  assert.equal(result.status, 0, `${result.error || ''} ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.toString());
  assert.deepEqual(parsed.images.map(image => image.page), [1, 2]);
  const dimensions = parsed.images.map(image => {
    const png = pngData(image);
    return `${png.width}x${png.height}`;
  });
  const timing = result.stderr.toString();
  const user = Number(timing.match(/^user\s+([\d.]+)/m)?.[1]);
  const system = Number(timing.match(/^sys\s+([\d.]+)/m)?.[1]);
  assert.ok(Number.isFinite(user + system), timing);
  t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version, inputBytes: bytes.length,
    outputBytes: result.stdout.length, wallMs: Math.round(wallMs), userSeconds: user, systemSeconds: system,
    cpuSeconds: user + system, dimensions, warnings: parsed.warnings }));
  assert.ok(user + system < 8, 'Fixture exceeds the production 8-second CPU budget');
});