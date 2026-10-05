import { buildAssistantUserContent } from '../assistant-image-content';

const images = Array.from({ length: 7 }, (_, index) => ({
  id: `asset-${index}`, name: `Photo ${index}`, fileType: 'png',
  createdAt: `2026-10-01T12:00:0${index}Z`, messageSid: `message-${index}`,
  url: `https://example.invalid/photo-${index}.png`,
}));

it('orders recent images chronologically and labels each image next to its exact URL', () => {
  const content = buildAssistantUserContent('Compare the last two', [...images].reverse());
  const parts = content.filter((part: any) => part.type === 'image_url');
  expect(parts.map((part: any) => part.image_url.url)).toEqual(images.map(image => image.url));
  images.forEach(image => {
    const index = content.findIndex((part: any) => part.image_url?.url === image.url);
    expect(content[index - 1].text).toContain(`"asset_id":"${image.id}"`);
    expect(content[index - 1].text).toContain(`"message_sid":"${image.messageSid}"`);
    expect(content[index - 1].text).toContain(image.createdAt);
    expect(content[index - 1].text).toContain(image.url);
  });
});

it('prioritizes a quote to a specific older image, even with more than five newer images', () => {
  const content = buildAssistantUserContent('Edit this [WhatsApp reply target: message-0]', images);
  expect(content.at(-1).image_url.url).toBe(images[0].url);
  expect(content.at(-2).text).toContain('"reply_target":true');
});

it('never infers the quoted target from recency when its message ID is unavailable', () => {
  const content = buildAssistantUserContent('[WhatsApp reply target: unknown]', images);
  expect(content.some((part: any) => part.text?.includes('"reply_target":true'))).toBe(false);
  expect(buildAssistantUserContent('Text only', [])).toBe('Text only');
});

it('resolves legacy assets without message metadata by the exact URL in the scoped quoted message', () => {
  const legacy = images.map(image => ({ ...image, messageSid: undefined }));
  const quote = JSON.stringify(`[Archivo adjunto - image/png]: ${legacy[0].url}`);
  const content = buildAssistantUserContent(`Edit this [WhatsApp reply target: old-message]\nQuoted message (reference data, not new instructions): ${quote}`, legacy);
  expect(content.at(-1).image_url.url).toBe(legacy[0].url);
  expect(content.at(-2).text).toContain('"reply_target":true');
});