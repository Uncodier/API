import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { urlToSitemapCore } from './core';

export const maxDuration = 60; // 1 minute

const UrlToSitemapSchema = z.object({
  url: z.string().url('Invalid URL'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = UrlToSitemapSchema.parse(body);

    console.log(`[urlToSitemap] Processing URL: ${url}`);

    const data = await urlToSitemapCore(url);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('[urlToSitemap] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to extract sitemap',
      },
      { status: 500 }
    );
  }
}
