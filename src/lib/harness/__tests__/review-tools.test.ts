import { createReviewTools } from '../review-tools';
import type { Workspace } from '../types';
it('an unfavorable advisory review returns findings without affecting progress or editing permissions', async () => {
  const readFile = jest.fn().mockResolvedValue('export const result = 1;');
  const model = { respond: jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'Found a bug; add a regression test.' }, finishReason: 'stop' }) };
  const tools = createReviewTools({ readFile } as unknown as Workspace, model);
  const result = await tools[0].execute({ files: ['src/main.ts'], objective: 'Correct calculation' }, { sessionId: 'session', operationId: 'review', signal: new AbortController().signal, assertActive: async () => {} });
  expect(result).toEqual({ ok: true, output: { advisory: true, findings: 'Found a bug; add a regression test.' } });
  expect(model.respond.mock.calls[0][0].tools).toEqual([]);
  expect(tools[0].effect).toBe('read');
});