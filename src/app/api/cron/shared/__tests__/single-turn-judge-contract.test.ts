import { describe, expect, it } from '@jest/globals';
import { adjudicationContractAcceptance } from '../single-turn-judge-contract';

const step = {
  expected_output: 'A consistent site layout.',
  success_criteria: [
    'La navegación enlaza /, /servicios, /nosotros y /contacto.',
    'Los CTAs comparten un estilo corporativo.',
    'Las pruebas de build pasan.',
  ],
  validation_rules: [
    'Debe correr build exitosamente y no mostrar fallos de render.',
  ],
};

describe('no-progress Judge acceptance contract', () => {
  it('keeps canonical backlog acceptance for a final step', () => {
    expect(adjudicationContractAcceptance({
      step,
      requireContractJudge: true,
      isLastStep: true,
    })).toBeUndefined();
  });

  it('uses only executable step criteria for a non-final step', () => {
    expect(adjudicationContractAcceptance({
      step,
      requireContractJudge: true,
      isLastStep: false,
    })).toEqual([
      'La navegación enlaza /, /servicios, /nosotros y /contacto.',
      'Las pruebas de build pasan.',
      'Debe correr build exitosamente y no mostrar fallos de render.',
    ]);
  });
});
