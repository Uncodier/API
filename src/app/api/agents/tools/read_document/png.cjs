'use strict';

const { deflateSync } = require('node:zlib');
const MAX_IMAGE_PIXELS = 4000000;
const MAX_DECODED_IMAGE_PIXELS = 12000000;
const MAX_IMAGE_DIMENSION = 8192;
/** Bound encoded resolution while allowing ordinary 300dpi scanned pages. */
function resizeImage(image, maxPixels = MAX_IMAGE_PIXELS) {
    const { width, height, channels, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > MAX_DECODED_IMAGE_PIXELS || ![1, 3, 4].includes(channels) || data.length !== width * height * channels) {
        throw new Error('Unsupported or oversized decoded image.');
    }
    const scale = Math.min(1, Math.sqrt(Math.min(maxPixels, MAX_IMAGE_PIXELS) / (width * height)), MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
    if (scale === 1)
        return image;
    const resizedWidth = Math.max(1, Math.floor(width * scale));
    const resizedHeight = Math.max(1, Math.floor(height * scale));
    const resized = new Uint8Array(resizedWidth * resizedHeight * channels);
    for (let y = 0; y < resizedHeight; y++) {
        const sourceRow = Math.floor(y * height / resizedHeight) * width;
        for (let x = 0; x < resizedWidth; x++) {
            const source = (sourceRow + Math.floor(x * width / resizedWidth)) * channels;
            const target = (y * resizedWidth + x) * channels;
            for (let c = 0; c < channels; c++)
                resized[target + c] = data[source + c];
        }
    }
    return { width: resizedWidth, height: resizedHeight, channels, data: resized };
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function chunk(type, data) {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0);
    output.write(type, 4, 4, 'ascii');
    data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, -4))
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
}
/** unpdf returns raw pixels, NOT PNG bytes. Encode without a canvas/native dependency. */
function encodePng(image) {
    const { width, height, channels, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
        throw new Error('Image exceeds the pixel/dimension limit.');
    }
    if (![1, 3, 4].includes(channels) || data.length !== width * height * channels) {
        throw new Error('Unsupported raw image layout.');
    }
    const stride = width * channels;
    const scanlines = Buffer.alloc((stride + 1) * height);
    for (let row = 0; row < height; row++)
        scanlines.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
    ]);
}
module.exports = { MAX_IMAGE_PIXELS, MAX_DECODED_IMAGE_PIXELS, resizeImage, encodePng };
