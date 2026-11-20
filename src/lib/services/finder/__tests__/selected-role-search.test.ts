import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/finder/person_role_search/route';
import { CreditService } from '@/lib/services/billing/CreditService';

jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: {
  PRICING: { PERSON_ROLE_SEARCH: 1 }, validateCredits: jest.fn(), deductCredits: jest.fn(),
} }));
jest.mock('@/lib/utils/api-response-utils', () => ({ logInfo: jest.fn(), logError: jest.fn() }));

const originalEnv = process.env;
const request = (body: Record<string, unknown>) => new NextRequest('https://example.invalid/api/finder/person_role_search', {
  method: 'POST', body: JSON.stringify({ site_id: 'site', page: 0, page_size: 10, ...body }),
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv, FORAGER_ACCOUNT_ID: 'test', FORAGER_API_KEY: randomBytes(24).toString('hex') };
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ search_results: [] }));
  jest.mocked(CreditService.validateCredits).mockResolvedValue(true);
});
afterEach(() => { process.env = originalEnv; jest.restoreAllMocks(); });

it.each([
  { person_id: '__selected_people_only__', selected_request_id: 'request', selected_actor_id: 'actor' },
  { person_id: '__selected_people_only__' }, { selected_request_id: 'request' },
  { selected_actor_id: 'actor' }, { source: 'selected_people' },
])('blocks a selected-list query before billing or provider access: %j', async body => {
  const response = await POST(request(body));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ success: false, error: { code: 'SELECTED_LIST_NOT_SEARCHABLE' } });
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('still bills and forwards an ordinary filtered search exactly once', async () => {
  expect((await POST(request({ role_title: ['Buyer', 'Purchaser'] }))).status).toBe(200);
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(jest.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ role_title: 'Buyer OR Purchaser', page: 0, page_size: 10 });
});