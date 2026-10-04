import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getContentById, getContents, updateContent, type DbContent } from '@/lib/database/content-db';
import { getContentCore } from '../get/core';
import { updateContentCore } from '../update/core';
import { POST as getContent } from '../get/route';
import { POST as postContent, PUT as putContent } from '../update/route';

jest.mock('@/lib/database/content-db', () => ({
  getContentById: jest.fn(),
  getContents: jest.fn(),
  updateContent: jest.fn(),
}));

const siteId = randomUUID();
const contentId = randomUUID();
const content: DbContent = {
  id: contentId,
  site_id: siteId,
  title: 'Content contract',
  description: null,
  type: 'blog_post',
  status: 'draft',
  segment_id: null,
  author_id: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  published_at: null,
  tags: null,
  estimated_reading_time: null,
  word_count: null,
  seo_score: null,
  user_id: null,
  text: null,
  campaign_id: null,
  performance_rating: null,
  metadata: null,
  command_id: null,
  instructions: null,
};

function request(body: Record<string, unknown>, method = 'POST') {
  return new NextRequest('https://api.example.invalid/content', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getContentById).mockResolvedValue(content);
  jest.mocked(getContents).mockResolvedValue({ contents: [], total: 0, hasMore: false });
  jest.mocked(updateContent).mockResolvedValue(content);
});

describe('content core extraction contracts', () => {
  it('preserves arbitrary string filters and pagination defaults', async () => {
    const result = await getContentCore({ site_id: siteId, type: 'custom_type', status: 'custom_status' });

    expect(getContents).toHaveBeenCalledWith(expect.objectContaining({
      site_id: siteId,
      type: 'custom_type',
      status: 'custom_status',
      sort_by: 'created_at',
      sort_order: 'desc',
      limit: 50,
      offset: 0,
    }));
    expect(result).toEqual({
      success: true,
      data: { contents: [], pagination: { total: 0, count: 0, offset: 0, limit: 50, has_more: false } },
    });
  });

  it('preserves single-content lookup shape and site ownership checks', async () => {
    await expect(getContentCore({ site_id: siteId, content_id: contentId })).resolves.toEqual({
      success: true, data: { content, pagination: null },
    });
    await expect(getContentCore({ site_id: randomUUID(), content_id: contentId }))
      .rejects.toThrow('No tienes permiso para ver este contenido');
    expect(getContents).not.toHaveBeenCalled();
  });

  it('forwards explicit nulls to clear content relationships and publication time', async () => {
    await expect(updateContentCore({
      site_id: siteId, content_id: contentId,
      segment_id: null, campaign_id: null, published_at: null,
    })).resolves.toEqual(content);
    expect(updateContent).toHaveBeenCalledWith(contentId, {
      segment_id: null, campaign_id: null, published_at: null,
    });
  });

  it('does not turn omitted relationship fields into clears', async () => {
    await updateContentCore({ site_id: siteId, content_id: contentId, title: 'Updated' });
    expect(updateContent).toHaveBeenCalledWith(contentId, { title: 'Updated' });
  });

  it('rejects cross-site updates before writing', async () => {
    await expect(updateContentCore({ site_id: randomUUID(), content_id: contentId, title: 'Updated' }))
      .rejects.toThrow('No tienes permiso para actualizar este contenido');
    expect(updateContent).not.toHaveBeenCalled();
  });

  it.each([['POST', postContent], ['PUT', putContent]] as const)(
    'preserves the %s update HTTP response',
    async (method, handler) => {
      const response = await handler(request({ site_id: siteId, content_id: contentId, segment_id: null }, method));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, content });
      expect(updateContent).toHaveBeenCalledWith(contentId, { segment_id: null });
    },
  );

  it('preserves validation failures and avoids database access for invalid get requests', async () => {
    const response = await getContent(request({ site_id: 'not-a-uuid' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Invalid filters',
      details: [{ code: 'invalid_string', message: 'Site ID is required', path: ['site_id'], validation: 'uuid' }],
    });
    expect(getContentById).not.toHaveBeenCalled();
    expect(getContents).not.toHaveBeenCalled();
  });
});