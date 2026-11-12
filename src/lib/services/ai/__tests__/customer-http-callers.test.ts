import { randomBytes, randomUUID } from 'node:crypto';
import { UnifiedAIService } from '../../UnifiedAIService';
import { SummaryGenerationService } from '../../summary/SummaryGenerationService';
import { getExecutionRouting, getCustomerOperationKey, getCustomerCapability, withExecutionRouting, withCustomerOperation } from '../customer-routing';
import { resolveHttpExecutionRouting, withHttpExecutionRouting } from '../customer-routing-http';
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn() }));
jest.mock('@/lib/services/summary/loadSourceText', () => ({ loadSourceText: jest.fn() }));
const env = { ...process.env };
const siteId = randomUUID();
const routing = { payer: 'platform' as const, siteId };
beforeEach(() => {
  process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  process.env.NEXT_PUBLIC_API_SERVER_URL = 'https://api.example.test';
  jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ content: 'result' }));
});
afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });

it.each(['text', 'audio', 'summary'] as const)('propagates %s host selection, site and stable operation', async kind => {
  await withCustomerOperation('turn-1', () => withExecutionRouting(routing, siteId, async () => {
    if (kind === 'summary') await SummaryGenerationService.summarize({ text: 'hello', site_id: siteId });
    else if (kind === 'audio') await UnifiedAIService.synthesizeAudio({ text: 'hello' });
    else await UnifiedAIService.generateText({ messages: [{ role: 'user', content: 'hello' }] });
  }));
  const [url, options] = jest.mocked(fetch).mock.calls[0];
  expect(options?.redirect).toBe('error');
  expect(options?.headers).toMatchObject({ 'x-api-key': process.env.SERVICE_API_KEY });
  expect(JSON.parse(options?.body as string).site_id).toBe(siteId);
  const request = new Request(url as string, options);
  expect(await resolveHttpExecutionRouting(request, siteId)).toEqual(routing);
  await withHttpExecutionRouting(request, routing, async () => {
    expect(getExecutionRouting()).toEqual(routing);
    expect(getCustomerOperationKey()).toBe('turn-1:0:0');
    expect(getCustomerCapability()).toBe(kind === 'summary' ? 'summary' : undefined);
  });
});

it('does not sign a cross-site generic service call', async () => {
  await expect(withExecutionRouting(routing, siteId, () => UnifiedAIService.generateText({
    site_id: randomUUID(), messages: [{ role: 'user', content: 'hello' }],
  }))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});