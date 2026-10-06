import { randomBytes } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { buildAssistantUserContent } from '@/lib/services/robot-instance/assistant-image-content';
import { dehydrateMessageImages, getVisionImageSourceUrl, hydrateMessageImages } from '@/lib/services/robot-instance/vision-message-images';

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

it('retains the exact current legacy attachment through the five-image limit and checkpoint', async () => {
  const executor = new AIAgentExecutor();
  const create = jest.fn().mockResolvedValue({ choices: [{
    message: { role: 'assistant', content: 'Current image identified' }, finish_reason: 'stop',
  }] });
  (executor as any).client.chat.completions.create = create;
  const legacy = images.map(image => ({ ...image, messageSid: undefined }));
  const content = buildAssistantUserContent(`[Archivo adjunto - image/png]: ${legacy[0].url}`, legacy);
  const result = await executor.act({ messages: await hydrateMessageImages([{ role: 'user', content }]),
    tools: [], maxIterations: 1 });
  const checkpoint = dehydrateMessageImages(result.messages!);
  const retained = checkpoint.find(message => message.role === 'user').content;
  expect(retained.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url))
    .toEqual([3, 4, 5, 6, 0].map(index => legacy[index].url));
  expect(retained.at(-2).text).toContain('"current_attachment":true');
  expect(retained.find((part: any) => part.text?.includes('"latest_uploaded":true')).text).toContain(legacy[6].url);
});

it('sends an explicit failed-current-image warning even when older images are still visible', async () => {
  const current = images[6];
  (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) => url === current.url
    ? new Response('', { status: 401 })
    : new Response(Buffer.from('synthetic-image-bytes'), { headers: { 'content-type': 'image/png' } }));
  const executor = new AIAgentExecutor();
  const requests: any[] = [];
  (executor as any).client.chat.completions.create = jest.fn().mockImplementation(async request => {
    requests.push(JSON.parse(JSON.stringify(request)));
    return { choices: [{ message: { role: 'assistant', content: 'Please resend the image' }, finish_reason: 'stop' }] };
  });
  const content = buildAssistantUserContent(`[Archivo adjunto - image/png]: ${current.url}`, [images[0], current]);
  const result = await executor.act({ messages: await hydrateMessageImages([{ role: 'user', content }]),
    tools: [], maxIterations: 1 });
  const sent = requests[0].messages.find((message: any) => message.role === 'user').content;
  expect(sent.filter((part: any) => part.type === 'image_url')).toHaveLength(1);
  expect(sent.at(-1).text).toContain(`Image unavailable: ${JSON.stringify(current.url)}`);
  expect(sent.at(-1).text).toContain('Do not substitute another image');
  expect(JSON.stringify(dehydrateMessageImages(result.messages!))).toContain('Image unavailable');
});

