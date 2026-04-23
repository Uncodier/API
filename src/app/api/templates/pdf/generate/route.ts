import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const maxDuration = 60; // Max execution time in seconds for Vercel
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const data = await req.json();
    const { html, payload, filename = 'document.pdf' } = data;

    let finalHtml = html || '';

    // If payload is provided, replace placeholders
    if (finalHtml && payload) {
      for (const [key, value] of Object.entries(payload)) {
        finalHtml = finalHtml.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
      }
    }

    if (!finalHtml) {
      return NextResponse.json({ error: 'Missing HTML content.' }, { status: 400 });
    }

    // Launch Puppeteer via sparticuz
    const isDev = process.env.NODE_ENV === 'development';
    const executablePath = isDev 
      ? '/usr/bin/google-chrome' // or another local path, fallback
      : await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: isDev ? [] : chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath || undefined,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(finalHtml, { waitUntil: 'networkidle0' });

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        bottom: '20px',
        left: '20px',
        right: '20px',
      },
    });

    await browser.close();

    // Upload to Supabase Storage
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Supabase credentials missing' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const bucket = 'documents';
    const uniqueId = crypto.randomUUID();
    const filePath = `pdfs/${uniqueId}-${filename}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, pdfBuffer, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      return NextResponse.json({ error: 'Failed to upload to Supabase', details: uploadError }, { status: 500 });
    }

    const { data: publicUrlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(filePath);

    return NextResponse.json({
      success: true,
      url: publicUrlData.publicUrl,
      path: filePath
    });
  } catch (error: any) {
    console.error('PDF Generation Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
