import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function isDuplicateStorageObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    statusCode?: string | number;
    error?: string;
    message?: string;
  };
  return String(value.statusCode) === '409'
    || value.error === 'Duplicate'
    || /already exists|duplicate/i.test(value.message || '');
}

/**
 * API DE GRABACIÓN DE SESIÓN (RRWEB)
 * 
 * Recibe chunks de eventos de rrweb y los guarda de forma eficiente en Supabase Storage
 * para no sobrecargar la base de datos PostgreSQL.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Validar payload mínimo
    if (!body.site_id || !body.session_id || !body.events || !Array.isArray(body.events)) {
      return NextResponse.json({ success: false, error: 'Payload inválido o incompleto' }, { status: 400 });
    }

    const { site_id, session_id, visitor_id, events, metadata } = body;
    
    // Si no hay eventos, no hacemos nada
    if (events.length === 0) {
      return NextResponse.json({ success: true, message: 'No events to save' });
    }

    // Reuse the client-generated identifiers so retries are idempotent.
    const chunkId =
      typeof body.chunk_id === 'string' && UUID_PATTERN.test(body.chunk_id)
        ? body.chunk_id
        : uuidv4();
    const timestamp = finiteTimestamp(body.chunk_timestamp, Date.now());
    
    // Convertir eventos a string
    const eventsJson = JSON.stringify(events);
    const contentHash = createHash('sha256').update(eventsJson).digest('hex');

    // Content-addressed paths make accepted chunks immutable. Reusing a chunk
    // ID with different events produces a conflict in the metadata RPC.
    const storagePath =
      `${site_id}/${session_id}/${timestamp}_${chunkId}_${contentHash}.json`;
    
    // 1. Guardar el payload pesado en Supabase Storage
    const { error: storageError } = await supabaseAdmin
      .storage
      .from('session_recordings')
      .upload(storagePath, eventsJson, {
        contentType: 'application/json',
        upsert: false
      });

    if (storageError && !isDuplicateStorageObject(storageError)) {
      console.error('[Session Recording] Error guardando en Storage:', storageError);
      throw storageError;
    }

    // Persist metadata atomically so concurrent chunks cannot overwrite each
    // other or create additional recording rows for the same session.
    const startTimestamp = finiteTimestamp(events[0]?.timestamp, timestamp);
    const endTimestamp = finiteTimestamp(
      events[events.length - 1]?.timestamp,
      timestamp,
    );
    const { data: recording, error: recordingError } = await supabaseAdmin.rpc(
      'append_session_recording_chunk',
      {
        p_event_id: uuidv4(),
        p_site_id: site_id,
        p_visitor_id:
          typeof visitor_id === 'string' && UUID_PATTERN.test(visitor_id)
            ? visitor_id
            : null,
        p_session_id: session_id,
        p_url: typeof body.url === 'string' ? body.url : null,
        p_timestamp: timestamp,
        p_storage_path: storagePath,
        p_chunk_id: chunkId,
        p_content_hash: contentHash,
        p_start_timestamp: startTimestamp,
        p_end_timestamp: endTimestamp,
        p_event_count: events.length,
        p_metadata:
          metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata
            : {},
      },
    );

    if (recordingError) {
      console.error(
        '[Session Recording] Error persisting chunk metadata:',
        recordingError,
      );
      throw recordingError;
    }

    return NextResponse.json({
      success: true,
      chunk_id: chunkId,
      path: storagePath,
      recording,
    });
    
  } catch (error: any) {
    console.error('[Session Recording] Error no manejado:', error);
    return NextResponse.json(
      { success: false, error: 'Error interno del servidor', details: error.message },
      { status: 500 }
    );
  }
}
