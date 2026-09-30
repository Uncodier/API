import { z } from 'zod';

export const tiktokOptionsSchema = z.discriminatedUnion('postMode', [
  z.object({ postMode: z.literal('MEDIA_UPLOAD') }).strict(),
  z.object({
    postMode: z.literal('DIRECT_POST'),
    privacyLevel: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']),
  }).strict(),
]);

export type TikTokPublishOptions = z.infer<typeof tiktokOptionsSchema>;

export function validateTikTokOptions(value: unknown, hasTikTok: boolean): TikTokPublishOptions | undefined {
  if (!hasTikTok) {
    if (value !== undefined) throw new Error('tiktok settings require a selected TikTok account.');
    return undefined;
  }
  const parsed = tiktokOptionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('TikTok requires an explicit tiktok.postMode: DIRECT_POST with the creator-selected privacyLevel, or MEDIA_UPLOAD for an inbox draft. Never guess privacy or silently switch modes.');
  }
  return parsed.data;
}