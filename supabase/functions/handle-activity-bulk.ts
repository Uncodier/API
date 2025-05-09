import { createClient } from '@supabase/supabase-js';

interface ActivityEvent {
  type: string;
  x: number;
  y: number;
  timestamp: number;
  [key: string]: any; // Allow for additional properties based on event type
}

interface SessionRecordingEvent {
  site_id: string;
  visitor_id: string;
  session_id: string;
  url: string;
  timestamp: number;
  properties: {
    recording_id: string;
    start_time: number;
    end_time: number;
    duration: number;
    events: ActivityEvent[];
    activity: ActivityEvent[];
    metadata?: {
      screen_size?: string;
      browser?: string;
      browser_version?: string;
      os?: string;
      device_type?: string;
    }
  };
}

// Esta función se ejecuta en el servidor de Supabase para procesar eventos de grabación de sesión
export async function handleSessionRecordingEvent(event: SessionRecordingEvent) {
  // Crear cliente Supabase
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  );

  // Crear un nuevo registro en la tabla session_events para el evento de grabación
  const { data, error } = await supabaseAdmin
    .from('session_events')
    .insert({
      site_id: event.site_id,
      visitor_id: event.visitor_id,
      session_id: event.session_id,
      event_type: 'session_recording',
      url: event.url,
      timestamp: new Date(event.timestamp),
      properties: {
        recording_id: event.properties.recording_id,
        start_time: event.properties.start_time,
        end_time: event.properties.end_time,
        duration: event.properties.duration,
        metadata: event.properties.metadata || {}
      }, 
      activity: event.properties.activity // Guardar los eventos completos en la columna activity
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error al insertar evento session_recording:', error);
    throw error;
  }

  // Procesar los eventos y calcular métricas por tipo de evento
  const activityMetrics = {
    event_count: event.properties.activity.length,
    first_timestamp: Math.min(...event.properties.activity.map(e => e.timestamp)),
    last_timestamp: Math.max(...event.properties.activity.map(e => e.timestamp)),
    event_types: calculateEventTypes(event.properties.activity),
    interactions: calculateInteractions(event.properties.activity)
  };

  // Actualizar el registro con las métricas calculadas
  const { error: updateError } = await supabaseAdmin
    .from('session_events')
    .update({
      properties: {
        ...event.properties,
        metrics: activityMetrics
      }
    })
    .eq('id', data.id);

  if (updateError) {
    console.error('Error al actualizar métricas de grabación:', updateError);
    // No lanzamos error aquí para no interrumpir el flujo
  }

  return { success: true, event_id: data.id, recording_id: event.properties.recording_id };
}

// Calcular conteo por tipo de evento
function calculateEventTypes(activities: ActivityEvent[]): Record<string, number> {
  return activities.reduce((acc, event) => {
    const type = event.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

// Calcular métricas de interacción
function calculateInteractions(activities: ActivityEvent[]): Record<string, any> {
  const interactions: Record<string, any> = {
    clicks: [],
    mousemoves: [],
    scrolls: [],
    keypresses: [],
    forms: []
  };

  // Agrupar eventos por tipo para análisis
  activities.forEach(event => {
    switch (event.type) {
      case 'click':
        interactions.clicks.push({
          x: event.x,
          y: event.y,
          timestamp: event.timestamp,
          element: event.element
        });
        break;
      case 'mousemove':
        // Solo guardamos cada 10 eventos de mousemove para no saturar
        if (interactions.mousemoves.length % 10 === 0) {
          interactions.mousemoves.push({
            x: event.x,
            y: event.y,
            timestamp: event.timestamp
          });
        }
        break;
      case 'scroll':
        interactions.scrolls.push({
          y: event.y,
          percentage_scrolled: event.percentage_scrolled,
          timestamp: event.timestamp
        });
        break;
      case 'keypress':
        interactions.keypresses.push({
          key: event.key,
          timestamp: event.timestamp,
          element: event.element
        });
        break;
      case 'form_change':
      case 'form_submit':
        interactions.forms.push({
          form_id: event.form_id,
          form_name: event.form_name,
          timestamp: event.timestamp,
          field_name: event.field_name,
          field_type: event.field_type
        });
        break;
    }
  });

  // Calcular métricas adicionales
  interactions.click_count = interactions.clicks.length;
  interactions.scroll_max = Math.max(...interactions.scrolls.map((s: { percentage_scrolled?: number }) => s.percentage_scrolled || 0), 0);
  interactions.duration = calculateSessionDuration(activities);
  interactions.average_time_between_events = calculateAverageTimeBetweenEvents(activities);

  return interactions;
}

// Calcular duración de la sesión
function calculateSessionDuration(activities: ActivityEvent[]): number {
  if (activities.length < 2) return 0;
  
  const timestamps = activities.map(a => a.timestamp).sort((a, b) => a - b);
  return timestamps[timestamps.length - 1] - timestamps[0];
}

// Calcular tiempo promedio entre eventos
function calculateAverageTimeBetweenEvents(activities: ActivityEvent[]): number {
  if (activities.length < 2) return 0;
  
  const timestamps = activities.map(a => a.timestamp).sort((a, b) => a - b);
  let totalTimeBetween = 0;
  
  for (let i = 1; i < timestamps.length; i++) {
    const timeBetween = timestamps[i] - timestamps[i-1];
    // Solo considerar tiempos menores a 30 segundos para excluir inactividad
    if (timeBetween < 30000) {
      totalTimeBetween += timeBetween;
    }
  }
  
  return totalTimeBetween / (timestamps.length - 1);
} 