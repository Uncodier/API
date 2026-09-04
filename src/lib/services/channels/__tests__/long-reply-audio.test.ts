jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    validateCredits: jest.fn(),
    deductCredits: jest.fn(),
    PRICING: { AUDIO_GENERATION_MINUTE: 1 }
  }
}));
jest.mock('@/lib/services/ai/tts-service');
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn().mockReturnThis(),
      upload: jest.fn(),
      getPublicUrl: jest.fn()
    }
  }
}));

import { stripMarkdownForSpeech, tryPrepareLongReplyAudio } from '../long-reply-audio';
import { CreditService } from '@/lib/services/billing/CreditService';
import { synthesizeWithGemini, synthesizeWithVercel } from '@/lib/services/ai/tts-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

describe('long-reply-audio', () => {
  describe('stripMarkdownForSpeech', () => {
    it('removes bold, italics, links, headers, lists', () => {
      const input = `# Hello\nThis is **bold** and _italic_ and [link](http://url.com).\n- item 1\n- item 2\n\n\`\`\`json\n{}\n\`\`\``;
      const expected = `Hello\nThis is bold and italic and link.\nitem 1\nitem 2`;
      expect(stripMarkdownForSpeech(input)).toBe(expected);
    });
  });

  describe('tryPrepareLongReplyAudio', () => {
    const defaultParams = {
      siteId: 'site-1',
      channel: 'whatsapp',
      text: 'a'.repeat(500),
    };

    beforeEach(() => {
      jest.clearAllMocks();
      (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
      (CreditService.deductCredits as jest.Mock).mockResolvedValue(true);
      (synthesizeWithGemini as jest.Mock).mockResolvedValue(Buffer.from('audio'));
      (synthesizeWithVercel as jest.Mock).mockResolvedValue(Buffer.from('audio-mp3'));
      (supabaseAdmin.storage.from as jest.Mock).mockReturnValue({
        upload: jest.fn().mockResolvedValue({ data: { path: 'file.wav' }, error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://audio.wav' } })
      });
    });

    it('returns null if channel is not supported', async () => {
      const result = await tryPrepareLongReplyAudio({ ...defaultParams, channel: 'email' });
      expect(result).toBeNull();
    });

    it('returns null if text is too short', async () => {
      const result = await tryPrepareLongReplyAudio({ ...defaultParams, text: 'Short' });
      expect(result).toBeNull();
    });

    it('returns null if text is > 4000', async () => {
      const result = await tryPrepareLongReplyAudio({ ...defaultParams, text: 'a'.repeat(4001) });
      expect(result).toBeNull();
    });

    it('returns null if existing media is passed', async () => {
      const result = await tryPrepareLongReplyAudio({ ...defaultParams, existingMediaUrls: ['url'] });
      expect(result).toBeNull();
    });

    it('returns null if no credits', async () => {
      (CreditService.validateCredits as jest.Mock).mockResolvedValue(false);
      const result = await tryPrepareLongReplyAudio(defaultParams);
      expect(result).toBeNull();
    });

    it('returns publicUrl if Gemini succeeds', async () => {
      const result = await tryPrepareLongReplyAudio(defaultParams);
      expect(result).toEqual({ audioUrl: 'https://audio.wav', mimeType: 'audio/wav' });
      expect(synthesizeWithGemini).toHaveBeenCalledWith('a'.repeat(500), 'Puck', 'wav', 'gemini-3.1-flash-tts-preview');
      expect(synthesizeWithVercel).not.toHaveBeenCalled();
    });

    it('falls back to Vercel when Gemini fails', async () => {
      (synthesizeWithGemini as jest.Mock).mockRejectedValue(new Error('Gemini down'));
      (supabaseAdmin.storage.from as jest.Mock).mockReturnValue({
        upload: jest.fn().mockResolvedValue({ data: { path: 'file.mp3' }, error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://audio.mp3' } })
      });

      const result = await tryPrepareLongReplyAudio(defaultParams);
      expect(result).toEqual({ audioUrl: 'https://audio.mp3', mimeType: 'audio/mpeg' });
      expect(synthesizeWithVercel).toHaveBeenCalled();
    });

    it('falls back to text when Gemini and Vercel fail', async () => {
      (synthesizeWithGemini as jest.Mock).mockRejectedValue(new Error('Gemini down'));
      (synthesizeWithVercel as jest.Mock).mockRejectedValue(new Error('Vercel down'));

      const result = await tryPrepareLongReplyAudio(defaultParams);
      expect(result).toBeNull();
    });
  });
});
