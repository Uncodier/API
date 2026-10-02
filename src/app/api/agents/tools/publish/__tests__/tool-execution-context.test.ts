import { randomBytes, randomUUID } from 'node:crypto';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as contextModule from '@/lib/services/tool-execution-context';
import { publishToolDefinition } from '../publish-schema';

const siteId = randomUUID();
const instanceId = randomUUID();
const contentId = randomUUID();
const audienceId = randomUUID();

function harness() {
  const bulkExecute = jest.fn(async (..._args: any[]) => ({ success: true, total_sent: 2 }));
  const createContent = jest.fn(async () => ({ id: contentId }));
  const { publishTool } = loadRuntimeModule<typeof import('../assistantProtocol')>(
    'src/app/api/agents/tools/publish/assistantProtocol.ts', {
      './publish-schema': { publishToolDefinition },
      '../content/create/core': { createContentCore: createContent },
      '../content/update/route': { updateContentCore: async () => ({ id: contentId }) },
      './social-publishing': {},
      '../sendBulkMessages/assistantProtocol': { sendBulkMessagesTool: () => ({ execute: bulkExecute }) },
      '../sendEmail/route': {}, '@/lib/services/whatsapp/WhatsAppSendService': {},
      '@/lib/database/lead-db': {}, '@/lib/messaging/lead-merge-fields': {},
      './instagram-dm': { validateInstagramDirectMessage: () => undefined },
      '@/lib/services/tool-execution-context': contextModule,
    });
  return { tool: publishTool(siteId, undefined, instanceId), bulkExecute, createContent };
}

describe('publish private execution context handoff', () => {
  const args = { audience_id: audienceId, channel: 'voice' as const, voice_mode: 'agent_call' as const,
    title: 'Appointment campaign', type: 'text', text: 'Hello from Acme.' };

  it('passes selected context only as the nested second argument, with final content and audience refs', async () => {
    const { tool, bulkExecute, createContent } = harness();
    const secret = randomBytes(24).toString('hex');
    const input = { version: 1 as const, site_id: siteId, intent: `${'Confirm availability. '.repeat(80)} password=${secret}`,
      background: 'Unrelated customer raw conversation', systemPrompt: 'Forbidden system prompt',
      source: { tool: 'assistant', node_id: randomUUID(), conversation_id: randomUUID(), message_id: randomUUID() } };
    const result = await tool.execute(args, input);
    expect(result.success).toBe(true);
    expect(bulkExecute).toHaveBeenCalledTimes(1);
    const [sentArgs, context] = bulkExecute.mock.calls[0];
    expect(context.source).toEqual({ node_id: input.source.node_id, tool: 'publish', instance_id: instanceId, content_id: contentId, audience_id: audienceId });
    expect(context.intent.length).toBeGreaterThan(500);
    expect(context.intent).not.toContain(secret);
    expect(context.background).toContain(`Published title: ${args.title}`);
    expect(context.background).toContain(`Published type: ${args.type}`);
    expect(context.background).toContain(args.text);
    expect(context.background).not.toContain(input.background);
    expect(context).not.toHaveProperty('systemPrompt');
    expect(sentArgs.message).toBe(args.text);
    expect(sentArgs).not.toHaveProperty('objective');
    for (const publicValue of [result, sentArgs, tool.parameters, createContent.mock.calls]) {
      expect(JSON.stringify(publicValue)).not.toContain('tool_execution_context');
      expect(JSON.stringify(publicValue)).not.toContain(context.intent);
      expect(JSON.stringify(publicValue)).not.toContain(input.background);
      expect(JSON.stringify(publicValue)).not.toContain(secret);
    }
  });

  it('explicit objective and supporting guidance override inherited guidance without changing the public greeting', async () => {
    const { tool, bulkExecute } = harness();
    const input = contextModule.buildToolExecutionContext({ site_id: siteId, intent: 'Fallback', background: 'Fallback background' });
    await tool.execute({ ...args, objective: 'Confirm Monday', additional_context: 'Verify calendar first' }, input);
    expect(bulkExecute).toHaveBeenCalledWith(expect.objectContaining({ message: args.text, objective: 'Confirm Monday' }),
      expect.objectContaining({ intent: 'Confirm Monday', background: 'Verify calendar first' }));
  });

  it('redacts selected published facts before bounding them and never copies raw metadata', async () => {
    const { tool, bulkExecute } = harness();
    const secret = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/published');
    const username = randomBytes(18).toString('hex');
    url.username = username;
    url.password = secret;
    await tool.execute({ ...args, urls: [url.href], text: 'Campaign facts. '.repeat(200) });
    const context = bulkExecute.mock.calls[0][1];
    expect(context.background.length).toBeLessThanOrEqual(4_000);
    for (const value of [secret, username]) expect(context.background).not.toContain(value);
  });

  it('rejects foreign inherited text and keeps calls without context working', async () => {
    const { tool, bulkExecute } = harness();
    const input = contextModule.buildToolExecutionContext({ site_id: randomUUID(), intent: 'Foreign private request' });
    await tool.execute(args, input);
    await tool.execute(args);
    for (const [sentArgs, context] of bulkExecute.mock.calls) {
      expect(context).not.toHaveProperty('intent');
      expect(context.site_id).toBe(siteId);
      expect(sentArgs.message).toBe(args.text);
    }
  });
});