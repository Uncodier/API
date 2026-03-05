import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runGearAgentWorkflow } from '../workflow';

// Helper para extraer número
function extractPhoneNumber(twilioPhoneFormat: string): string {
  return twilioPhoneFormat.replace('whatsapp:', '');
}

// ------------------------------------------------------------------------------------
// GET /api/agents/gear/whatsapp/webhook
// ------------------------------------------------------------------------------------
export async function GET() {
  // Twilio no requiere un challenge riguroso como Meta, pero responde con 200
  return new NextResponse('Gear Agent Twilio Webhook is running', { status: 200 });
}

// ------------------------------------------------------------------------------------
// POST /api/agents/gear/whatsapp/webhook
// Handle incoming Twilio messages
// ------------------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    console.log('📩 Webhook de Twilio WhatsApp (Gear) recibido');
    
    const contentType = request.headers.get('content-type') || '';
    let webhookData: any;
    
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      webhookData = Object.fromEntries(formData.entries());
    } else if (contentType.includes('application/json')) {
      webhookData = await request.json();
    } else {
      console.error('❌ Tipo de contenido no soportado:', contentType);
      return NextResponse.json({ success: false, error: 'Unsupported content type' }, { status: 400 });
    }
    
    // Validar payload de Twilio
    if (!webhookData.From || !webhookData.To || !webhookData.Body) {
      console.error('❌ Datos incompletos en el webhook de Twilio');
      return NextResponse.json({ success: false, error: 'Missing required webhook data' }, { status: 400 });
    }
    
    const phoneNumber = extractPhoneNumber(webhookData.From);
    const businessPhoneNumber = extractPhoneNumber(webhookData.To);
    const messageContent = webhookData.Body;
    const messageSid = webhookData.MessageSid;
    const businessAccountId = webhookData.AccountSid || process.env.GEAR_TWILIO_ACCOUNT_SID;
    
    console.log(`📥 Procesando mensaje de Twilio WhatsApp (Gear) de ${phoneNumber}: ${messageContent.substring(0, 50)}...`);
    
    // 1. Find Site ID
    let siteId: string | null = null;
    
    // El Gear Agent en Makinari opera respondiendo solicitudes para otros sitios (sus clientes)
    // Cuando entra un mensaje a este webhook, verificamos si el usuario ya nos ha dicho 
    // a qué sitio quiere interactuar (por ejemplo con un tool 'set_site' o un custom_data previo)
    
    // Primero, revisamos si el usuario (basado en su celular) ya tiene un sitio activo seleccionado en Makinari
    const { data: activeUser } = await supabaseAdmin
      .from('users')
      .select('id, custom_data')
      .contains('custom_data', { whatsapp_phone: phoneNumber })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Si el usuario tiene un "active_target_site_id" en sus custom_data, usamos ese para procesar
    if (activeUser && activeUser.custom_data?.active_target_site_id) {
      siteId = activeUser.custom_data.active_target_site_id;
      console.log(`✅ [Gear] Redirigiendo request al sitio cliente seleccionado por el usuario: ${siteId}`);
    } 
    
    // Try to find site by account_sid in settings
    if (!siteId && businessAccountId) {
      const { data: siteBySettings } = await supabaseAdmin
        .from('settings')
        .select('site_id')
        .contains('channels', { whatsapp: { account_sid: businessAccountId } })
        .limit(1)
        .maybeSingle();
        
      if (siteBySettings) {
        siteId = siteBySettings.site_id;
        console.log(`✅ [Gear] Encontrado site_id por account_sid: ${siteId}`);
      }
    }

    // Check if there's a specific GEAR_SITE_ID in env variables (Este es el id de MAKINARI por defecto)
    if (!siteId && process.env.GEAR_SITE_ID) {
      siteId = process.env.GEAR_SITE_ID;
      console.log(`✅ [Gear] Usando site_id de Makinari (GEAR_SITE_ID): ${siteId}`);
    }
    
    // Fallback: Find site by name "Makinari"
    if (!siteId) {
      const { data: siteByName } = await supabaseAdmin
        .from('sites')
        .select('id')
        .ilike('name', '%Makinari%')
        .limit(1)
        .maybeSingle();
        
      if (siteByName) {
        siteId = siteByName.id;
        console.log(`⚠️ [Gear] Usando site_id por nombre "Makinari": ${siteId}`);
      }
    }
    
    if (!siteId) {
      console.error('❌ No se pudo encontrar un site_id válido para el agente Gear');
      return NextResponse.json({ success: true }); // Twilio siempre espera 200
    }
    
    // 2. Find User ID based on Phone Number
    let userId: string | null = null;
    
    // El usuario final (cliente del cliente) es el visitor, pero la instancia le pertenece
    // al dueño del sitio cliente (o al dueño de Makinari).
    // NOTA: No usamos activeUser.id porque queremos que el asistente
    // corra en nombre del dueño del sitio, no del visitante.
    
    const { data: site } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', siteId)
      .maybeSingle();
      
    if (site) {
      userId = site.user_id; // Use site owner 
      console.log(`✅ Usando user_id del dueño del sitio: ${userId}`);
    } else {
      // En caso de que se use un active_target_site_id que ya no existe o que no tenga user_id
      // usamos el de Makinari/el de entorno por defecto
      const fallbackSiteId = process.env.GEAR_SITE_ID;
      if (fallbackSiteId && fallbackSiteId !== siteId) {
          const { data: fallbackSite } = await supabaseAdmin
            .from('sites')
            .select('user_id')
            .eq('id', fallbackSiteId)
            .maybeSingle();
          if (fallbackSite) {
             userId = fallbackSite.user_id;
             console.log(`⚠️ Usando user_id de Makinari como fallback: ${userId}`);
          }
      }
    }
    
    if (!userId) {
      console.error('❌ No se pudo encontrar un user_id válido');
      return NextResponse.json({ success: true });
    }
    
    // 3. Find/Create Instance
    let instanceId: string | null = null;
    
    // Necesitamos que cada visitante de un mismo sitio tenga su propia instancia
    // para que las conversaciones no se mezclen. Por lo tanto, agregamos el phoneNumber
    // para aislar la instancia.
    
    const instanceIdentifier = `Gear Assistant - ${phoneNumber}`;
    
    const { data: instances } = await supabaseAdmin
      .from('remote_instances')
      .select('id')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .eq('name', instanceIdentifier)
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1);
      
    if (instances && instances.length > 0) {
      instanceId = instances[0].id;
      console.log(`✅ Usando instancia existente para ${phoneNumber}: ${instanceId}`);
    } else {
      console.log(`🆕 Creando nueva instancia de Gear para el teléfono ${phoneNumber}`);
      const { data: newInstance } = await supabaseAdmin
        .from('remote_instances')
        .insert({
          site_id: siteId,
          user_id: userId,
          name: instanceIdentifier,
          instance_type: 'ubuntu',
          status: 'uninstantiated',
          created_by: userId
        })
        .select('id')
        .single();
        
      if (newInstance) {
        instanceId = newInstance.id;
        console.log(`✅ Nueva instancia creada: ${instanceId}`);
      }
    }
    
    if (!instanceId) {
      console.error('❌ No se pudo obtener/crear una instancia');
      return NextResponse.json({ success: true });
    }
    
    // 4. Trigger Workflow
    console.log(`🚀 Iniciando workflow GearAgent para ${phoneNumber}...`);
    
    await start(runGearAgentWorkflow, [{
      instanceId,
      message: messageContent,
      messageSid,
      siteId,
      userId,
      userPhone: phoneNumber,
      customTools: [],
      useSdkTools: false
    }]);
    
    console.log('✅ Workflow iniciado');
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('❌ Error al procesar webhook de Twilio WhatsApp (Gear):', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
