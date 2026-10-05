import { InstanceAssetsService } from '../InstanceAssetsService';
import {
  dehydrateMessageImages,
  downloadUrlAsDataImage,
  hydrateMessageImages,
} from '../vision-message-images';
import { AgentService } from '@/lib/agentbase/adapters/AgentService';
import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { replaceTwilioMediaUrls } from '@/lib/services/twilio/fetchTwilioMedia';
import { sanitizeMessagesForAzureVisionImages } from '@/lib/custom-automation/azure-vision-message-sanitize';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

jest.mock('@/lib/agentbase/adapters/AgentService', () => ({
  AgentService: {
    getAgentFileContent: jest.fn(),
  },
}));

describe('InstanceAssetsService + vision-message-images', () => {
  let originalFetch: typeof global.fetch;
  const originalTwilioToken = process.env.GEAR_TWILIO_AUTH_TOKEN;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalTwilioToken === undefined) delete process.env.GEAR_TWILIO_AUTH_TOKEN;
    else process.env.GEAR_TWILIO_AUTH_TOKEN = originalTwilioToken;
  });

  describe('processAssetContent / MIME detection', () => {
    it('treats file_type image/png as an image (not metadata-only)', async () => {
      const mockAsset = {
        id: '123',
        name: 'Captura de pantalla.png',
        file_type: 'image/png',
        file_path: 'https://example.com/menu.png',
      };

      // @ts-expect-error testing private method
      const result = await InstanceAssetsService.processAssetContent(mockAsset);

      expect(result?.publicUrl).toBe('https://example.com/menu.png');
      expect(result?.error).toBeUndefined();
      expect(result?.metadata).toBeUndefined();
    });

    it('detects image from filename when file_type is wrong', async () => {
      const mockAsset = {
        id: '123',
        name: 'menu.PNG',
        file_type: 'application/octet-stream',
        url: 'https://example.com/menu.PNG',
      };

      // @ts-expect-error testing private method
      const result = await InstanceAssetsService.processAssetContent(mockAsset);

      expect(result?.publicUrl).toBe('https://example.com/menu.PNG');
    });

    it('defers HTTP images to publicUrl only (no base64 across workflow)', async () => {
      const mockAsset = {
        id: '123',
        name: 'test.png',
        file_type: 'png',
        url: 'https://example.com/image.png',
      };

      // @ts-expect-error testing private method
      const result = await InstanceAssetsService.processImageFile(mockAsset);

      expect(result?.publicUrl).toBe('https://example.com/image.png');
      expect(result?.base64Image).toBeUndefined();
      expect(AgentService.getAgentFileContent).not.toHaveBeenCalled();
    });

    it('handles local/storage paths with AgentService', async () => {
      const mockAsset = {
        id: '123',
        name: 'test.png',
        file_type: 'png',
        file_path: 'storage-path-123',
      };

      (AgentService.getAgentFileContent as jest.Mock).mockResolvedValue('fake-base64-content');

      // @ts-expect-error testing private method
      const result = await InstanceAssetsService.processImageFile(mockAsset);

      expect(result?.base64Image).toBe('data:image/png;base64,fake-base64-content');
      expect(result?.publicUrl).toBeUndefined();
    });
  });

  describe('downloadUrlAsDataImage', () => {
    it('downloads HTTP images as data:image base64', async () => {
      const mockBuffer = Buffer.from('fake-image-data');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(mockBuffer),
        headers: new Headers({ 'content-type': 'image/png' }),
      });

      const dataUrl = await downloadUrlAsDataImage('https://example.com/image.png');

      expect(dataUrl).toBe(`data:image/png;base64,${mockBuffer.toString('base64')}`);
    });

    it('throws when download fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(
        downloadUrlAsDataImage('https://example.com/fail.png')
      ).rejects.toThrow('HTTP error 404');
    });

    it('downloads Twilio media with Basic Auth and does not forward it to S3', async () => {
      const twilioUrl =
        'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1';
      const s3Url = 'https://s3.amazonaws.com/bucket/image.jpg';
      const mockBuffer = Buffer.from('twilio-image');
      const token = randomBytes(24).toString('hex');
      process.env.GEAR_TWILIO_AUTH_TOKEN = token;

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 307,
          headers: new Headers({ location: s3Url }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: jest.fn().mockResolvedValue(mockBuffer),
          headers: new Headers({ 'content-type': 'image/jpeg' }),
        });

      const dataUrl = await downloadUrlAsDataImage(twilioUrl);

      expect(dataUrl).toBe(`data:image/jpeg;base64,${mockBuffer.toString('base64')}`);
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        twilioUrl,
        expect.objectContaining({
          redirect: 'manual',
          headers: expect.any(Headers),
        })
      );
      const firstHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers as Headers;
      expect(firstHeaders.get('Authorization')).toBe(
        `Basic ${Buffer.from(`ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${token}`).toString('base64')}`
      );
      expect(global.fetch).toHaveBeenNthCalledWith(2, s3Url);
    });
  });

  describe('hydrateMessageImages / dehydrateMessageImages', () => {
    it('hydrates http image_url to data URL and dehydrates back', async () => {
      const mockBuffer = Buffer.from('fake-image-data');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(mockBuffer),
        headers: new Headers({ 'content-type': 'image/png' }),
      });

      const messages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'See https://example.com/image.png',
            },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png' },
            },
          ],
        },
      ];

      const hydrated = await hydrateMessageImages(messages);
      const url = hydrated[0].content[1].image_url.url;
      expect(url).toMatch(/^data:image\/png;base64,/);

      const dehydrated = dehydrateMessageImages(hydrated);
      expect(dehydrated[0].content[1].image_url.url).toBe('https://example.com/image.png');
    });

    it('drops image_url parts that cannot be hydrated so Azure never fetches them', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers(),
      });

      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'photo' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1',
              },
            },
          ],
        },
      ];

      const hydrated = await hydrateMessageImages(messages);
      expect(hydrated[0].content).toEqual([{ type: 'text', text: 'photo' }]);
    });

    it('never guesses an image source from unrelated prose when provenance is unavailable', () => {
      const messages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'See https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/MM1/Media/ME1 and https://cdn.example.com/photo.jpg',
            },
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,abc' },
            },
          ],
        },
      ];

      const dehydrated = dehydrateMessageImages(messages);
      expect(dehydrated[0].content).toHaveLength(1);
    });

    it('preserves exact image identity after an unrelated URL, failed download and image removal', async () => {
      const urls = ['https://example.invalid/failed.png', 'https://example.invalid/a.png', 'https://example.invalid/b.png'];
      global.fetch = jest.fn().mockImplementation(async url => ({
        ok: url !== urls[0], status: url === urls[0] ? 401 : 200,
        arrayBuffer: async () => Buffer.from('same-image-bytes'),
        headers: new Headers({ 'content-type': 'image/png' }),
      }));
      const messages: any[] = [{ role: 'user', content: [
        { type: 'text', text: `Visit https://example.invalid/unrelated ${urls.join(' ')}` },
        ...urls.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
      ] }];
      const hydrated = await hydrateMessageImages(messages);
      expect(hydrated[0].content).toHaveLength(3);
      expect(JSON.stringify(hydrated)).not.toContain('visionSourceUrl');
      // The executor can remove images for its vision budget. Remaining parts
      // keep identity even when two URLs downloaded identical bytes.
      hydrated[0].content.splice(1, 1);
      const dehydrated = dehydrateMessageImages(hydrated);
      expect(dehydrated[0].content[1]).toEqual({ type: 'image_url', image_url: { url: urls[2], detail: 'high' } });
      expect(JSON.stringify(dehydrated)).not.toContain('data:image');
    });

    it('retains the exact source after MIME normalization and object-spread transformations', async () => {
      const source = 'https://example.invalid/photo.png';
      global.fetch = jest.fn().mockResolvedValue({ ok: true,
        arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
        headers: new Headers({ 'content-type': 'image/jpeg' }),
      });
      const hydrated = await hydrateMessageImages([{ role: 'user', content: [
        { type: 'image_url', image_url: { url: source, detail: 'high' } },
      ] }]);
      expect(sanitizeMessagesForAzureVisionImages(hydrated)).toBe(0);
      expect(hydrated[0].content[0].image_url.url).toMatch(/^data:image\/png;/);
      const transformed = hydrated.map(message => ({ ...message,
        content: message.content.map((part: any) => ({ ...part, image_url: { ...part.image_url } })),
      }));
      expect(dehydrateMessageImages(transformed)[0].content[0]).toEqual({
        type: 'image_url', image_url: { url: source, detail: 'high' },
      });
    });
  });

  it('retains upload/message identity in both image parts and the asset inventory', async () => {
    const query: any = {};
    for (const method of ['select', 'eq', 'order']) query[method] = jest.fn().mockReturnValue(query);
    query.then = (resolve: any) => Promise.resolve({ data: [{ id: 'asset-1', name: 'image', file_type: 'png',
      file_path: 'https://example.invalid/a.png', created_at: '2026-10-01T12:00:00Z', metadata: { message_sid: 'image-message' } }], error: null }).then(resolve);
    (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
    const context = await InstanceAssetsService.getAssetsContext('instance');
    expect(query.order.mock.calls).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]]);
    expect(context.images[0]).toMatchObject({ id: 'asset-1', messageSid: 'image-message', createdAt: '2026-10-01T12:00:00Z' });
    expect(context.text).toContain('WhatsApp message ID: image-message');
  });

  it('maps partial uploads to their original media URLs rather than shifted positions', () => {
    const originals = [{ url: 'https://example.invalid/failed' }, { url: 'https://example.invalid/success' }];
    const uploaded = [{ originalUrl: originals[1].url, url: 'https://example.invalid/uploaded.png' }];
    expect(replaceTwilioMediaUrls(originals.map(item => item.url).join(' '), originals, uploaded))
      .toBe('https://example.invalid/failed https://example.invalid/uploaded.png');
  });
});
