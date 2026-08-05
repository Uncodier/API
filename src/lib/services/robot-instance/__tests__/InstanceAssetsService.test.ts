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

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
  });
});
