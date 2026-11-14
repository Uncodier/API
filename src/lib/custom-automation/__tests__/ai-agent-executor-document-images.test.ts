jest.mock('@/app/api/agents/tools/read_document/core', () => ({ readDocumentBuffer: jest.fn() }));
jest.mock('@/app/api/agents/tools/read_document/source', () => ({ downloadDocument: jest.fn() }));

import { randomBytes } from 'node:crypto';
import { AIAgentExecutor } from '../ai-agent-executor';
import { readDocumentTool } from '@/app/api/agents/tools/read_document/assistantProtocol';
import { readDocumentBuffer } from '@/app/api/agents/tools/read_document/core';
import { downloadDocument } from '@/app/api/agents/tools/read_document/source';
import { dehydrateMessageImages, hydrateMessageImages } from '@/lib/services/robot-instance/vision-message-images';
import { documentVisionContent } from '@/lib/services/robot-instance/document-vision-references';

const env = process.env;
beforeEach(() => {
  process.env = { NODE_ENV: 'test', OPENROUTER_API_KEY: randomBytes(24).toString('hex') };
  for (const method of ['log', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
  jest.mocked(downloadDocument).mockResolvedValue({ buffer: Buffer.from('synthetic PDF'), filename: 'scan.pdf', mimeType: 'application/pdf' });
});
afterEach(() => { process.env = env; jest.restoreAllMocks(); jest.clearAllMocks(); });

const image = (page: number) => ({ page, mime_type: 'image/png' as const,
  data_url: `data:image/png;base64,${Buffer.from(`synthetic page ${page}`).toString('base64')}` });
const document = (images = [image(1), image(2)]) => ({ success: true as const, type: 'pdf' as const,
  filename: 'scan.pdf', mime_type: 'application/pdf', metadata: {},
  sections: images.map(({ page }) => ({ id: `page-${page}`, text: '' })), images, truncated: false, warnings: [] as string[] });

async function run(images = document().images, routed = false, delayed = false, stream = false, screenshots = false) {
  const output = document(images);
  if (!images.length) {
    output.truncated = true;
    output.warnings.push('Image fallback unavailable; OCR or external rendering may be needed.');
  }
  jest.mocked(readDocumentBuffer).mockResolvedValue(output);
  const executor = new AIAgentExecutor();
  const requests: any[] = [];
  let iteration = 0;
  const args = { url: 'https://documents.example.test/scan.pdf' };
  const create = jest.fn(async request => {
    requests.push(JSON.parse(JSON.stringify(request)));
    iteration++;
    const waiting = delayed && iteration < 4;
    const reading = iteration === (delayed ? 4 : 1);
    const toolName = waiting ? 'wait_for_document' : routed ? 'tools' : 'read_document';
    const toolArgs = waiting ? {} : routed ? { action: 'call', name: 'read_document', args: JSON.stringify(args) } : args;
    const tool_calls = waiting || reading ? [{ id: `call-${iteration}`, type: 'function',
      function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] : undefined;
    const message = { role: 'assistant', content: tool_calls ? '' : 'Read the scanned pages', ...(tool_calls ? { tool_calls } : {}) };
    if (request.stream) return (async function* () {
      yield { choices: [{ delta: message, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] };
    })();
    return { choices: [{ message, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] };
  });
  (executor as any).client.chat.completions.create = create;
  const native = readDocumentTool();
  const router = { name: 'tools', parameters: { type: 'object', properties: {
    action: { type: 'string' }, name: { type: 'string' }, args: { type: 'string' } } },
    execute: async (params: any) => ({ success: true, name: params.name, result: await native.execute(JSON.parse(params.args)) }) };
  const messages: any[] | undefined = screenshots ? [{ role: 'user', content: [
    { type: 'text', text: 'Historical screenshots' }, ...Array.from({ length: 5 }, (_, index) =>
      ({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(`shot-${index}`).toString('base64')}` } })),
  ] }] : undefined;
  const result = await executor.act({ prompt: 'Read this image-only PDF', messages, tools: [routed ? router : native,
    { name: 'wait_for_document', parameters: { type: 'object', properties: {} }, execute: async () => ({ success: true }) }],
    maxIterations: delayed ? 5 : 2, stream, onStreamStart: async () => 'offline-stream', onStreamChunk: async () => {} });
  return { result, requests, output };
}

it.each([false, true])('sends every scanned page as vision with page identity (routed=%s)', async routed => {
  const { result, requests, output } = await run(undefined, routed);
  const messages = requests[1].messages;
  const tool = messages.find((message: any) => message.role === 'tool');
  expect(tool.tool_call_id).toBe('call-1');
  expect(tool.content).not.toContain('data:image');
  expect(tool.content).toContain('separate vision parts');
  const visual = messages.find((message: any) => message.role === 'user' && Array.isArray(message.content));
  expect(visual.content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url))
    .toEqual(output.images.map(image => image.data_url));
  const labels = visual.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  expect(labels).toContain('"page":1'); expect(labels).toContain('"page":2');
  expect(labels).toContain('scan.pdf'); expect(labels).toContain('untrusted document data');
  expect(labels).not.toContain('data:image');
  expect(messages.indexOf(visual)).toBeGreaterThan(messages.indexOf(tool));
  expect(result.steps[0].toolResults?.[0].result).toEqual(routed ? { success: true, name: 'read_document', result: output } : output);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([false, true])('does not apply screenshot sampling to PDF images on iteration four (stream=%s)', async stream => {
  const { requests } = await run(undefined, true, true, stream);
  expect(requests[4].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === 'image_url')).toHaveLength(2);
});

it('deduplicates and bounds document vision without mutating the original result', async () => {
  const images = [image(1), image(1), ...Array.from({ length: 6 }, (_, index) => image(index + 2)),
    { ...image(9), data_url: 'https://images.example.test/not-a-pdf-image.png' }];
  const { requests, output } = await run(images);
  const parts = requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  expect(parts.filter((part: any) => part.type === 'image_url')).toHaveLength(5);
  expect(output.images).toEqual(images);
  expect(requests[1].messages.find((message: any) => message.role === 'tool').content).not.toContain('data_url');
});

it('keeps unavailable image fallback as a warning without inventing vision content', async () => {
  const { requests } = await run([]);
  expect(requests[1].messages.find((message: any) => message.role === 'tool').content).toContain('Image fallback unavailable');
  expect(requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === 'image_url')).toHaveLength(0);
});

it('omits oversized encoded images without slicing their payload into text', async () => {
  const oversized = { ...image(1), data_url: `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}` };
  const { requests } = await run([oversized, image(2)]);
  const parts = requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  expect(parts.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url)).toEqual([image(2).data_url]);
  expect(requests[1].messages.find((message: any) => message.role === 'tool').content).not.toContain('data:image');
});

it('keeps all five PDF images when historical screenshots are resent afterwards', async () => {
  const images = Array.from({ length: 5 }, (_, index) => image(index + 1));
  const { requests } = await run(images, true, false, false, true);
  const parts = requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  expect(parts.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url))
    .toEqual(images.map(image => image.data_url));
});

it.each([false, true])('restores PDF images across JSON checkpoints and the next model turn (routed=%s)', async routed => {
  const { result, output } = await run(undefined, routed);
  const checkpoint = JSON.parse(JSON.stringify(dehydrateMessageImages(result.messages!)));
  expect(JSON.stringify(checkpoint)).not.toContain('data:image');
  expect(JSON.stringify(checkpoint)).toContain('[PDF image reference]');
  const hydrated = await hydrateMessageImages(checkpoint);
  const executor = new AIAgentExecutor();
  const requests: any[] = [];
  (executor as any).client.chat.completions.create = jest.fn(async request => {
    requests.push(JSON.parse(JSON.stringify(request)));
    return { choices: [{ message: { role: 'assistant', content: 'Details from the PDF' }, finish_reason: 'stop' }] };
  });
  const next = await executor.act({ messages: hydrated, tools: [], maxIterations: 1 });
  expect(requests[0].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url))
    .toEqual(output.images.map(image => image.data_url));
  expect(JSON.stringify(requests[0])).not.toContain('[PDF image reference]');
  expect(readDocumentBuffer).toHaveBeenCalledTimes(2); // One re-read shared by both saved images.
  expect(JSON.stringify(dehydrateMessageImages(next.messages!))).not.toContain('data:image');
});

it.each(['expired', 'changed', 'unavailable'])('fails closed when saved PDF images cannot be restored (%s)', async reason => {
  const { result } = await run();
  const checkpoint = JSON.parse(JSON.stringify(dehydrateMessageImages(result.messages!)));
  if (reason === 'expired') jest.mocked(downloadDocument).mockRejectedValue(new Error('Expired synthetic URL'));
  else jest.mocked(readDocumentBuffer).mockResolvedValue(document(reason === 'changed' ? [image(3), image(4)] : []));
  const hydrated = await hydrateMessageImages(checkpoint);
  expect(hydrated.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === 'image_url')).toHaveLength(0);
  expect(JSON.stringify(hydrated)).toContain('PDF image unavailable');
  expect(JSON.stringify(hydrated)).toContain('NOT visible');
  expect(JSON.stringify(hydrated)).not.toContain('Expired synthetic URL');
});

it('preserves original page selection and bounds in restored document reads', async () => {
  const args = { url: 'https://documents.example.test/scan.pdf', pages: [7, 9], maxSections: 2, maxChars: 1000 };
  const output = document([image(7), image(9)]);
  const content = documentVisionContent([{ id: 'selected-pages', name: 'read_document', status: 'completed', args, result: output }]);
  const checkpoint = JSON.parse(JSON.stringify(dehydrateMessageImages([{ role: 'user', content }])));
  jest.mocked(readDocumentBuffer).mockResolvedValue(output);
  await hydrateMessageImages(checkpoint);
  expect(readDocumentBuffer).toHaveBeenCalledWith(expect.any(Object), args);
  expect(readDocumentBuffer).toHaveBeenCalledTimes(1);
});

it('does not let restored PDFs evict an explicit current attachment', async () => {
  const images = Array.from({ length: 5 }, (_, index) => image(index + 1));
  const { result } = await run(images);
  const checkpoint = JSON.parse(JSON.stringify(dehydrateMessageImages(result.messages!)));
  const messages = await hydrateMessageImages(checkpoint);
  const target = 'data:image/png;base64,' + Buffer.from('explicit target').toString('base64');
  messages.push({ role: 'user', content: [
    { type: 'text', text: `Image reference: {"current_attachment":true}\nSource URL: ${target}` },
    { type: 'image_url', image_url: { url: target } },
  ] });
  const executor = new AIAgentExecutor();
  let request: any;
  (executor as any).client.chat.completions.create = jest.fn(async input => {
    request = JSON.parse(JSON.stringify(input));
    return { choices: [{ message: { role: 'assistant', content: 'Comparison' }, finish_reason: 'stop' }] };
  });
  await executor.act({ messages, tools: [], maxIterations: 1 });
  const sent = request.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url);
  expect(sent).toHaveLength(5);
  expect(sent).toContain(target);
  expect(sent.filter((url: string) => images.some(image => image.data_url === url))).toHaveLength(4);
  expect(JSON.stringify(request)).toContain('Image omitted from vision');
});

it('bounds restored PDF vision across multiple reads', async () => {
  const functions = Array.from({ length: 2 }, (_, index) => ({ id: `doc-${index}`, name: 'read_document',
    status: 'completed', args: { url: `https://documents.example.test/scan-${index}.pdf` },
    result: document(Array.from({ length: 5 }, (_, page) => image(page + index * 5 + 1))) }));
  const messages = functions.map(fn => ({ role: 'user', content: documentVisionContent([fn]) }));
  const checkpoint = JSON.parse(JSON.stringify(dehydrateMessageImages(messages)));
  jest.mocked(readDocumentBuffer).mockResolvedValue(functions[0].result);
  await hydrateMessageImages(checkpoint);
  expect(checkpoint.flatMap((message: any) => message.content).filter((part: any) => part.type === 'image_url')).toHaveLength(5);
  expect(readDocumentBuffer).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(checkpoint)).toContain('exceeded the vision budget');
});