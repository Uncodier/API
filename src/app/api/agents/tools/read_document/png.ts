// Shared runtime for TypeScript callers and the plain Node child.
import * as png from './png.cjs';

export type RawImage = { width: number; height: number; channels: number; data: Uint8Array | Uint8ClampedArray };
export const MAX_IMAGE_PIXELS: number = png.MAX_IMAGE_PIXELS;
export const MAX_DECODED_IMAGE_PIXELS: number = png.MAX_DECODED_IMAGE_PIXELS;
export const resizeImage: (image: RawImage, maxPixels?: number) => RawImage = png.resizeImage;
export const encodePng: (image: RawImage) => Buffer = png.encodePng;
