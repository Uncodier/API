import { describe, expect, it } from '@jest/globals';
import { extractAgentProbeEvidence } from '../step-agent-probe-evidence';

describe('agent probe evidence', () => {
  it('promotes API probe results into structured observations', () => {
    const evidence = extractAgentProbeEvidence({
      steps: [{
        toolCalls: [{
          id: 'probe',
          toolName: 'sandbox_probe_api',
        }],
        toolResults: [{
          toolCallId: 'probe',
          result: {
            ok: true,
            apis: [{
              path: '/api/campaigns',
              method: 'POST',
              http_status: 200,
            }],
          },
        }],
      }],
    });

    expect(evidence.observations).toEqual([
      expect.objectContaining({
        target: 'POST /api/campaigns',
        method: 'POST',
        http_status: 200,
        disposition: 'pass',
      }),
    ]);
  });

  it('propagates an explicit criterion binding to probe observations', () => {
    const evidence = extractAgentProbeEvidence({
      steps: [{
        toolCalls: [{ id: 'probe', toolName: 'sandbox_probe_api' }],
        toolResults: [{
          toolCallId: 'probe',
          result: {
            criterion_id: 'criterion-orders',
            apis: [{ path: '/api/orders', method: 'POST', http_status: 201 }],
          },
        }],
      }],
    });

    expect(evidence.observations).toEqual([
      expect.objectContaining({ criterion_id: 'criterion-orders' }),
    ]);
  });

  it('promotes scenario HTTP and DOM receipts', () => {
    const evidence = extractAgentProbeEvidence({
      steps: [{
        toolCalls: [{
          id: 'scenario',
          toolName: 'sandbox_run_scenario',
        }],
        toolResults: [{
          toolCallId: 'scenario',
          result: {
            criterion_id: 'criterion-contact',
            scenarios: [{
              steps: [{
                receipt: {
                  kind: 'http_response',
                  pass: true,
                  method: 'POST',
                  target: '/api/contact',
                  actual_status: 201,
                  expected_statuses: [201],
                },
              }, {
                receipt: {
                  kind: 'dom_assertion',
                  pass: true,
                  selector: '[data-testid="success"]',
                  assertion: 'exists',
                  actual: 1,
                },
              }],
            }],
          },
        }],
      }],
    });

    expect(evidence.scenario_assertions).toHaveLength(2);
    expect(evidence.scenario_assertions).toEqual([
      expect.objectContaining({ criterion_id: 'criterion-contact' }),
      expect.objectContaining({ criterion_id: 'criterion-contact' }),
    ]);
    expect(evidence.observations).toContainEqual(expect.objectContaining({
      target: 'POST /api/contact',
      http_status: 201,
    }));
  });

  it('discards probe receipts followed by a workspace mutation', () => {
    const evidence = extractAgentProbeEvidence({
      steps: [{
        toolCalls: [{
          id: 'probe',
          toolName: 'sandbox_probe_routes',
        }, {
          id: 'edit',
          toolName: 'sandbox_edit_file',
        }],
        toolResults: [{
          toolCallId: 'probe',
          result: {
            pages: [{ path: '/dashboard', http_status: 200 }],
          },
        }],
      }],
    });

    expect(evidence.observations).toEqual([]);
  });
});
