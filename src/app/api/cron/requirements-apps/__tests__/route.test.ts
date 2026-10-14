import { randomBytes, randomUUID } from 'node:crypto';
const start = jest.fn(); const claimRequirementRun = jest.fn(); const dueScheduledRequirements = jest.fn(); const finishRequirementCycle = jest.fn();
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
jest.mock('workflow/api', () => ({ start }));
jest.mock('../workflow', () => ({ runCronAppsWorkflow: jest.fn() }));
jest.mock('@/lib/harness/requirement-scheduler', () => ({ claimRequirementRun, dueScheduledRequirements, finishRequirementCycle }));
import { GET } from '../route';

const run = () => ({ requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), sessionId: randomUUID(), runId: randomUUID(), executionGeneration: 0 });
let secret: string;
beforeEach(() => {
  jest.resetAllMocks(); secret = randomBytes(32).toString('hex'); process.env.CRON_SECRET = secret;
  dueScheduledRequirements.mockResolvedValue([]); finishRequirementCycle.mockResolvedValue(undefined); start.mockResolvedValue({ runId: 'workflow-run' });
});
afterEach(() => { delete process.env.CRON_SECRET; });
const request = () => new Request('https://api.example.invalid/api/cron/requirements-apps', { headers: { authorization: `Bearer ${secret}` } });
it('keeps existing cron authentication and performs no work without it', async () => {
  expect((await GET(new Request('https://api.example.invalid/api/cron/requirements-apps'))).status).toBe(401);
  expect(claimRequirementRun).not.toHaveBeenCalled();
});
it('dispatches the same familiar cron directly to the agent with host identity, not gates or plans', async () => {
  const identity = run(); claimRequirementRun.mockResolvedValueOnce({ state: 'claimed', run: identity, requirement: { backlog: { items: [] } } }).mockResolvedValue(null);
  const response = await GET(request()); expect(response.status).toBe(200);
  expect(start).toHaveBeenCalledWith(expect.anything(), [identity]);
  expect(claimRequirementRun).toHaveBeenLastCalledWith([identity.requirementId], expect.any(Number), []);
});
it('failed dispatch records a retry of the same session and never starts a fallback engine', async () => {
  const identity = run(); claimRequirementRun.mockResolvedValueOnce({ state: 'claimed', run: identity }).mockResolvedValue(null);
  start.mockRejectedValue(new Error('transport unavailable'));
  const result = await (await GET(request())).json();
  expect(result.results[0]).toMatchObject({ sessionId: identity.sessionId, started: false });
  expect(finishRequirementCycle).toHaveBeenCalledWith(identity, 'waiting', 'dispatch_unavailable', expect.any(String));
  expect(start).toHaveBeenCalledTimes(1);
});
it('does not overlap existing capacity or revive another executor on migration failure', async () => {
  claimRequirementRun.mockResolvedValue({ state: 'capacity_full' });
  expect((await (await GET(request())).json()).capacityReached).toBe(true); expect(start).not.toHaveBeenCalled();
  claimRequirementRun.mockRejectedValue(new Error('missing migration'));
  expect((await GET(request())).status).toBe(503); expect(start).not.toHaveBeenCalled();
});