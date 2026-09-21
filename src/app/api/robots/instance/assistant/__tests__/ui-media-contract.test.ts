import { describe, expect, it } from '@jest/globals';
import { buildUiMediaContract } from '../ui-media-contract';

const imageNode = (id: string, url: string) => ({
  id,
  result: {
    outputs: [{
      type: 'image',
      data: { url },
    }],
  },
});

describe('buildUiMediaContract', () => {
  it('makes the persisted node type authoritative over ambiguous prompt text', () => {
    const result = buildUiMediaContract({
      node: {
        type: 'generate-image',
        settings: {
          media_type: 'image',
          parameters: { aspectRatio: '9:16' },
        },
      },
      contextString: JSON.stringify({ mediaType: 'video' }),
    });

    expect(result).toMatchObject({
      outputType: 'image',
      requiredTool: 'generate_image',
      toolOverrides: {
        generate_image: {
          aspect_ratio: '9:16',
        },
      },
    });
  });

  it('maps Inicio and fin links to authoritative Veo frames', () => {
    const result = buildUiMediaContract({
      node: {
        type: 'generate-video',
        settings: {
          parameters: {
            duration: 4,
            aspectRatio: '9:16',
          },
        },
      },
      contextEntries: [
        {
          context_node_id: 'start',
          type: 'Inicio',
          node: imageNode('start', 'https://example.com/start.png'),
        },
        {
          context_node_id: 'end',
          type: 'fin',
          node: imageNode('end', 'https://example.com/end.png'),
        },
      ],
    });

    expect(result).toMatchObject({
      outputType: 'video',
      requiredTool: 'generate_video',
      toolOverrides: {
        generate_video: {
          aspect_ratio: '9:16',
          duration: 8,
          first_frame_url: 'https://example.com/start.png',
          last_frame_url: 'https://example.com/end.png',
        },
      },
    });
  });

  it('removes all media generators from text-only UI nodes', () => {
    const result = buildUiMediaContract({
      node: {
        type: 'prompt',
        settings: {},
      },
      toolOverrides: {
        generate_video: { duration: 8 },
      },
    });

    expect(result).toMatchObject({
      outputType: 'text',
      requiredTool: null,
      toolOverrides: {},
    });
  });

  it('keeps explicit non-media overrides while enforcing UI media parameters', () => {
    const result = buildUiMediaContract({
      node: {
        type: 'generate-video',
        settings: { parameters: { duration: 6 } },
      },
      toolOverrides: {
        publish: { is_test: true },
        generate_video: { quality: 'pro', duration: 4 },
      },
    });

    expect(result?.toolOverrides).toEqual({
      publish: { is_test: true },
      generate_video: { quality: 'pro', duration: 8, aspect_ratio: '16:9' },
    });
  });

  it('keeps persisted parameters authoritative over stale request context', () => {
    const result = buildUiMediaContract({
      node: {
        type: 'generate-image',
        settings: {
          parameters: { aspectRatio: '9:16', quality: 85 },
        },
      },
      contextString: JSON.stringify({
        parameters: { aspectRatio: '16:9', quality: 25 },
      }),
    });

    expect(result?.toolOverrides.generate_image).toEqual({
      aspect_ratio: '9:16',
      quality: 'hd',
    });
  });

  it('maps supported video resolution and audio format controls', () => {
    const video = buildUiMediaContract({
      node: {
        type: 'generate-video',
        settings: {
          parameters: { resolution: '1080p', duration: 4, aspectRatio: '9:16' },
        },
      },
    });
    expect(video?.toolOverrides.generate_video).toEqual({
      quality: 'pro',
      duration: 8,
      aspect_ratio: '16:9',
    });

    const audio = buildUiMediaContract({
      node: {
        type: 'generate-audio',
        settings: { parameters: { format: 'WAV' } },
      },
    });
    expect(audio?.toolOverrides.generate_audio).toEqual({ format: 'wav' });
  });
});
