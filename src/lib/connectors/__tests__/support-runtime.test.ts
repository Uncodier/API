import { randomUUID } from 'node:crypto';
import { executeSupportConnectorTool, type SupportConnectorScope } from '../support-runtime';
import { discoverSupport } from '../support-runtime-discovery';
import { executeGenericSupport } from '../support-generic-execution';
import { requestProposal } from '../approval-store';
import { executeConnectorTool, describeConnectorTool } from '../composio-sessions';

jest.mock('../support-runtime-discovery', () => ({discoverSupport: jest.fn()}));
jest.mock('../support-generic-execution', () => ({executeGenericSupport: jest.fn()}));
jest.mock('../approval-store', () => ({requestProposal: jest.fn()}));
jest.mock('../composio-sessions', () => ({executeConnectorTool: jest.fn(), describeConnectorTool: jest.fn()}));
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin: {}}));

const base = {siteId: randomUUID(), agentId: randomUUID(), conversationId: randomUUID(), idempotencyKey: randomUUID()};
const member = {...base, audience: 'member', userId: randomUUID()} as const;
const name = `connector:${randomUUID()}:GMAIL_FETCH_EMAILS`;
const call = {action: 'call', name, version: '1', schema_hash: 'a'.repeat(64), arguments: {}};
const unavailable = {success: false, status: 'unavailable'} as const;
const run = (scope: unknown, input: unknown) => executeSupportConnectorTool({...base, resolve: async () => scope as SupportConnectorScope}, 'support_connectors', input);
beforeEach(() => jest.resetAllMocks());
afterEach(() => {
  expect(requestProposal).not.toHaveBeenCalled();
  expect(executeConnectorTool).not.toHaveBeenCalled();
  expect(describeConnectorTool).not.toHaveBeenCalled();
});

it.each([null, {...base, audience:'anonymous'}, {...base, audience:'verified', leadId:randomUUID()},
  {...member, audience:'external'}, {...member, leadId:randomUUID()}, {...member, siteId:randomUUID()}, {...member, agentId:randomUUID()}])(
  'rejects an invalid or non-private host before discovery or execution', async scope => {
    for (const input of [{action:'list'}, {action:'search',query:'gmail'}, {action:'describe',name}, call]) {
      expect(await run(scope, input)).toEqual(unavailable);
    }
    expect(discoverSupport).not.toHaveBeenCalled();
    expect(executeGenericSupport).not.toHaveBeenCalled();
  });

it.each([name, name.replace('GMAIL_FETCH_EMAILS', 'PUBLISHED_SUPPORT_TITLES')])('does not retry generic denials through review or a publication', async ref => {
  jest.mocked(executeGenericSupport).mockResolvedValue(unavailable);
  expect(await run(member, {...call, name:ref})).toEqual(unavailable);
  expect(executeGenericSupport).toHaveBeenCalledTimes(1);
  expect(discoverSupport).not.toHaveBeenCalled();
});

it('withholds a result if the resolved conversation changes at release', async () => {
  const resolve = jest.fn().mockResolvedValueOnce(member).mockResolvedValue({...member, conversationId: randomUUID()});
  jest.mocked(executeGenericSupport).mockImplementation(async (_scope, _input, recheckHost) => {
    await recheckHost();
    return {success:true, status:'completed', result_omitted:true};
  });
  expect(await executeSupportConnectorTool({...base, resolve}, 'support_connectors', call)).toEqual(unavailable);
  expect(resolve).toHaveBeenCalledTimes(2);
});
