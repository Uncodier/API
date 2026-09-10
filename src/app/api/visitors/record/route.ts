import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

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

    // Generar un ID único para este chunk
    const chunkId = uuidv4();
    const timestamp = Date.now();
    
    // Ruta en el storage: session_recordings/site_id/session_id/chunk_id.json
    const storagePath = `${site_id}/${session_id}/${timestamp}_${chunkId}.json`;
    
    // Convertir eventos a string
    const eventsJson = JSON.stringify(events);
    
    // 1. Guardar el payload pesado en Supabase Storage
    const { error: storageError } = await supabaseAdmin
      .storage
      .from('session_recordings')
      .upload(storagePath, eventsJson, {
        contentType: 'application/json',
        upsert: false
      });

    if (storageError) {
      // Si el bucket no existe o hay otro error, podríamos querer crearlo o manejarlo de otra forma.
      console.error('[Session Recording] Error guardando en Storage:', storageError);
      
      // Intentar crear el bucket si el error es "Bucket not found"
      if (storageError.message.includes('Bucket not found') || storageError.name === 'BucketNotFound') {
        await supabaseAdmin.storage.createBucket('session_recordings', { public: false });
        
        // Reintentar
        const { error: retryError } = await supabaseAdmin.storage.from('session_recordings').upload(storagePath, eventsJson, {
          contentType: 'application/json',
          upsert: false
        });
        
        if (retryError) throw retryError;
      } else {
        throw storageError;
      }
    }

    // 2. Registrar/Actualizar Metadata en session_events (PostgreSQL)
    // Extraer timestamps de los eventos para calcular duración
    const startTimestamp = events[0]?.timestamp || timestamp;
    const endTimestamp = events[events.length - 1]?.timestamp || timestamp;
    
    // Primero, buscar si ya existe un registro de grabación para esta sesión
    const { data: existingRecord, error: searchError } = await supabaseAdmin
      .from('session_events')
      .select('id, properties')
      .eq('session_id', session_id)
      .eq('event_type', 'session_recording')
      .single();
      
    if (searchError && searchError.code !== 'PGRST116') { // PGRST116 es "no rows returned"
      console.error('[Session Recording] Error buscando evento previo:', searchError);
    }

    if (existingRecord) {
      // Actualizar registro existente
      const prevProps = existingRecord.properties || {};
      const chunks = prevProps.chunks || [];
      chunks.push(storagePath);
      
      const newDuration = (prevProps.duration || 0) + (endTimestamp - startTimestamp);
      const totalEvents = (prevProps.total_events || 0) + events.length;

      await supabaseAdmin
        .from('session_events')
        .update({
          timestamp: timestamp, // Última actualización
          properties: {
            ...prevProps,
            chunks,
            end_time: endTimestamp,
            duration: newDuration,
            total_events: totalEvents,
            last_chunk_at: timestamp
          }
        })
        .eq('id', existingRecord.id);
        
    } else {
      // Crear nuevo registro de grabación
      const eventId = uuidv4();
      
      const dbData = {
        id: eventId,
        site_id,
        visitor_id: visitor_id || null,
        session_id,
        event_type: 'session_recording',
        url: body.url || null,
        timestamp,
        properties: {
          start_time: startTimestamp,
          end_time: endTimestamp,
          duration: endTimestamp - startTimestamp,
          total_events: events.length,
          chunks: [storagePath],
          metadata: metadata || {}
        }
      };

      await supabaseAdmin
        .from('session_events')
        .insert([dbData]);
    }

    return NextResponse.json({ success: true, chunk_id: chunkId, path: storagePath });
    
  } catch (error: any) {
    console.error('[Session Recording] Error no manejado:', error);
    return NextResponse.json(
      { success: false, error: 'Error interno del servidor', details: error.message },
      { status: 500 }
    );
  }
}
