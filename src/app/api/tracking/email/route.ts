import { NextRequest, NextResponse } from 'next/server';
import { EmailTrackingService } from '@/lib/services/tracking/EmailTrackingService';

/**
 * Endpoint para rastreo de correos (aperturas y clics)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const messageId = searchParams.get('m');
  const action = searchParams.get('a'); // 'open' o 'click'
  const targetUrl = searchParams.get('url');

  if (!messageId) {
    return new NextResponse('Missing message ID', { status: 400 });
  }

  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '';
  const ua = request.headers.get('user-agent') || '';

  const metadata = { ip, ua };

  // Ejecutar tracking en background para no bloquear la respuesta
  if (action === 'open') {
    // Retornar pixel de 1x1 transparente
    const pixel = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64'
    );
    
    // El tracking se hace de forma asíncrona
    EmailTrackingService.trackOpen(messageId, metadata).catch(err => {
      console.error('[TrackingAPI] Error tracking open:', err);
    });

    return new NextResponse(pixel, {
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  }

  if (action === 'click' && targetUrl) {
    // El tracking se hace de forma asíncrona
    EmailTrackingService.trackClick(messageId, targetUrl, metadata).catch(err => {
      console.error('[TrackingAPI] Error tracking click:', err);
    });

    // Redirigir al URL original
    return NextResponse.redirect(new URL(targetUrl));
  }

  return new NextResponse('Invalid action', { status: 400 });
}
