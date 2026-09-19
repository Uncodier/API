import { routesFromAcceptance } from '../requirement-acceptance';

describe('acceptance route extraction', () => {
  it('extracts standalone application routes only', () => {
    expect(routesFromAcceptance([
      'POST /api/assets returns 201 and /dashboard/assets renders.',
      'Use components/ui and inspect hydration/runtime.',
      'Edit /src/app/dashboard/page.tsx.',
    ])).toEqual(['/api/assets', '/dashboard/assets']);
  });
});
