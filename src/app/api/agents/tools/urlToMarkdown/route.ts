import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { urlToMarkdownCore } from './core';

export const maxDuration = 60; // 1 minute

const UrlToMarkdownSchema = z.object({
  url: z.string().url('Invalid URL'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = UrlToMarkdownSchema.parse(body);

    console.log(`[urlToMarkdown] Processing URL: ${url}`);

    const data = await urlToMarkdownCore(url);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('[urlToMarkdown] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to convert URL to Markdown',
      },
      { status: 500 }
    );
  }
}
