const PROMPT_IMAGE_HOST = 'backend.makinari.com';
const PROMPT_IMAGE_PREFIX = '/api/public/image/prompt/';

export function scopeCatalogPromptImageUrl(
  imageUrl: unknown,
  siteId: unknown,
): unknown {
  if (typeof imageUrl !== 'string' || typeof siteId !== 'string' || !siteId) {
    return imageUrl;
  }

  try {
    const parsed = new URL(imageUrl);
    if (
      parsed.hostname !== PROMPT_IMAGE_HOST
      || !parsed.pathname.startsWith(PROMPT_IMAGE_PREFIX)
      || parsed.searchParams.has('site_id')
    ) {
      return imageUrl;
    }
    parsed.searchParams.set('site_id', siteId);
    return parsed.toString();
  } catch {
    return imageUrl;
  }
}

export function scopeCatalogItemPromptImage<T extends Record<string, unknown>>(
  item: T,
): T {
  return {
    ...item,
    image_url: scopeCatalogPromptImageUrl(item.image_url, item.site_id),
  };
}
