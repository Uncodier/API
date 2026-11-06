import { executeTools } from '../executeTools';
import { hasMcpNativeTool } from '../mcpNativeTools';
import { FunctionCallStatus } from '../../types';
import { OpenAIToolSet } from 'composio-core';
import { downloadDocument } from '@/app/api/agents/tools/read_document/source';
import { readDocumentBuffer } from '@/app/api/agents/tools/read_document/core';

jest.mock('../customToolsMap', () => ({
  hasCustomTool: jest.fn(() => false),
  getCustomToolDefinition: jest.fn(),
}));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {} }));
jest.mock('composio-core', () => ({ OpenAIToolSet: jest.fn() }));
jest.mock('@/app/api/agents/tools/read_document/source', () => ({ downloadDocument: jest.fn() }));
jest.mock('@/app/api/agents/tools/read_document/core', () => ({ readDocumentBuffer: jest.fn() }));

describe('document execution through the shared native reader', () => {
  const args = { url: 'https://example.com/document.pdf', pages: [1], maxChars: 4000 };
  const run = (parameters = args) => executeTools([{
    id: 'document-call',
    type: 'function',
    status: FunctionCallStatus.INITIALIZED,
    name: 'read_document',
    arguments: JSON.stringify(parameters),
  }], {}, { site_id: 'site-1', command_id: 'command-1' });

  beforeEach(() => jest.resetAllMocks());

  it('reconstructs the native handler from a serialized call without leaking execution metadata', async () => {
    const document = { buffer: Buffer.from('document') };
    const output = { sections: [{ text: 'Document content' }] };
    (downloadDocument as jest.Mock).mockResolvedValue(document);
    (readDocumentBuffer as jest.Mock).mockResolvedValue(output);

    expect(hasMcpNativeTool('read_document')).toBe(true);
    const result = await run();

    expect(downloadDocument).toHaveBeenCalledWith(args.url);
    expect(readDocumentBuffer).toHaveBeenCalledWith(document, expect.objectContaining(args));
    const readerArgs = (readDocumentBuffer as jest.Mock).mock.calls[0][1];
    expect(readerArgs).not.toHaveProperty('site_id');
    expect(readerArgs).not.toHaveProperty('command_id');
    expect(result[0]).toMatchObject({ status: 'success', output });
    expect(OpenAIToolSet).not.toHaveBeenCalled();
  });

  it('reports reader failures without falling back to Composio', async () => {
    (downloadDocument as jest.Mock).mockRejectedValue(new Error('Document unavailable'));
    const result = await run();
    expect(result[0]).toMatchObject({ status: 'error', error: 'Document unavailable' });
    expect(readDocumentBuffer).not.toHaveBeenCalled();
    expect(OpenAIToolSet).not.toHaveBeenCalled();
  });

  it('preserves strict validation of model arguments', async () => {
    const result = await run({ ...args, unexpected: true } as typeof args);
    expect(result[0]).toMatchObject({ status: 'error', error: 'read_document received an unknown argument.' });
    expect(downloadDocument).not.toHaveBeenCalled();
    expect(OpenAIToolSet).not.toHaveBeenCalled();
  });
});