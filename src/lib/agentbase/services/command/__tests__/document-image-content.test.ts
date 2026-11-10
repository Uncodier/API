import { documentImageContent } from '../document-image-content';
import { buildToolTurnContext, summarizeFunctions } from '../tool-loop-context';
import { prepareMessagesFromCommand } from '../../../agents/toolEvaluator/messageFormatter';
import { prepareMessagesForTarget } from '../../../agents/targetEvaluator/formatters/target-message-formatter';
import { runToolCompletionLoop } from '../tool-completion-loop';

const imageUrl = (value: string) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`;
const image = { page: 1, mime_type: 'image/png', data_url: imageUrl('synthetic-test-image') };
const document = {
  id: 'read-1', name: 'read_document', status: 'completed',
  result: { success: true, type: 'pdf', filename: 'scan.pdf', sections: [{ id: 'page-1', text: '' }], images: [image] },
};
const fixture = (functions: any[] = [document]) => ({
  id: 'command', agent_background: 'Support', context: 'Current message: [document]', tools: [], functions,
}) as any;

describe('PDF tool images at the model boundary', () => {
  it('keeps base64 out of textual summaries without mutating the persisted result', () => {
    const context = buildToolTurnContext({ originalContext: '[document]', instruction: '', functions: [document] });
    expect(context).toContain('"text":""');
    expect(context).toContain('"page":1');
    expect(context).not.toContain(image.data_url);
    expect(document.result.images[0]).toEqual(image);
  });

  it.each([prepareMessagesFromCommand, (command: any) => prepareMessagesForTarget(command, 'Reply')])(
    'supplies image-only document output as image_url rather than text %#', formatter => {
      const command = fixture();
      command.context = buildToolTurnContext({ originalContext: command.context, instruction: '', functions: command.functions });
      const messages = formatter(command);
      expect(messages.find(message => message.role === 'user')?.content).toEqual(expect.arrayContaining([
        { type: 'image_url', image_url: { url: image.data_url } },
      ]));
      const text = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n');
      expect(text).not.toContain(image.data_url);
      expect(text).toContain('scan.pdf');
    },
  );

  it.each([false, true])('retains images through tool turns and the final target (time cap=%s)', async capped => {
    const executeCommand = jest.fn(async (command: any) => ({ status: 'completed' as const, updatedCommand: { ...command, functions: [document] } }));
    const result = await runToolCompletionLoop({ command: fixture([]), toolEvaluator: { executeCommand },
      commandService: { getCommandById: async () => fixture() }, now: () => capped && executeCommand.mock.calls.length ? 100 : 0, budgetMs: 50 });
    expect(executeCommand).toHaveBeenCalledTimes(capped ? 1 : 2);
    for (const command of [!capped && executeCommand.mock.calls[1][0], result.updatedCommand].filter(Boolean)) {
      expect(JSON.stringify(prepareMessagesForTarget(command, 'Reply'))).toContain(image.data_url);
      expect(command.context).not.toContain(image.data_url);
    }
  });

  it('ignores unrelated, failed, malformed and remote image outputs', () => {
    for (const fn of [
      { ...document, name: 'other_tool' }, { ...document, status: 'failed' },
      { ...document, result: { ...document.result, success: false } },
      ...[null, { ...image, page: 0 }, { ...image, data_url: 'http://127.0.0.1/private.png' }, { ...image, data_url: 'data:image/png;base64,broken…' }]
        .map(value => ({ ...document, result: { ...document.result, images: [value] } })),
    ]) expect(documentImageContent('hello', [fn])).toBe('hello');
  });

  it('deduplicates and bounds images without slicing base64', () => {
    const images = Array.from({ length: 8 }, (_, index) => ({ ...image, page: index + 1, data_url: imageUrl(`image-${index}`) }));
    const output = documentImageContent('', [{ ...document, result: { ...document.result, images: [images[0], ...images] } }]);
    expect(Array.isArray(output)).toBe(true);
    if (!Array.isArray(output)) return;
    const urls = output.filter(part => part.type === 'image_url').map(part => part.image_url.url);
    expect(urls).toHaveLength(5);
    expect(new Set(urls).size).toBe(5);
    expect(urls).toEqual(images.slice(0, 5).map(item => item.data_url));
    expect(documentImageContent('', [{ ...document, result: { ...document.result, images: [{ ...image, data_url: `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}` }] } }])).toBe('');
  });

  it('preserves ordinary results and existing attachment vision parts', () => {
    const content = [{ type: 'image_url' as const, image_url: { url: 'https://files.example.test/photo.png' } }];
    expect(documentImageContent(content, [document])).toEqual(expect.arrayContaining(content));
    expect(summarizeFunctions([{ name: 'read_document', result: { success: true, sections: [{ text: 'hello' }] } }])).toContain('"text":"hello"');
  });
});