'use strict';

const { encodePng, resizeImage, MAX_DECODED_IMAGE_PIXELS } = require('./png.cjs');
const { rawPdfImage } = require('./pdf-pixels.cjs');

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';
const FAILURE = 'Some PDF images could not be extracted or encoded within the supported pixel/layout limits. OCR or external rendering may be needed.';

/**
 * Fixture-only direct entry point. Production MUST invoke this file as an OS-bounded
 * child: getOperatorList can decode all images before our output cap applies.
 * pages is the trusted parent's explicit, one-based list (empty means no work).
 * No text extraction, page selection, OCR, or full-page rendering occurs here.
 */
async function decodePdfImages(bytes, pages) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT_BYTES) throw new Error('Invalid PDF input size.');
  if (!Array.isArray(pages) || pages.some(page => !Number.isSafeInteger(page) || page < 1)) throw new Error('Invalid PDF pages.');
  const images = [];
  const warnings = [];
  if (!pages.length) return { images, warnings, truncated: false };
  // The public CJS entry asynchronously imports its own PDF.js bundle.
  const { getDocumentProxy, getResolvedPDFJS } = require('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    useWasm: false, isEvalSupported: false, verbosity: 0,
    maxImageSize: MAX_DECODED_IMAGE_PIXELS,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useSystemFonts: false, disableFontFace: true,
  });
  let encodedBytes = 0;
  let failures = 0;
  let unavailable = 0;
  let masks = false;
  let imageLimits = false;
  let resized = false;
  try {
    const { OPS } = await getResolvedPDFJS();
    const maskOps = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]);
    for (const number of new Set(pages)) {
      if (images.length >= MAX_IMAGES) { imageLimits = true; break; }
      let page;
      try {
        page = await pdf.getPage(number);
        const operators = await page.getOperatorList();
        const seen = new Set();
        let candidates = 0;
        for (let i = 0; i < operators.fnArray.length; i++) {
          const op = operators.fnArray[i];
          if (maskOps.has(op)) { masks = true; continue; }
          const xobject = op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat;
          const inline = op === OPS.paintInlineImageXObject;
          // Inline atlases require placement/cropping, not a standalone image.
          if (op === OPS.paintInlineImageXObjectGroup) { failures++; continue; }
          if (!xobject && !inline) continue;
          const source = operators.argsArray[i][0];
          if (seen.has(source)) continue;
          seen.add(source);
          candidates++;
          if (images.length >= MAX_IMAGES) { imageLimits = true; break; }
          try {
            const decoded = xobject
              ? await new Promise(resolve => (source.startsWith('g_') ? page.commonObjs : page.objs).get(source, resolve))
              : source;
            const image = rawPdfImage(decoded);
            const bounded = resizeImage(image);
            resized ||= bounded !== image;
            let png = encodePng(bounded);
            let size = PNG_PREFIX.length + 4 * Math.ceil(png.length / 3);
            let targetPixels = Math.min(image.width * image.height, 4_000_000);
            // Previous fallback policy: two adaptive retries, 250k pixel floor.
            for (let attempt = 0; encodedBytes + size > MAX_IMAGE_BYTES && attempt < 2; attempt++) {
              targetPixels = Math.floor(targetPixels * (MAX_IMAGE_BYTES - encodedBytes) / size * 0.8);
              if (targetPixels < 250_000) break;
              png = encodePng(resizeImage(image, targetPixels));
              resized = true;
              size = PNG_PREFIX.length + 4 * Math.ceil(png.length / 3);
            }
            if (encodedBytes + size > MAX_IMAGE_BYTES) { imageLimits = true; continue; }
            images.push({ page: number, mime_type: 'image/png', data_url: PNG_PREFIX + png.toString('base64') });
            encodedBytes += size;
          } catch { failures++; }
        }
        if (!candidates) unavailable++;
      } catch { failures++; }
      finally { if (page) page.cleanup(); }
    }
    if (unavailable) warnings.push(`${unavailable} textless page(s) had no extractable embedded images (unsupported or oversized images may be skipped). OCR or external rendering may be needed.`);
    if (failures) warnings.push(FAILURE);
    if (masks) warnings.push('PDF stencil image masks were omitted: their paint color and compositing require full-page rendering.');
    if (resized) warnings.push('PDF images were downsampled to at most 4 million pixels and 8192 pixels per dimension. Fine detail may be lost.');
    if (imageLimits) warnings.push('PDF image fallback was truncated by the 5-image or 8 MiB encoded-data limit.');
    return { images, warnings, truncated: imageLimits || failures > 0 || masks };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function main() {
  // Before importing unpdf: stdout is exclusively the one JSON response.
  for (const name of Object.keys(console)) if (typeof console[name] === 'function') console[name] = () => {};
  try {
    const pages = JSON.parse(process.argv[2]);
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_INPUT_BYTES) throw new Error('PDF input exceeds limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    chunks.length = 0;
    const result = await decodePdfImages(bytes, pages);
    process.stdout.write(JSON.stringify(result));
  } catch {
    // Never echo PDF data, passwords, or parser error details into the protocol.
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ images: [], warnings: [FAILURE], truncated: true }));
  }
}

module.exports = { decodePdfImages };
if (require.main === module) void main();