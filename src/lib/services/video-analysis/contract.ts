import { z } from 'zod';

const seconds = z.number().finite().min(0).max(7200);
const interval = {
  start_seconds: seconds.default(0),
  end_seconds: seconds.optional(),
};
const crop = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
}).strict().refine(value => value.x + value.width <= 1 && value.y + value.height <= 1,
  'Crop must fit inside the source image');

export const videoAnalysisSchema = z.object({
  video_url: z.string().url().max(4096),
  question: z.string().trim().min(1).max(2000).optional(),
  previous_description: z.string().trim().min(1).max(12000).optional(),
  frames: z.object({
    enabled: z.boolean().default(true),
    ...interval,
    count: z.number().int().min(1).max(24).default(8),
    max_width: z.number().int().min(64).max(1920).default(768),
    max_height: z.number().int().min(64).max(1920).default(768),
    crop: crop.optional(),
  }).strict().default({}),
  transcription: z.object({
    enabled: z.boolean().default(false),
    ...interval,
  }).strict().default({}),
}).strict().superRefine((value, context) => {
  if (!value.frames.enabled && !value.transcription.enabled) {
    context.addIssue({ code: 'custom', message: 'Enable frames or transcription' });
  }
  for (const [name, selection] of Object.entries({ frames: value.frames, transcription: value.transcription })) {
    if (selection.end_seconds !== undefined &&
        (selection.end_seconds <= selection.start_seconds || selection.end_seconds - selection.start_seconds > 600)) {
      context.addIssue({ code: 'custom', path: [name], message: 'Interval must be positive and no longer than 600 seconds' });
    }
  }
  if (value.frames.crop && !value.previous_description) {
    context.addIssue({ code: 'custom', path: ['previous_description'],
      message: 'Inspect the video first and pass its previous_description before spatial zoom' });
  }
});

export type VideoAnalysisInput = z.infer<typeof videoAnalysisSchema>;
export interface ExtractedVideo {
  duration_seconds: number;
  width: number;
  height: number;
  has_audio: boolean;
  frames: Array<{ timestamp_seconds: number; width: number; height: number; data_url: string }>;
  audio?: Buffer;
  frame_interval?: { start_seconds: number; end_seconds: number };
  transcription_interval?: { start_seconds: number; end_seconds: number };
}

/** Expose field names, never rejected values (URLs can contain bearer tokens). */
export function parseVideoAnalysisInput(input: unknown): VideoAnalysisInput {
  const parsed = videoAnalysisSchema.safeParse(input);
  if (!parsed.success) {
    throw new VideoAnalysisError('VIDEO_ANALYSIS_INVALID_INPUT',
      `Invalid video analysis parameters: ${parsed.error.issues.map(issue =>
        `${issue.path.join('.') || 'input'}: ${issue.code === 'custom' ? issue.message : 'value is out of range or has the wrong type'}`
      ).join('; ')}`);
  }
  return parsed.data;
}

export class VideoAnalysisError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}