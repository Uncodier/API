import { z } from 'zod';

export const DEFAULT_TIKTOK_OPTIONS = Object.freeze({
  postMode: 'DIRECT_POST',
  privacyLevel: 'PUBLIC_TO_EVERYONE',
} as const);

export const tiktokOptionsSchema = z.union([
  z.object({ postMode: z.literal('MEDIA_UPLOAD') }).strict(),
  z.object({
    postMode: z.literal('DIRECT_POST').default(DEFAULT_TIKTOK_OPTIONS.postMode),
    privacyLevel: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])
      .default(DEFAULT_TIKTOK_OPTIONS.privacyLevel),
  }).strict(),
]).default(DEFAULT_TIKTOK_OPTIONS);

export type TikTokPublishOptions = z.infer<typeof tiktokOptionsSchema>;
export type TikTokPublishInput = z.input<typeof tiktokOptionsSchema>;

export function validateTikTokOptions(value: unknown, hasTikTok: boolean): TikTokPublishOptions | undefined {
  if (!hasTikTok) {
    if (value !== undefined) throw new Error('tiktok settings require a selected TikTok account.');
    return undefined;
  }
  const parsed = tiktokOptionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid TikTok options. Use DIRECT_POST with a valid privacyLevel, or MEDIA_UPLOAD without privacyLevel for an inbox draft. Omitted direct-post options default to PUBLIC_TO_EVERYONE; invalid values never fall back to another mode or privacy.');
  }
  return parsed.data;
}