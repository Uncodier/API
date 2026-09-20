import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

const getContents = jest.fn();
const resolvePublicSiteContext = jest.fn();
const hasExplicitPublicSiteContext = jest.fn(() => false);

jest.mock('@/lib/database/content-db', () => ({
  CONTENT_TYPES: ['blog_post', 'video'],
  getContents,
}));
jest.mock('@/lib/security/public-site-context', () => ({
  resolvePublicSiteContext,
  hasExplicitPublicSiteContext,
}));

import { createPublicContentGet } from '../public-content-route';

describe('public content route', () => {
  beforeEach(() => {
    getContents.mockReset();
    resolvePublicSiteContext.mockReset();
    (resolvePublicSiteContext as any).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Example',
      url: 'https://example.com',
      description: null,
    });
  });

  it('clamps pagination and strips internal fields', async () => {
    (getContents as any).mockResolvedValue({
      contents: [{
        id: 'content-id',
        title: 'Public title',
        user_id: 'private-user',
        command_id: 'private-command',
        instructions: 'private instructions',
      }],
      total: 1,
      hasMore: false,
    });
    const response = await createPublicContentGet('blog_post')(
      new NextRequest(
        'https://api.example/api/public/posts?limit=9999&offset=999999',
      ),
    );
    const body = await response.json();

    expect(getContents).toHaveBeenCalledWith(expect.objectContaining({
      limit: 100,
      offset: 10_000,
      status: 'published',
      type: 'blog_post',
      exact_count: false,
      full_text_search: true,
      public_projection: true,
    }));
    expect(body.data[0]).toMatchObject({
      id: 'content-id',
      title: 'Public title',
    });
    expect(body.data[0]).not.toHaveProperty('user_id');
    expect(body.data[0]).not.toHaveProperty('instructions');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects arbitrary content types', async () => {
    const response = await createPublicContentGet()(
      new NextRequest(
        'https://api.example/api/public/content?type=private_internal',
      ),
    );

    expect(response.status).toBe(400);
    expect(getContents).not.toHaveBeenCalled();
  });

  it('uses the bounded default page size when limit is omitted', async () => {
    (getContents as any).mockResolvedValue({
      contents: [],
      total: 0,
      hasMore: false,
    });

    await createPublicContentGet('video')(
      new NextRequest('https://api.example/api/public/videos'),
    );

    expect(getContents).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      offset: 0,
    }));
  });

  it.each([
    ['posts', 'blog_post'],
    ['podcasts', 'podcast'],
    ['videos', 'video'],
    ['ads', 'ad'],
    ['landing-pages', 'landing_page'],
    ['whitepapers', 'whitepaper'],
    ['social-posts', 'social_post'],
    ['newsletters', 'newsletter'],
    ['case-studies', 'case_study'],
    ['ebooks', 'ebook'],
    ['infographics', 'infographic'],
    ['webinars', 'webinar'],
  ])('maps /public/%s to %s', (routeName, type) => {
    const route = readFileSync(
      resolve(process.cwd(), `src/app/api/public/${routeName}/route.ts`),
      'utf8',
    );
    expect(route).toContain(`createPublicContentGet('${type}')`);
  });
});
