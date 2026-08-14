import { InstanceAssetsService } from '../InstanceAssetsService';
import {
  dehydrateMessageImages,
  downloadUrlAsDataImage,
  hydrateMessageImages,
} from '../vision-message-images';
import { AgentService } from '@/lib/agentbase/adapters/AgentService';

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
      process.env.GEAR_TWILIO_AUTH_TOKEN = 'secret-token';

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
        `Basic ${Buffer.from('ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:secret-token').toString('base64')}`
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

    it('dehydrate prefers public URLs over Twilio media URLs', () => {
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
      expect(dehydrated[0].content[1].image_url.url).toBe('https://cdn.example.com/photo.jpg');
    });
  });
});
