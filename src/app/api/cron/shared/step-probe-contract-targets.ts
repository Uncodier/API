import {
  compileAcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';
import type { HttpMethod } from './step-runtime-probe';

interface ContractPageTarget {
  kind: 'page';
  path: string;
  source: 'contract';
  required: true;
  expected_statuses?: number[];
}

interface ContractApiTarget {
  kind: 'api';
  path: string;
  method: HttpMethod;
  source: 'contract';
  required: true;
  auth_required: boolean;
  expected_statuses?: number[];
}

interface ContractProbeObservation {
  kind: 'api';
  disposition: 'unknown';
  source: 'contract';
  target: string;
  detail: string;
  method: HttpMethod;
  expected_statuses?: number[];
}

function literalStatus(expected: string | undefined): number[] | undefined {
  const status = Number(expected);
  return Number.isInteger(status) ? [status] : undefined;
}

export function deriveAcceptanceProbeTargets(params: {
  acceptance?: string[];
  declaredApiKeys: ReadonlySet<string>;
}): {
  pages: ContractPageTarget[];
  apis: ContractApiTarget[];
  observations: ContractProbeObservation[];
} {
  const pages: ContractPageTarget[] = [];
  const apis: ContractApiTarget[] = [];
  const observations: ContractProbeObservation[] = [];
  const contract = compileAcceptanceContract(params.acceptance);

  for (const criterion of contract.criteria) {
    for (const claim of criterion.all_of) {
      if (claim.kind === 'page_response') {
        pages.push({
          kind: 'page',
          path: claim.path,
          source: 'contract',
          required: true,
          ...(literalStatus(claim.expected_status)
            ? { expected_statuses: literalStatus(claim.expected_status) }
            : {}),
        });
        continue;
      }
      if (claim.kind === 'internal_link' && claim.path) {
        pages.push({
          kind: 'page',
          path: claim.path,
          source: 'contract',
          required: true,
        });
        continue;
      }
      if (claim.kind !== 'http_response') continue;
      const key = `${claim.method} ${claim.path}`;
      const expectedStatuses = literalStatus(claim.expected_status);
      if (
        claim.method !== 'GET' &&
        !params.declaredApiKeys.has(key)
      ) {
        observations.push({
          kind: 'api',
          disposition: 'unknown',
          source: 'contract',
          target: key,
          detail:
            'Acceptance target was not called because no request payload fixture was declared.',
          method: claim.method,
          ...(expectedStatuses
            ? { expected_statuses: expectedStatuses }
            : {}),
        });
        continue;
      }
      apis.push({
        kind: 'api',
        path: claim.path,
        method: claim.method,
        source: 'contract',
        required: true,
        auth_required: claim.auth === 'required',
        ...(expectedStatuses
          ? { expected_statuses: expectedStatuses }
          : {}),
      });
    }
  }

  return { pages, apis, observations };
}
