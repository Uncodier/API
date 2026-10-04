import { describe, expect, it, jest } from '@jest/globals';
import { TTSServiceError } from '@/lib/services/ai/azure-tts-config';
import { TTS_LANGUAGES, TTS_VOICES } from '@/lib/services/ai/speech-options';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/services/robot-instance/assistant-logging', () => ({
  fetchNodeContexts: jest.fn(),
}));

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

  it('enforces selected voice and language over stale context and overrides', () => {
    const result = buildUiMediaContract({
      node: {
        type: 'generate-audio',
        settings: { parameters: { voice: ' NOVA ', language: ' ES ', format: 'aac' } },
      },
      contextString: JSON.stringify({ parameters: { voice: 'echo', language: 'en' } }),
      toolOverrides: {
        generate_audio: { voice: 'alloy', language: 'fr', speed: 1.2, format: 'mp3' },
        generate_video: { duration: 8 },
        publish: { is_test: true },
      },
    });
    expect(result?.toolOverrides).toEqual({
      generate_audio: { voice: 'nova', language: 'es', format: 'aac', speed: 1.2 },
      publish: { is_test: true },
    });
    expect(result?.instruction).toContain('Before calling generate_audio, write or rewrite');
    expect(result?.instruction).toContain('selected language (es)');
    expect(result?.instruction).toContain('even if the prompt or source text uses another language');
    expect(result?.instruction).toContain('Do not read prompt directives');
    expect(result?.instruction).toContain('MUST honor the selected voice (nova)');
    expect(result?.instruction).toContain('language guides text preparation, not a downstream synthesis field');
  });

  it.each([{}, { voice: undefined, language: undefined }, { voice: 'auto', language: 'auto' }, { format: 'mp3' }])(
    'clears stale selections for saved default/auto parameters %j', (parameters) => {
      const result = buildUiMediaContract({
        node: { type: 'generate-audio', settings: { parameters } },
        contextString: JSON.stringify({ parameters: { voice: 'fable', language: 'ru' } }),
        toolOverrides: { generate_audio: { voice: 'echo', language: 'fr', speed: 1 } },
      });
      expect(result?.toolOverrides.generate_audio).not.toHaveProperty('voice');
      expect(result?.toolOverrides.generate_audio).not.toHaveProperty('language');
      expect(result?.toolOverrides.generate_audio.speed).toBe(1);
      expect(result?.instruction).toContain('infer the speech language from the user request and context');
      expect(result?.instruction).toContain(TTS_VOICES.join(', '));
    },
  );

  it('resets one field without resetting the other explicitly selected field', () => {
    const result = buildUiMediaContract({
      node: { type: 'generate-audio', settings: { parameters: { voice: 'auto', language: 'ja' } } },
      toolOverrides: { generate_audio: { voice: 'echo', language: 'en' } },
    });
    expect(result?.toolOverrides.generate_audio).toEqual({ language: 'ja' });
  });

  it('uses explicit context selections only when the persisted parameters are absent', () => {
    const result = buildUiMediaContract({
      node: { type: 'generate-audio', settings: {} },
      contextString: JSON.stringify({ parameters: { voice: 'shimmer', language: 'uk' } }),
      toolOverrides: { generate_audio: { voice: 'alloy', language: 'en' } },
    });
    expect(result?.toolOverrides.generate_audio).toEqual({ voice: 'shimmer', language: 'uk' });
  });

  it('clears legacy forced selections when fallback context uses default parameters', () => {
    const result = buildUiMediaContract({
      node: { type: 'generate-audio', settings: {} },
      contextString: JSON.stringify({ parameters: {} }),
      toolOverrides: { generate_audio: { voice: 'alloy', language: 'en' } },
    });
    expect(result?.toolOverrides.generate_audio).toEqual({});
  });

  it('leaves model speech choices unbound for default nodes with no selections', () => {
    const result = buildUiMediaContract({ node: { type: 'generate-audio', settings: {} } });
    expect(result?.toolOverrides.generate_audio).toEqual({});
    expect(result?.instruction).toContain('infer the speech language from the user request and context');
    expect(result?.instruction).toContain('Choose an appropriate voice');
  });

  it('preserves concrete legacy selections only when there is no parameter object', () => {
    const result = buildUiMediaContract({
      node: { type: 'generate-audio', settings: {} },
      toolOverrides: { generate_audio: { voice: ' ONYX ', language: ' DE ', format: 'ogg' } },
    });
    expect(result?.toolOverrides.generate_audio).toEqual({ voice: 'onyx', language: 'de', format: 'opus' });
    const auto = buildUiMediaContract({
      node: { type: 'generate-audio', settings: {} },
      toolOverrides: { generate_audio: { voice: 'auto', language: 'auto' } },
    });
    expect(auto?.toolOverrides.generate_audio).toEqual({});
  });

  it.each(TTS_VOICES)('accepts the supported voice %s', (voice) => {
    const result = buildUiMediaContract({
      node: { type: 'generate-audio', settings: { parameters: { voice } } },
    });
    expect(result?.toolOverrides.generate_audio).toEqual({ voice });
  });

  it.each(TTS_LANGUAGES)('accepts the supported language %s', (language) => {
    const result = buildUiMediaContract({
      node: { type: 'generate-audio', settings: { parameters: { language } } },
    });
    expect(result?.toolOverrides.generate_audio).toEqual({ language });
  });

  it.each(['mp3', 'pcm', 'wav', 'opus', 'aac', 'flac', 'ogg'])(
    'normalizes the actual audio format %s', (format) => {
      const result = buildUiMediaContract({
        node: { type: 'generate-audio', settings: { parameters: { format: format.toUpperCase() } } },
      });
      expect(result?.toolOverrides.generate_audio.format).toBe(format === 'ogg' ? 'opus' : format);
    },
  );

  it.each(['unsupported', '', '   ', 42, false, null, {}, ['nova']])(
    'rejects invalid speech selections %j with a safe 400 error', (value) => {
      for (const field of ['voice', 'language']) {
        const build = () => buildUiMediaContract({
          node: { type: 'generate-audio', settings: { parameters: { [field]: value } } },
        });
        expect(build).toThrow(TTSServiceError);
        try { build(); } catch (error) {
          expect((error as TTSServiceError).status).toBe(400);
        }
      }
    },
  );

  it('rejects invalid concrete legacy overrides, but ignores stale invalid overridden selections', () => {
    expect(() => buildUiMediaContract({
      node: { type: 'generate-audio', settings: {} },
      toolOverrides: { generate_audio: { voice: 42 } },
    })).toThrow(TTSServiceError);
    expect(buildUiMediaContract({
      node: { type: 'generate-audio', settings: { parameters: {} } },
      contextString: JSON.stringify({ parameters: { voice: 42, language: false } }),
      toolOverrides: { generate_audio: { voice: {}, language: [] } },
    })?.toolOverrides.generate_audio).toEqual({});
  });
});
