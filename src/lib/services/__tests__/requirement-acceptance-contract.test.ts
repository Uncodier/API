import { describe, expect, it } from '@jest/globals';
import {
  compileAcceptanceContract,
  isDeclaredAcceptanceContract,
  parseDeclaredAcceptanceContract,
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

  it('keeps a route target in removal-oriented link criteria', () => {
    const contract = compileAcceptanceContract([
      'src/components/Header.tsx no longer presents an interactive link or control targeting /pricing.',
    ]);

    expect(contract.criteria[0].all_of).toContainEqual({
      kind: 'internal_link',
      path: '/pricing',
      region: 'header',
      requires_content: false,
    });
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

  it('accepts a declared semantic contract with a retrieval specimen', () => {
    const acceptance = ['Evidence capture opens the device camera.'];
    const contract = parseDeclaredAcceptanceContract(acceptance, {
      schema_version: 2,
      source: 'declared',
      criteria: [{
        id: 'camera-input',
        text: acceptance[0],
        all_of: [{
          kind: 'semantic_assertion',
          text: acceptance[0],
        }],
        discovery: {
          query: 'mobile evidence camera file input',
          hypothetical_code:
            '<input type="file" accept="image/*" capture="environment" />',
          expected_symbols: ['EvidenceCapture'],
        },
      }],
    });

    expect(isDeclaredAcceptanceContract(contract)).toBe(true);
    expect(resolveAcceptanceContract(acceptance, contract)).toEqual(contract);
  });

  it('rejects malformed declared route targets', () => {
    expect(() => parseDeclaredAcceptanceContract(
      ['The evidence page renders.'],
      {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'evidence-page',
          text: 'The evidence page renders.',
          all_of: [{
            kind: 'page_response',
            path: '/>',
          }],
        }],
      },
    )).toThrow('Invalid declared acceptance contract');
  });

  it('requires a hypothetical code specimen for semantic-only claims', () => {
    const acceptance = ['Evidence capture opens the device camera.'];
    expect(() => parseDeclaredAcceptanceContract(acceptance, {
      schema_version: 2,
      source: 'declared',
      criteria: [{
        id: 'camera-input',
        text: acceptance[0],
        all_of: [{
          kind: 'semantic_assertion',
          text: acceptance[0],
        }],
      }],
    })).toThrow('requires discovery.hypothetical_code');
  });

  it('rejects blank commands and repository path traversal', () => {
    const acceptance = ['Produce the requested artifact.'];
    for (const claim of [
      { kind: 'command', command: '   ' },
      { kind: 'file_artifact', path: '../../etc/passwd' },
    ]) {
      expect(() => parseDeclaredAcceptanceContract(acceptance, {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'artifact',
          text: acceptance[0],
          all_of: [claim],
        }],
      })).toThrow('Invalid declared acceptance contract');
    }
  });

  it('persists canonical route and artifact paths', () => {
    const acceptance = ['Expose the dashboard artifact.'];
    const contract = parseDeclaredAcceptanceContract(acceptance, {
      schema_version: 2,
      source: 'declared',
      criteria: [{
        id: 'dashboard',
        text: acceptance[0],
        all_of: [
          {
            kind: 'page_response',
            path: ' /dashboard/ ',
          },
          {
            kind: 'file_artifact',
            path: './src/app/dashboard/page.tsx',
          },
        ],
      }],
    });

    expect(contract.criteria[0].all_of).toEqual([
      expect.objectContaining({ path: '/dashboard' }),
      expect.objectContaining({ path: 'src/app/dashboard/page.tsx' }),
    ]);
  });
});
