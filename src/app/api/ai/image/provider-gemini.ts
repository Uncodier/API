import { GoogleGenAI } from '@google/genai';
import {
  getImageEnv,
  persistGeneratedImage,
  remoteImageAsBase64,
} from './image-storage';
import type {
  GenerateImageOptions,
  ImageGenerationResult,
  ImageRatio,
} from './image-types';

const RATIO_INSTRUCTIONS: Record<ImageRatio, string> = {
  '1:1': 'Create a square image with equal width and height.',
  '16:9': 'Create a wide landscape image with a 16:9 aspect ratio.',
  '9:16': 'Create a vertical portrait image with a 9:16 aspect ratio.',
  '4:3': 'Create a landscape image with a 4:3 aspect ratio.',
  '3:4': 'Create a portrait image with a 3:4 aspect ratio.',
  '3:2': 'Create a landscape image with a 3:2 aspect ratio.',
  '2:3': 'Create a portrait image with a 2:3 aspect ratio.',
};

export async function generateWithGemini(
  options: GenerateImageOptions,
): Promise<ImageGenerationResult> {
  const apiKey = getImageEnv('GEMINI_API_KEY')
    || getImageEnv('GOOGLE_CLOUD_API_KEY');
  const model =
    getImageEnv('GOOGLE_CLOUD_IMAGES_MODEL') || 'gemini-2.5-flash-image';
  if (!apiKey) throw new Error('Gemini image generation is not configured');

  const parts: any[] = [{
    text: options.ratio
      ? `${options.prompt}. ${RATIO_INSTRUCTIONS[options.ratio]}`
      : options.prompt,
  }];
  for (const referenceUrl of options.referenceImages || []) {
    const image = await remoteImageAsBase64(referenceUrl);
    if (image) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data,
        },
      });
    }
  }

  const ai = new GoogleGenAI({ apiKey });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stream = await Promise.race([
    ai.models.generateContentStream({
      model,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: options.ratio
          ? { aspectRatio: options.ratio }
          : undefined,
      },
      contents: [{ role: 'user', parts }],
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Gemini image generation timed out')),
        30_000,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });

  const images: ImageGenerationResult['images'] = [];
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts || []) {
      const inlineData = part.inlineData;
      if (!inlineData?.data) continue;
      images.push(await persistGeneratedImage({
        base64Data: inlineData.data,
        mimeType: inlineData.mimeType || 'image/png',
        siteId: options.siteId,
        provider: 'gemini',
        prompt: options.prompt,
        model,
        instanceId: options.instanceId,
      }));
      if (images.length >= options.count) break;
    }
    if (images.length >= options.count) break;
  }
  if (images.length === 0) throw new Error('Gemini returned no usable images');
  return { provider: 'gemini', images };
}
