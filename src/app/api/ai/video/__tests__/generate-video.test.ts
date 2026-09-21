import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGenerateVideos: any = jest.fn();
const mockConvertUrlToBase64: any = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(() => ({
    models: { generateVideos: mockGenerateVideos },
  })),
}));
jest.mock('../utils', () => ({
  convertUrlToBase64: mockConvertUrlToBase64,
  sleep: jest.fn(async () => undefined),
}));
jest.mock('../video-storage', () => ({
  persistGeneratedVideo: jest.fn(),
}));

import { generateVideoWithGemini } from '../generate-video';

describe('generateVideoWithGemini frame controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
    mockConvertUrlToBase64.mockImplementation(async (url: string) => ({
      data: url.includes('start') ? 'first-bytes' : 'last-bytes',
      mimeType: 'image/png',
    }));
    mockGenerateVideos.mockRejectedValue(new Error('stop after request capture'));
  });

  it('sends linked UI states as firstFrame and config.lastFrame', async () => {
    await expect(generateVideoWithGemini({
      prompt: 'Animate between frames',
      siteId: '11111111-1111-4111-8111-111111111111',
      durationSeconds: 4,
      firstFrameUrl: 'https://example.com/start.png',
      lastFrameUrl: 'https://example.com/end.png',
    })).rejects.toThrow('stop after request capture');

    expect(mockGenerateVideos).toHaveBeenCalledWith(expect.objectContaining({
      image: {
        imageBytes: 'first-bytes',
        mimeType: 'image/png',
      },
      config: expect.objectContaining({
        durationSeconds: 8,
        lastFrame: {
          imageBytes: 'last-bytes',
          mimeType: 'image/png',
        },
      }),
    }));
  });
});
