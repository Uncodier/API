import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'

/**
 * API DE TRACKING DE VISITANTES
 * 
 * Esta API permite registrar eventos de visitantes en el sitio web, incluyendo:
 * - Pageviews
 * - Clics
 * - Eventos personalizados
 * - Compras
 * - Acciones
 * - Movimientos del mouse
 * - Scroll
 * - Teclado
 * - Redimensionamiento
 * - Foco/blur
 * - Formularios
 * - Rendimiento
 * - Errores
 * - Grabación de sesión
 * 
 * Documentación completa: /docs/api/visitors/track
 */

// Base schema for common properties
const baseEventSchema = z.object({
  site_id: z.string(),
  url: z.string().url(),
  referrer: z.string().url().optional(),
  id: z.string().optional(),
  visitor_id: z.string().optional(),
  session_id: z.string().uuid().optional(),
  timestamp: z.number().optional(),
  user_agent: z.string().optional(),
  ip: z.string().optional(),
  properties: z.record(z.any()).optional()
});

// Specific event schemas
const clickEventSchema = baseEventSchema.extend({
  event_type: z.literal('click'),
  properties: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    element: z.object({
      tag: z.string().optional(),
      class: z.string().optional(),
      id: z.string().optional(),
      text: z.string().optional()
    }).optional()
  }).optional()
});

const customEventSchema = baseEventSchema.extend({
  event_type: z.literal('custom'),
  event_name: z.string(),
  properties: z.record(z.any()).optional()
});

const purchaseEventSchema = baseEventSchema.extend({
  event_type: z.literal('purchase'),
  properties: z.object({
    order_id: z.string(),
    total_amount: z.number(),
    currency: z.string(),
    payment_method: z.string(),
    items: z.array(z.object({
      product_id: z.string(),
      product_name: z.string(),
      price: z.number(),
      quantity: z.number()
    }))
  })
});

const actionEventSchema = baseEventSchema.extend({
  event_type: z.literal('action'),
  event_name: z.string(),
  properties: z.record(z.any()).optional()
});

const mouseMoveEventSchema = baseEventSchema.extend({
  event_type: z.literal('mousemove'),
  properties: z.object({
    x: z.number(),
    y: z.number(),
    viewport: z.object({
      width: z.number(),
      height: z.number()
    }).optional(),
    element: z.object({
      tag: z.string().optional(),
      class: z.string().optional(),
      id: z.string().optional(),
      text: z.string().optional()
    }).optional()
  })
});

const scrollEventSchema = baseEventSchema.extend({
  event_type: z.literal('scroll'),
  properties: z.object({
    scroll_x: z.number(),
    scroll_y: z.number(),
    max_scroll: z.number(),
    viewport_height: z.number(),
    document_height: z.number(),
    percentage_scrolled: z.number()
  })
});

const keyPressEventSchema = baseEventSchema.extend({
  event_type: z.literal('keypress'),
  properties: z.object({
    key: z.string(),
    key_code: z.number(),
    element: z.object({
      tag: z.string().optional(),
      type: z.string().optional(),
      name: z.string().optional()
    }).optional(),
    is_sensitive: z.boolean().optional()
  })
});

const resizeEventSchema = baseEventSchema.extend({
  event_type: z.literal('resize'),
  properties: z.object({
    width: z.number(),
    height: z.number(),
    previous_width: z.number().optional(),
    previous_height: z.number().optional(),
    orientation: z.string().optional()
  })
});

const focusEventSchema = baseEventSchema.extend({
  event_type: z.literal('focus'),
  properties: z.object({
    element: z.object({
      tag: z.string().optional(),
      type: z.string().optional(),
      name: z.string().optional(),
      placeholder: z.string().optional()
    }).optional(),
    focus_duration: z.number().optional()
  })
});

const formEventSchema = baseEventSchema.extend({
  event_type: z.enum(['form_submit', 'form_change', 'form_error']),
  properties: z.object({
    form_id: z.string(),
    form_name: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      filled: z.boolean()
    })).optional(),
    completion_time: z.number().optional(),
    success: z.boolean().optional()
  })
});

const performanceEventSchema = baseEventSchema.extend({
  event_type: z.literal('performance'),
  properties: z.object({
    navigation: z.object({
      load_time: z.number(),
      dom_content_loaded: z.number(),
      first_paint: z.number(),
      first_contentful_paint: z.number()
    }).optional(),
    resources: z.object({
      total: z.number(),
      images: z.number(),
      scripts: z.number(),
      stylesheets: z.number(),
      fonts: z.number()
    }).optional(),
    memory: z.object({
      used: z.number(),
      total: z.number()
    }).optional()
  })
});

const errorEventSchema = baseEventSchema.extend({
  event_type: z.literal('error'),
  properties: z.object({
    error_type: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    filename: z.string().optional(),
    line_number: z.number().optional(),
    column_number: z.number().optional(),
    browser: z.string().optional(),
    browser_version: z.string().optional()
  })
});

const sessionRecordingEventSchema = baseEventSchema.extend({
  event_type: z.literal('session_recording'),
  properties: z.object({
    recording_id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    duration: z.number(),
    events: z.array(z.any()),
    metadata: z.object({
      screen_size: z.string(),
      browser: z.string(),
      browser_version: z.string(),
      os: z.string(),
      device_type: z.string()
    })
  })
});

