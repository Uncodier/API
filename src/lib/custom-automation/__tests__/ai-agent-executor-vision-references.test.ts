import { randomBytes } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { buildAssistantUserContent } from '@/lib/services/robot-instance/assistant-image-content';
import { dehydrateMessageImages, hydrateMessageImages } from '@/lib/services/robot-instance/vision-message-images';

const originalEnv = process.env;
beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (typeof input !== 'string' || new URL(input).hostname !== 'example.invalid') throw new Error('Unexpected live request');
    return new Response(Buffer.from('synthetic-image-bytes'), { headers: { 'content-type': 'image/png' } });
  });
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

const images = Array.from({ length: 7 }, (_, index) => ({
  id: `asset-${index}`, messageSid: `image-message-${index}`, fileType: 'png',
  createdAt: `2026-10-01T12:00:0${index}Z`, url: `https://example.invalid/image-${index}.png`,
}));

it.each([
  { quoted: false, stream: false }, { quoted: true, stream: false },
  { quoted: false, stream: true }, { quoted: true, stream: true },
])('keeps exact image references through OpenRouter and the next turn (quoted=$quoted, stream=$stream)', async ({ quoted, stream }) => {
  const executor = new AIAgentExecutor();
  const requests: any[] = [];
  const create = jest.fn().mockImplementation(async request => {
    requests.push(JSON.parse(JSON.stringify(request)));
    if (request.stream) return (async function* () {
      yield { choices: [{ delta: { content: 'Image identified' }, finish_reason: 'stop' }] };
    })();
    return { choices: [{ message: { role: 'assistant', content: 'Image identified' }, finish_reason: 'stop' }] };
  });
  (executor as any).client.chat.completions.create = create;
  const prompt = quoted ? 'Edit this [WhatsApp reply target: image-message-0]' : 'Compare the last two images';
  const messages = [{ role: 'user', content: buildAssistantUserContent(prompt, [...images].reverse()) }];
  const first = await executor.act({ messages: await hydrateMessageImages(messages), tools: [], maxIterations: 1,
    stream, onStreamStart: async () => 'stream-log', onStreamChunk: async () => {} });
  const expected = quoted ? [3, 4, 5, 6, 0] : [2, 3, 4, 5, 6];
  const checkpoint = dehydrateMessageImages(first.messages!);
  const saved = checkpoint.find(message => message.role === 'user').content.filter((part: any) => part.type === 'image_url');
  expect(saved.map((part: any) => part.image_url.url)).toEqual(expected.map(index => images[index].url));
  expect(JSON.stringify(checkpoint)).not.toContain('data:image');
  expect(requests[0].messages.find((message: any) => message.role === 'user').content.filter((part: any) => part.type === 'image_url'))
    .toHaveLength(5);
  expect(JSON.stringify(requests[0])).not.toContain('visionSourceUrl');

  const second = await executor.act({ messages: await hydrateMessageImages(checkpoint), tools: [], maxIterations: 1 });
  const final = dehydrateMessageImages(second.messages!);
  expect(final.find(message => message.role === 'user').content.filter((part: any) => part.type === 'image_url')
    .map((part: any) => part.image_url.url)).toEqual(expected.map(index => images[index].url));
  expect(create).toHaveBeenCalledTimes(2);
});