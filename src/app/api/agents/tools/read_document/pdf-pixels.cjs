'use strict';

const { MAX_DECODED_IMAGE_PIXELS } = require('./png.cjs');

/** PDF.js ImageKind, not data.length / pixels: 1bpp rows have byte padding. */
function rawPdfImage(image) {
  const { width, height, kind, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > MAX_DECODED_IMAGE_PIXELS ||
      !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
    throw new Error('Unsupported or oversized decoded image.');
  }
  if (kind === 1) {
    const stride = Math.ceil(width / 8);
    if (data.length !== stride * height) throw new Error('Invalid packed image layout.');
    const unpacked = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        unpacked[y * width + x] = data[y * stride + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
      }
    }
    return { width, height, channels: 1, data: unpacked };
  }
  const channels = kind === 2 ? 3 : kind === 3 ? 4 : 0;
  if (!channels || data.length !== width * height * channels) throw new Error('Unsupported raw image layout.');
  return { width, height, channels, data };
}

module.exports = { rawPdfImage };