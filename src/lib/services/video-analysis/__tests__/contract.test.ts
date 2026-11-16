import { parseVideoAnalysisInput } from '../contract';

const video_url = 'https://media.example.test/clip.mp4';

describe('video analysis contract', () => {
  it('defaults to an inexpensive general visual inspection', () => {
    expect(parseVideoAnalysisInput({ video_url })).toMatchObject({
      frames: { enabled: true, count: 8, max_width: 768, max_height: 768, start_seconds: 0 },
      transcription: { enabled: false, start_seconds: 0 },
    });
  });
  it('accepts transcription-only and independent partial intervals', () => {
    expect(parseVideoAnalysisInput({ video_url, frames: { enabled: false },
      transcription: { enabled: true, start_seconds: 12, end_seconds: 20 } }).transcription)
      .toEqual({ enabled: true, start_seconds: 12, end_seconds: 20 });
    expect(parseVideoAnalysisInput({ video_url, frames: { start_seconds: 30, end_seconds: 40 },
      transcription: { enabled: true, start_seconds: 0, end_seconds: 20 } }).frames.start_seconds).toBe(30);
  });
  it.each([
    { frames: { count: 0 } }, { frames: { count: 25 } }, { frames: { count: 2.5 } },
    { frames: { max_width: 1921 } }, { frames: { max_height: 63 } },
    { frames: { start_seconds: -1 } }, { frames: { start_seconds: 10, end_seconds: 10 } },
    { transcription: { end_seconds: 601 } }, { frames: { end_seconds: Infinity } },
    { frames: { enabled: false }, transcription: { enabled: false } },
    { frames: { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } } },
    { previous_description: 'Overview', frames: { crop: { x: 0.8, y: 0, width: 0.5, height: 1 } } },
    { site_id: 'untrusted-tenant' }, { frames: { unknown: true } },
  ])('rejects unsafe or ambiguous input %j', parameters => {
    expect(() => parseVideoAnalysisInput({ video_url, ...parameters })).toThrow();
  });
  it('supports source-relative spatial and temporal zoom after a description', () => {
    expect(parseVideoAnalysisInput({ video_url, previous_description: 'A small sign appears near the top left at 35 seconds.',
      frames: { start_seconds: 34, end_seconds: 36, count: 12, max_width: 1920, max_height: 1080,
        crop: { x: 0, y: 0, width: 0.25, height: 0.25 } } }).frames.crop?.width).toBe(0.25);
  });
  it('never includes rejected URL values in validation errors', () => {
    const rejected = 'not-a-url-sensitive-value';
    try { parseVideoAnalysisInput({ video_url: rejected }); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).not.toContain(rejected); }
  });
});