jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    validateCredits: jest.fn(),
    deductCredits: jest.fn(),
    PRICING: { AUDIO_GENERATION_MINUTE: 1 }
  }
}));
jest.mock('@/lib/services/ai/tts-service', () => ({
  synthesizeSpeech: jest.fn(),
  validateSpeechOptions: jest.fn(),
}));
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
import { synthesizeSpeech, validateSpeechOptions } from '@/lib/services/ai/tts-service';
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
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network forbidden in offline tests'));
      (validateSpeechOptions as jest.Mock).mockReset().mockImplementation(options => ({
        provider: 'azure', format: options.format, voice: 'alloy', deployment: 'tts-hd',
      }));
      (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
      (CreditService.deductCredits as jest.Mock).mockResolvedValue(true);
      (synthesizeSpeech as jest.Mock).mockResolvedValue({ audio: Buffer.from('audio'), provider: 'azure', format: 'mp3', mimeType: 'audio/mpeg' });
      (supabaseAdmin.storage.from as jest.Mock).mockReturnValue({
        upload: jest.fn().mockResolvedValue({ data: { path: 'file.mp3' }, error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.invalid/audio.mp3' } })
      });
    });

    afterEach(() => {
      expect(global.fetch).not.toHaveBeenCalled();
      jest.restoreAllMocks();
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
      expect(CreditService.deductCredits).not.toHaveBeenCalled();
      expect(synthesizeSpeech).not.toHaveBeenCalled();
    });

    it('validates speech configuration before checking or deducting credits', async () => {
      (validateSpeechOptions as jest.Mock).mockImplementation(() => {
        throw new Error('Azure speech is not configured');
      });
      expect(await tryPrepareLongReplyAudio(defaultParams)).toBeNull();
      expect(validateSpeechOptions).toHaveBeenCalledWith({ text: defaultParams.text, format: 'mp3' });
      expect(CreditService.validateCredits).not.toHaveBeenCalled();
      expect(CreditService.deductCredits).not.toHaveBeenCalled();
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expect(supabaseAdmin.storage.from).not.toHaveBeenCalled();
    });

    it('uses Azure direct with MP3 for WhatsApp', async () => {
      (supabaseAdmin.storage.from as jest.Mock).mockReturnValue({
        upload: jest.fn().mockResolvedValue({ data: { path: 'file.mp3' }, error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.invalid/audio.mp3' } })
      });

      const result = await tryPrepareLongReplyAudio(defaultParams);
      expect(result).toEqual({ audioUrl: 'https://example.invalid/audio.mp3', mimeType: 'audio/mpeg' });
      expect(synthesizeSpeech).toHaveBeenCalledWith({
        text: 'a'.repeat(500), provider: 'azure', voice: 'alloy', model: 'tts-hd', format: 'mp3',
      });
      expect((validateSpeechOptions as jest.Mock).mock.invocationCallOrder[0])
        .toBeLessThan((CreditService.deductCredits as jest.Mock).mock.invocationCallOrder[0]);
    });

    it('falls back to text when WhatsApp MP3 synthesis fails', async () => {
      (synthesizeSpeech as jest.Mock).mockRejectedValue(new Error('Configured provider down'));

      const result = await tryPrepareLongReplyAudio(defaultParams);
      expect(result).toBeNull();
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    });

    it('uses Azure direct MP3 for other supported channels', async () => {
      const result = await tryPrepareLongReplyAudio({ ...defaultParams, channel: 'telegram' });
      expect(result).toEqual({ audioUrl: 'https://example.invalid/audio.mp3', mimeType: 'audio/mpeg' });
      expect(synthesizeSpeech).toHaveBeenCalledWith({
        text: 'a'.repeat(500), provider: 'azure', voice: 'alloy', model: 'tts-hd', format: 'mp3',
      });
    });

    it('retains text rather than falling back across accounts for other channels', async () => {
      (synthesizeSpeech as jest.Mock).mockRejectedValue(new Error('Configured provider down'));
      const result = await tryPrepareLongReplyAudio({ ...defaultParams, channel: 'telegram' });
      expect(result).toBeNull();
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    });
  });
});
