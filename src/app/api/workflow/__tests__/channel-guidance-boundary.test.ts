import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('reads only completed Temporal guidance during the Customer Support HTTP request', () => {
  const route = readFileSync(resolve(process.cwd(), 'src/app/api/agents/customerSupport/message/route.ts'), 'utf8');
  expect(route).toContain('getCompletedChannelMessageGuidance');
  expect(route).toContain('isInternalServiceRequest(request)');
  expect(route).not.toContain('runChannelMessageWorkflows');
});