// Union of all event schemas
const requestSchema = z.discriminatedUnion('event_type', [
  baseEventSchema.extend({ event_type: z.literal('pageview') }),
  clickEventSchema,
  customEventSchema,
  purchaseEventSchema,
  actionEventSchema,
  mouseMoveEventSchema,
  scrollEventSchema,
  keyPressEventSchema,
  resizeEventSchema,
  focusEventSchema,
  formEventSchema,
  performanceEventSchema,
  errorEventSchema,
  sessionRecordingEventSchema
]);

// Función para validar y preparar datos para la base de datos
function validateAndPrepareEventData(eventData: any, eventId: string) {
  try {
    // Validar que los campos requeridos estén presentes
    if (!eventData.site_id || !eventData.event_type || !eventData.url) {
      return {
        valid: false,
        error: 'Faltan campos requeridos'
      };
    }

    // Preparar datos para la inserción
    const preparedData = {
      id: eventId,
      site_id: eventData.site_id,
      event_type: eventData.event_type,
      event_name: eventData.event_name || null,
      url: eventData.url,
      referrer: eventData.referrer || null,
      visitor_id: eventData.visitor_id || eventData.id || null,
      session_id: eventData.session_id || null,
      timestamp: eventData.timestamp || Date.now(),
      properties: eventData.properties || {},
      user_agent: eventData.user_agent || null,
      ip: eventData.ip || null,
      data: eventData
    };

    return {
      valid: true,
      data: preparedData
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
  }
}

// Función auxiliar para respuestas de error
function errorResponse(message: string, status: number, details?: any) {
  return NextResponse.json(
    {
      success: false,
      error: {
        message,
        details
      }
    },
    { status }
  );
}

export async function POST(request: NextRequest) {
  console.log("[POST /api/visitors/track] Iniciando solicitud POST");
  try {
    // Get request body
    const body = await request.json();
    console.log(`[POST /api/visitors/track] Cuerpo recibido:`, body);
    
    // Validate request body
    const validationResult = requestSchema.safeParse(body);
    
    if (!validationResult.success) {
      console.log(`[POST /api/visitors/track] Error de validación:`, validationResult.error.format());
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const eventData = validationResult.data;
    console.log(`[POST /api/visitors/track] Datos validados:`, eventData);
    
    // Get client IP and user agent from headers
    const headers = request.headers;
    const ip = headers.get('x-forwarded-for') || headers.get('x-real-ip') || eventData.ip;
    const userAgent = headers.get('user-agent') || eventData.user_agent;
    
    // Generate event ID
    const eventId = uuidv4();
    
    // Determinar el visitor_id (dar prioridad al visitor_id explícito, luego al id)
    const visitorId = eventData.visitor_id || eventData.id;

    // Check if session exists
    if (eventData.session_id) {
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('visitor_sessions')
        .select('id')
        .eq('id', eventData.session_id)
        .single();

      if (sessionError || !session) {
        console.log(`[POST /api/visitors/track] Sesión no encontrada, creando nueva sesión...`);
        
        // Create new session
        const newSession = {
          id: eventData.session_id,
          visitor_id: visitorId,
          site_id: eventData.site_id,
          landing_url: eventData.url,
          current_url: eventData.url,
          referrer: eventData.referrer,
          started_at: eventData.timestamp || Date.now(),
          last_activity_at: eventData.timestamp || Date.now(),
          page_views: 1,
          is_active: true
        };

        const { error: createSessionError } = await supabaseAdmin
          .from('visitor_sessions')
          .insert([newSession]);

        if (createSessionError) {
          console.error(`[POST /api/visitors/track] Error al crear sesión:`, createSessionError);
          return errorResponse('Error al crear sesión', 500, createSessionError);
        }
      }
    }
    
    // Prepare data for database
    const dbData = {
      id: eventId,
      site_id: eventData.site_id,
      event_type: eventData.event_type,
      event_name: 'event_name' in eventData ? eventData.event_name : null,
      url: eventData.url,
      referrer: eventData.referrer,
      visitor_id: visitorId,
      session_id: eventData.session_id,
      timestamp: eventData.timestamp || Date.now(),
      properties: eventData.properties || {},
      user_agent: userAgent,
      ip: ip,
      data: {
        ...eventData,
        timestamp: eventData.timestamp || Date.now(),
        user_agent: userAgent,
        ip: ip
      }
    };
    
    // Get visitor's lead_id if available
    const { data: visitorData, error: visitorError } = visitorId ? await supabaseAdmin
      .from('visitors')
      .select('lead_id')
      .eq('id', visitorId)
      .single() : { data: null, error: null };

    // Insert event into database
    const { data, error } = await supabaseAdmin
      .from('session_events')
      .insert([dbData])
      .select()
      .single();
    
    if (error) {
      console.error(`[POST /api/visitors/track] Error al insertar evento:`, error);
      return errorResponse('Error al registrar el evento', 500, error);
    }
    
    console.log(`[POST /api/visitors/track] Evento registrado exitosamente:`, data);
    
    return NextResponse.json({
      success: true,
      event_id: data.id,
      visitor_id: visitorId,
      lead_id: visitorData?.lead_id || null,
      session_id: eventData.session_id,
      timestamp: data.timestamp
    });
    
  } catch (error: any) {
    console.error(`[POST /api/visitors/track] Error no manejado:`, error);
    return errorResponse('Error interno del servidor', 500, error.message);
  }
}