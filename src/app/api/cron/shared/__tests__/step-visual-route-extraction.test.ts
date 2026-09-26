import { extractPageRoutesFromStepContext } from '../step-visual-feedback';

describe('visual probe routes from step context', () => {
  it('strips punctuation from prose without turning API or file paths into page targets', () => {
    expect(extractPageRoutesFromStepContext({
      instructions: "Open '/dashboard.' then check /contacto! and GET /api/orders from /src/app/page.tsx.",
    })).toEqual(['/dashboard', '/contacto']);
  });
});