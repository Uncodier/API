import { buildCustomerSupportTools } from '@/lib/services/customer-support-tool-catalog';
import { readDocumentTool } from '@/app/api/agents/tools/read_document/assistantProtocol';

import { normalizeSupportAttachments, zavuSupportAttachments, supportAttachmentContext, supportModelContent } from '@/lib/services/customer-support-attachments';
import { prepareMessagesForTarget } from '@/lib/agentbase/agents/targetEvaluator/formatters/target-message-formatter';
import { prepareMessagesFromCommand } from '@/lib/agentbase/agents/toolEvaluator/messageFormatter';

const url = 'https://files.example.test/invoice.pdf';
const image = 'https://files.example.test/photo.jpg';

describe('support attachments', () => {
  it('registers the instance document reader as a native executable tool', () => {
    const tool = buildCustomerSupportTools().find(t => t.function.name === 'read_document');
    expect(tool?.async).toBeUndefined();
    expect(tool?.function.parameters).toEqual(readDocumentTool().parameters);
    expect(tool?.function.execute).toEqual(expect.any(Function));
  });
  it('preserves Zavu document identity and image metadata without forwarding arbitrary payload', () => {
    expect(zavuSupportAttachments({ mediaUrl: url, messageType: 'document', fileName: 'invoice.pdf', secret: 'unused' }))
      .toEqual([{ url, type: 'document', name: 'invoice.pdf', mimeType: undefined }]);
    expect(zavuSupportAttachments({ attachments: [{ url: image, contentType: 'image/jpeg' }] })[0].mimeType).toBe('image/jpeg');
  });
  it('bounds and deduplicates references and rejects invalid URL schemes', () => {
    expect(normalizeSupportAttachments([{ url: 'file:///tmp/a' }, { url: 'data:image/png;base64,x' }, { url }, { url }])).toHaveLength(1);
    expect(normalizeSupportAttachments(Array.from({ length: 20 }, (_, i) => ({ url: `${url}?n=${i}` })))).toHaveLength(10);
  });
  it('keeps document URLs available to read_document without pretending they are images', () => {
    const context = supportAttachmentContext([{ url, type: 'document' }]);
    expect(context).toContain('read_document');
    expect(supportModelContent(context)).toBe(context);
  });
  it('reuses assistant image parts in both tool selection and final reply turns, including history', () => {
    const context = 'Current message: explain this\n\nConversation History:\n' + supportAttachmentContext([{ url: image, type: 'image' }]);
    const command = { id: 'test', agent_background: 'Support', context, tools: [] } as any;
    for (const messages of [prepareMessagesForTarget(command, 'Reply'), prepareMessagesFromCommand(command)]) {
      expect(messages.find(m => m.role === 'user')?.content).toEqual(expect.arrayContaining([
        { type: 'image_url', image_url: { url: image } },
      ]));
    }
  });
  it('leaves ordinary text unchanged', () => {
    expect(supportModelContent('hello')).toBe('hello');
    expect(supportAttachmentContext(undefined)).toBe('');
  });
});
