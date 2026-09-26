import {
  parseVisualCriticVerdict,
  runVisualCritic,
  verdictBlocksGate,
} from '../step-visual-critic';
import { fetchVisualScreenshotDataUrl } from '../visual-screenshot-data';
import { requestVisualCriticCompletion } from '../visual-critic-client';

jest.mock('../visual-screenshot-data', () => ({
  fetchVisualScreenshotDataUrl: jest.fn(),
}));
jest.mock('../visual-critic-client', () => ({
  requestVisualCriticCompletion: jest.fn(),
}));

const mockedFetchScreenshot =
  fetchVisualScreenshotDataUrl as jest.MockedFunction<
    typeof fetchVisualScreenshotDataUrl
  >;
const mockedCompletion =
  requestVisualCriticCompletion as jest.MockedFunction<
    typeof requestVisualCriticCompletion
  >;

const validPass = JSON.stringify({
  pass: true,
  summary: 'The page is ready.',
  defects: [],
});

describe('visual critic contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchScreenshot.mockResolvedValue(
      'data:image/jpeg;base64,dmlzdWFs',
    );
  });

  it('keeps json_schema responses structurally strict', () => {
    expect(parseVisualCriticVerdict(validPass)).toEqual({
      pass: true,
      summary: 'The page is ready.',
      defects: [],
    });
    expect(parseVisualCriticVerdict(
      '{"pass":true,"summary":"Incomplete","defects":[{"severity":"major"}]}',
    )).toBeNull();
    expect(parseVisualCriticVerdict(JSON.stringify({
      pass: true,
      summary: 'Contradictory verdict.',
      defects: [{
        category: 'broken_visual',
        severity: 'blocker',
        route: '/',
        viewport: 'desktop',
        description: 'The page is unusable.',
        fix_hint: null,
      }],
    }))).toEqual(expect.objectContaining({
      pass: false,
      summary: 'Contradictory verdict.',
    }));
    expect(parseVisualCriticVerdict(JSON.stringify({
      pass: true,
      summary: 'Unexpected field.',
      defects: [],
      harmless_extra: true,
    }))).toBeNull();
    expect(parseVisualCriticVerdict(JSON.stringify({
      pass: true,
      summary: 'Missing strict fix hint.',
      defects: [{
        category: 'spacing',
        severity: 'minor',
        route: '/',
        viewport: 'desktop',
        description: 'Spacing is uneven.',
      }],
    }))).toBeNull();
  });

  it('normalizes permissive fallback output and strips unknown fields', () => {
    const parsed = parseVisualCriticVerdict(JSON.stringify({
      pass: false,
      summary: 'Only minor polish remains.',
      harmless_extra: 'ignored',
      defects: [{
        category: 'spacing',
        severity: 'minor',
        route: '/',
        viewport: 'desktop',
        description: 'Spacing is uneven.',
        ignored: true,
      }, {
        category: 'copy',
        severity: 'minor',
        route: '/pricing',
        viewport: 'mobile',
        description: 'The label is vague.',
        fix_hint: null,
      }],
    }), 'json_object');

    expect(parsed).toEqual({
      pass: true,
      summary: 'Only minor polish remains.',
      defects: [{
        category: 'spacing',
        severity: 'minor',
        route: '/',
        viewport: 'desktop',
        description: 'Spacing is uneven.',
      }, {
        category: 'copy',
        severity: 'minor',
        route: '/pricing',
        viewport: 'mobile',
        description: 'The label is vague.',
      }],
    });
  });

  it('truncates fallback prose only after validating its structure', () => {
    const longText = 'x'.repeat(450);
    const parsed = parseVisualCriticVerdict(JSON.stringify({
      pass: true,
      summary: longText,
      defects: [{
        category: 'responsive',
        severity: 'major',
        route: '/',
        viewport: 'mobile',
        description: longText,
        fix_hint: longText,
      }],
    }), 'json_object');

    expect(parsed?.summary).toHaveLength(400);
    expect(parsed?.defects[0].description).toHaveLength(400);
    expect(parsed?.defects[0].fix_hint).toHaveLength(400);
    expect(parsed?.pass).toBe(true);
  });

  it('unwraps fallback arrays and normalizes common enum wording', () => {
    const parsed = parseVisualCriticVerdict(JSON.stringify([{
      result: {
        pass: true,
        summary: 'The layout needs attention.',
        defects: [{
          category: 'Color & Contrast',
          severity: 'Critical',
          route: '/',
          viewport: 'desktop',
          description: 'The primary action is unreadable.',
        }],
      },
    }]), 'json_object');

    expect(parsed).toEqual({
      pass: false,
      summary: 'The layout needs attention.',
      defects: [{
        category: 'color_contrast',
        severity: 'blocker',
        route: '/',
        viewport: 'desktop',
        description: 'The primary action is unreadable.',
      }],
    });
  });

  it.each([
    ['an invalid category', {
      category: 'animation',
      severity: 'minor',
      route: '/',
      viewport: 'desktop',
      description: 'Animation is distracting.',
    }],
    ['a missing route', {
      category: 'spacing',
      severity: 'minor',
      viewport: 'desktop',
      description: 'Spacing is uneven.',
    }],
    ['a missing description', {
      category: 'spacing',
      severity: 'minor',
      route: '/',
      viewport: 'desktop',
    }],
  ])('rejects fallback defects with %s', (_label, defect) => {
    expect(parseVisualCriticVerdict(JSON.stringify({
      pass: true,
      summary: 'Invalid defect.',
      defects: [defect],
    }), 'json_object')).toBeNull();
  });

  it('derives fallback pass from defect severities', () => {
    expect(parseVisualCriticVerdict(JSON.stringify({
      pass: true,
      summary: 'A blocker was found.',
      defects: [{
        category: 'broken_visual',
        severity: 'blocker',
        route: '/',
        viewport: 'desktop',
        description: 'The page does not render.',
      }],
    }), 'json_object')?.pass).toBe(false);
  });

  it('retries malformed structured output before accepting a verdict', async () => {
    mockedCompletion
      .mockResolvedValueOnce({
        text: 'not-json',
        model: 'gemini-2.5-flash',
        finishReason: 'stop',
        responseFormat: 'json_schema',
      })
      .mockResolvedValueOnce({
        text: validPass,
        model: 'gemini-2.5-flash',
        finishReason: 'stop',
        responseFormat: 'json_schema',
      });

    const result = await runVisualCritic({
      requirementId: 'req-1',
      screenshots: [{
        route: '/dashboard',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      step: { order: 1 },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'verified',
      pass: true,
      completion_attempts: 2,
      skipped: undefined,
    }));
    expect(mockedCompletion).toHaveBeenCalledTimes(2);
  });

  it('increases the token budget only after a truncated model response', async () => {
    mockedCompletion
      .mockResolvedValueOnce({ text: '{"pass":', model: 'gemini-2.5-flash', finishReason: 'length', responseFormat: 'json_schema' })
      .mockResolvedValueOnce({ text: validPass, model: 'gemini-2.5-flash', finishReason: 'stop', responseFormat: 'json_schema' });

    const result = await runVisualCritic({
      requirementId: 'req-1', screenshots: [{ route: '/', viewport: 'desktop', url: 'visual-storage://shot.jpg' }],
      step: { order: 1 },
    });

    expect(result.status).toBe('verified');
    expect(mockedCompletion).toHaveBeenCalledTimes(2);
    expect(mockedCompletion.mock.calls[0][0].maxOutputTokens).toBeUndefined();
    expect(mockedCompletion.mock.calls[1][0].maxOutputTokens).toBe(2_400);
  });

  it('keeps the gate unverified after repeated malformed responses', async () => {
    mockedCompletion.mockResolvedValue({
      text: 'not-json',
      model: 'gemini-2.5-flash',
      finishReason: 'stop',
      responseFormat: 'json_schema',
    });

    const result = await runVisualCritic({
      requirementId: 'req-1',
      screenshots: [{
        route: '/dashboard',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      step: { order: 1 },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'unavailable',
      pass: false,
      skipped: 'parse_error',
      completion_attempts: 2,
      response_excerpt: 'not-json',
    }));
  });

  it('still blocks a verified product defect', async () => {
    mockedCompletion.mockResolvedValue({
      text: JSON.stringify({
        pass: false,
        summary: 'The page is unusable.',
        defects: [{
          category: 'broken_visual',
          severity: 'blocker',
          route: '/dashboard',
          viewport: 'desktop',
          description: 'The primary content does not render.',
          fix_hint: 'Restore the main content.',
        }],
      }),
      model: 'gemini-2.5-flash',
      finishReason: 'stop',
      responseFormat: 'json_schema',
    });

    const result = await runVisualCritic({
      requirementId: 'req-1',
      screenshots: [{
        route: '/dashboard',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      step: { order: 1 },
    });

    expect(result.status).toBe('verified');
    expect(verdictBlocksGate(result)).toBe(true);
  });

  it('accepts a complete json_object fallback response', async () => {
    mockedCompletion.mockResolvedValue({
      text: JSON.stringify({
        pass: true,
        summary: 'The page does not render.',
        ignored_top_level: true,
        defects: [{
          category: 'broken_visual',
          severity: 'blocker',
          route: '/dashboard',
          viewport: 'desktop',
          description: 'The primary content is missing.',
          ignored_defect_field: 'ignored',
        }],
      }),
      model: 'gemini-2.5-flash',
      finishReason: 'stop',
      responseFormat: 'json_object',
    });

    const result = await runVisualCritic({
      requirementId: 'req-1',
      screenshots: [{
        route: '/dashboard',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      step: { order: 1 },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'verified',
      pass: false,
      response_format: 'json_object',
      completion_attempts: 1,
    }));
    expect(result.defects[0]).toEqual({
      category: 'broken_visual',
      severity: 'blocker',
      route: '/dashboard',
      viewport: 'desktop',
      description: 'The primary content is missing.',
    });
  });
});
