import { describe, expect, it } from '@jest/globals';
import {
  scopeCatalogItemPromptImage,
  scopeCatalogPromptImageUrl,
} from '../catalog-prompt-image-url';

describe('catalog prompt image URLs', () => {
  it('adds the catalog site to Makinari prompt image URLs', () => {
    expect(scopeCatalogPromptImageUrl(
      'https://backend.makinari.com/api/public/image/prompt/a%20burger?width=400&height=400',
      'site-id',
    )).toBe(
      'https://backend.makinari.com/api/public/image/prompt/a%20burger?width=400&height=400&site_id=site-id',
    );
  });

  it('preserves existing site scoping and unrelated URLs', () => {
    const scoped =
      'https://backend.makinari.com/api/public/image/prompt/a?site_id=site-id';
    expect(scopeCatalogPromptImageUrl(scoped, 'other-site')).toBe(scoped);
    expect(scopeCatalogPromptImageUrl(
      'https://cdn.example.com/product.jpg',
      'site-id',
    )).toBe('https://cdn.example.com/product.jpg');
  });

  it('scopes catalog response items without mutating the source', () => {
    const item = {
      id: 'item-id',
      site_id: 'site-id',
      image_url: 'https://backend.makinari.com/api/public/image/prompt/a',
    };

    const result = scopeCatalogItemPromptImage(item);

    expect(result.image_url).toBe(
      'https://backend.makinari.com/api/public/image/prompt/a?site_id=site-id',
    );
    expect(item.image_url).not.toContain('site_id');
  });
});