const imageParts = (messages: any[]) => messages.flatMap(message =>
  Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url') : []);
const textParts = (content: any[]) => content.filter(part => part.type === 'text').map(part => part.text);
const screenshot = (index: number) => `data:image/png;base64,${Buffer.from(`synthetic-screenshot-${index}`.repeat(8)).toString('base64')}`;
const linkedMessage = (urls: string[]) => ({ role: 'user', content: [
  { type: 'text', text: '[Reference Context from linked node response]:\n' +
    'Node reference: {"node_id":"linked-node","reference_type":"response","created_at":"2026-10-01T00:00:00Z"}\n' +
    'PRIORITY: Use these exact assets.\n\n' +
    'CRITICAL - Image URLs for reference (YOU MUST PASS THESE URLS EXACTLY AS THEY ARE TO THE APPROPRIATE TOOL PARAMETER, e.g. reference_images):\n' + urls.join('\n') },
  ...urls.map(url => ({ type: 'image_url', image_url: { url } })),
] });

function offlineExecutor(respond?: (index: number) => any) {
  const executor = new AIAgentExecutor();
  const requests: any[] = [];
  const sources: string[][] = [];
  const create = jest.fn().mockImplementation(async request => {
    // Capture before serialization to prove source identity survives equal bytes.
    sources.push(imageParts(request.messages).map(getVisionImageSourceUrl) as string[]);
    requests.push(JSON.parse(JSON.stringify(request)));
    const message = respond?.(requests.length - 1) || { role: 'assistant', content: 'Done' };
    const finish_reason = message.tool_calls?.length ? 'tool_calls' : 'stop';
    if (request.stream) return (async function* () {
      yield { choices: [{ delta: { ...message,
        tool_calls: message.tool_calls?.map((call: any, index: number) => ({ ...call, index })) }, finish_reason }] };
    })();
    return { choices: [{ message, finish_reason }] };
  });
  (executor as any).client.chat.completions.create = create;
  return { executor, requests, sources, create };
}

it.each([false, true])('protects linked, reply and current identities from screenshots in later iterations (stream=%s)', async stream => {
  const linked = linkedMessage(['https://example.invalid/linked.png']);
  const current = images[0];
  const reply = images[1];
  const prompt = `[Archivo adjunto - image/png]: ${current.url}\nEdit [WhatsApp reply target: ${reply.messageSid}]`;
  const content = buildAssistantUserContent(prompt, images.slice(0, 5));
  const originalLabels = textParts(content);
  const h = offlineExecutor(index => index < 2 ? { role: 'assistant', content: '',
    tool_calls: Array.from({ length: 3 }, (_, offset) => ({ id: `shot-${index}-${offset}`, type: 'function',
      function: { name: 'capture', arguments: JSON.stringify({ index: index * 3 + offset }) } })),
  } : undefined);
  const execute = jest.fn(async ({ index }) => screenshot(index));
  const result = await h.executor.act({ messages: await hydrateMessageImages([linked, { role: 'user', content }]),
    tools: [{ name: 'capture', execute }], maxIterations: 3, stream,
    onStreamStart: async () => 'stream-log', onStreamChunk: async () => {} });

  expect(execute).toHaveBeenCalledTimes(6);
  expect(h.requests).toHaveLength(3);
  for (const [index, request] of h.requests.entries()) {
    expect(imageParts(request.messages)).toHaveLength(5);
    expect(h.sources[index]).toEqual(expect.arrayContaining([current.url, reply.url, 'https://example.invalid/linked.png']));
    expect(textParts(request.messages[1].content).filter(text => originalLabels.includes(text))).toEqual(originalLabels);
    expect(request.messages[0].content[0]).toEqual(linked.content[0]);
    for (const part of imageParts(request.messages)) {
      expect(Object.keys(part).sort()).toEqual(['image_url', 'type']);
      expect(Object.keys(part.image_url).every(key => ['url', 'detail'].includes(key))).toBe(true);
    }
    expect(JSON.stringify(request)).not.toContain('visionSourceUrl');
  }
  expect(h.sources[1].filter(source => source.startsWith('data:'))).toEqual([screenshot(1), screenshot(2)]);
  expect(h.sources[2].filter(source => source.startsWith('data:'))).toEqual([screenshot(4), screenshot(5)]);
  expect(JSON.stringify(h.requests[2])).toContain('NOT visible');
  expect(JSON.stringify(h.requests[2])).toContain('5-image limit');

  const checkpoint = dehydrateMessageImages(result.messages);
  expect(imageParts(checkpoint).map(getVisionImageSourceUrl)).toEqual(['https://example.invalid/linked.png', current.url, reply.url]);
  expect(JSON.stringify(checkpoint)).not.toContain('data:image');
  await h.executor.act({ messages: await hydrateMessageImages(checkpoint), tools: [], maxIterations: 1 });
  expect(h.sources[3]).toEqual(['https://example.invalid/linked.png', current.url, reply.url]);
});

it.each(['current', 'reply', 'linked'])('warns for every omitted requested image when more than five %s images are requested', async kind => {
  const assets = kind === 'reply' ? images.map(image => ({ ...image, messageSid: 'multi-image-reply' })) : images;
  const prompt = kind === 'reply' ? 'Compare all [WhatsApp reply target: multi-image-reply]'
    : images.map(image => `[Archivo adjunto - image/png]: ${image.url}`).join('\n');
  const message = kind === 'linked' ? linkedMessage(images.map(image => image.url))
    : { role: 'user', content: buildAssistantUserContent(prompt, assets) };
  const labels = textParts(message.content);
  const h = offlineExecutor();
  const result = await h.executor.act({ messages: await hydrateMessageImages([message]), tools: [], maxIterations: 1 });
  expect(h.sources[0]).toEqual(images.slice(2).map(image => image.url));
  const sent = h.requests[0].messages[0].content;
  expect(textParts(sent).filter(text => labels.includes(text))).toEqual(labels);
  for (const omitted of images.slice(0, 2)) {
    const warning = sent.find((part: any) => part.text?.startsWith('Image omitted') && part.text.includes(omitted.url));
    expect(warning.text).toContain('5-image limit');
    expect(warning.text).toContain('NOT visible');
    expect(warning.text).toContain('ask for fewer images');
    expect(warning.text).toContain('do not substitute another image');
  }
  const checkpoint = dehydrateMessageImages(result.messages);
  await h.executor.act({ messages: await hydrateMessageImages(checkpoint), tools: [], maxIterations: 1 });
  expect(h.requests[1].messages[0].content).toEqual(sent);
});

it('deduplicates only exact sources, not equal downloaded bytes or URL variants, preserving every identity label', async () => {
  const variants = ['https://example.invalid/picture.png?v=1', 'https://example.invalid/picture.png?v=2'];
  const assets = [images[0], { ...images[0], id: 'same-source-other-identity' }, images[1], images[2],
    ...variants.map((url, index) => ({ ...images[index + 3], url }))];
  const content = buildAssistantUserContent('Compare the uploaded images', assets);
  const labels = textParts(content);
  const h = offlineExecutor();
  await h.executor.act({ messages: await hydrateMessageImages([{ role: 'user', content }]), tools: [], maxIterations: 1 });
  expect(h.sources[0]).toEqual([images[0].url, images[1].url, images[2].url, ...variants]);
  expect(new Set(imageParts(h.requests[0].messages).map(part => part.image_url.url)).size).toBe(1);
  const sent = h.requests[0].messages[0].content;
  expect(textParts(sent).filter(text => labels.includes(text))).toEqual(labels);
  expect(textParts(sent).filter(text => text.startsWith('Duplicate image occurrence'))).toHaveLength(1);
  expect(textParts(sent).some(text => text.startsWith('Image omitted from vision'))).toBe(false);
});

it('does not pin unrelated images from a mismatched identity URL or malformed reference label', async () => {
  const h = offlineExecutor();
  const messages = [{ role: 'user', content: [
    { type: 'text', text: `Image reference: {"reply_target":true}\nSource URL: ${images[1].url}` },
    { type: 'image_url', image_url: { url: images[0].url } },
    { type: 'text', text: `Image reference: {bad JSON}\nSource URL: ${images[1].url}` },
    { type: 'image_url', image_url: { url: images[1].url } },
  ] }, { role: 'user', content: Array.from({ length: 5 }, (_, index) => ({ type: 'image_url', image_url: { url: screenshot(index) } })) }];
  await h.executor.act({ messages: await hydrateMessageImages(messages), tools: [], maxIterations: 1 });
  expect(h.sources[0]).toEqual(Array.from({ length: 5 }, (_, index) => screenshot(index)));
  expect(textParts(h.requests[0].messages[0].content).filter(text => text.startsWith('Image omitted'))).toHaveLength(2);
});

it('ranks linked and reply targets before current images under mixed overflow, without changing display order', async () => {
  const linked = linkedMessage([images[0].url, images[1].url, images[2].url]);
  const prompt = `[WhatsApp reply target: ${images[3].messageSid}]\n` +
    images.slice(4).map(image => `[Archivo adjunto - image/png]: ${image.url}`).join('\n');
  const content = buildAssistantUserContent(prompt, images.slice(3));
  const h = offlineExecutor();
  await h.executor.act({ messages: await hydrateMessageImages([linked, { role: 'user', content }]), tools: [], maxIterations: 1 });
  // Display order is unchanged: the current attachment precedes the reply target.
  expect(h.sources[0]).toEqual([0, 1, 2, 6, 3].map(index => images[index].url));
  const warnings = textParts(h.requests[0].messages[1].content).filter(text => text.startsWith('Image omitted'));
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain(images[4].url);
  expect(warnings[1]).toContain(images[5].url);
});

it('keeps the explicit target occurrence when the same source reappears later without its identity label', async () => {
  const content = buildAssistantUserContent(`[Archivo adjunto - image/png]: ${images[0].url}`, [images[0]]);
  const h = offlineExecutor();
  const result = await h.executor.act({ messages: await hydrateMessageImages([
    { role: 'user', content },
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: images[0].url } },
      ...Array.from({ length: 5 }, (_, index) => ({ type: 'image_url', image_url: { url: screenshot(index) } })),
    ] },
  ]), tools: [], maxIterations: 1 });
  expect(imageParts([h.requests[0].messages[0]])).toHaveLength(1);
  expect(h.requests[0].messages[1].content[0].text).toContain('Duplicate image occurrence omitted');
  expect(h.sources[0]).toEqual([images[0].url, screenshot(1), screenshot(2), screenshot(3), screenshot(4)]);
  const checkpoint = dehydrateMessageImages(result.messages);
  await h.executor.act({ messages: await hydrateMessageImages(checkpoint), tools: [], maxIterations: 1 });
  expect(h.sources[1]).toEqual([images[0].url]);
});