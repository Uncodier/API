import { describe, expect, it } from '@jest/globals';
import {
  compileAcceptanceContract,
  resolveAcceptanceContract,
} from '../requirement-acceptance-contract';

describe('acceptance contract compiler', () => {
  it('compiles authenticated API behavior into a typed HTTP claim', () => {
    const contract = compileAcceptanceContract([
      'GET /api/campaigns returns 200 and lists campaigns created by the user or their organization.',
    ]);

    expect(contract.criteria[0].all_of).toContainEqual({
      kind: 'http_response',
      path: '/api/campaigns',
      method: 'GET',
      expected_status: '200',
      auth: 'required',
    });
  });

  it('treats wrapped header content as part of one link claim', () => {
    const contract = compileAcceptanceContract([
      'The dashboard header logo or title wraps a Next.js Link that navigates to /dashboard.',
    ]);

    expect(contract.criteria[0].all_of).toEqual([
      {
        kind: 'internal_link',
        path: '/dashboard',
        region: 'header',
        requires_content: true,
      },
    ]);
  });

  it('keeps independent visual obligations separate from link integrity', () => {
    const contract = compileAcceptanceContract([
      'Footer links resolve, icons render, and legal text uses the required styling.',
    ]);

    expect(contract.criteria[0].all_of).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'internal_link', region: 'footer' }),
      expect.objectContaining({
        kind: 'unsupported_obligation',
        reason: 'compound',
      }),
    ]));
  });

  it('recompiles stale persisted contracts after acceptance changes', () => {
    const oldContract = compileAcceptanceContract([
      'GET /api/old returns 200.',
    ]);

    expect(resolveAcceptanceContract(
      ['POST /api/new returns 201.'],
      oldContract,
    ).criteria[0].all_of).toContainEqual(expect.objectContaining({
      kind: 'http_response',
      method: 'POST',
      path: '/api/new',
      expected_status: '201',
    }));
  });
});
