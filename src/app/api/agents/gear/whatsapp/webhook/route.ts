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
    const businessAccountId = webhookData.AccountSid || process.env.GEAR_TWILIO_ACCOUNT_SID;
    
    console.log(`📥 Procesando mensaje de Twilio WhatsApp (Gear) de ${phoneNumber}: ${messageContent.substring(0, 50)}...`);
    
    // 1. Find Site ID
    let siteId: string | null = null;
    
    // Try to find site by account_sid in settings
    if (businessAccountId) {
      const { data: siteBySettings } = await supabaseAdmin
        .from('settings')
        .select('site_id')
        .contains('channels', { whatsapp: { account_sid: businessAccountId } })
        .maybeSingle();
        
      if (siteBySettings) {
        siteId = siteBySettings.site_id;
        console.log(`✅ Encontrado site_id por account_sid: ${siteId}`);
      }
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
        console.log(`⚠️ Usando site_id por nombre "Makinari": ${siteId}`);
      }
    }
    
    if (!siteId) {
      console.error('❌ No se pudo encontrar un site_id válido para el agente Gear');
      return NextResponse.json({ success: true }); // Twilio siempre espera 200
    }
    
    // 2. Find User ID based on Phone Number
    let userId: string | null = null;
    
    const { data: visitor } = await supabaseAdmin
      .from('visitors')
      .select('id, user_id')
      .contains('custom_data', { whatsapp_phone: phoneNumber })
      .maybeSingle();
      
    if (visitor && visitor.user_id) {
      userId = visitor.user_id;
    } else {
      const { data: site } = await supabaseAdmin
        .from('sites')
        .select('user_id')
        .eq('id', siteId)
        .single();
        
      if (site) {
        userId = site.user_id; // Use site owner as fallback
        console.log(`⚠️ Usando user_id del dueño del sitio: ${userId}`);
      }
    }
    
    if (!userId) {
      console.error('❌ No se pudo encontrar un user_id válido');
      return NextResponse.json({ success: true });
    }
    
    // 3. Find/Create Instance
    let instanceId: string | null = null;
    
    const { data: instances } = await supabaseAdmin
      .from('remote_instances')
      .select('id')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1);
      
    if (instances && instances.length > 0) {
      instanceId = instances[0].id;
      console.log(`✅ Usando instancia existente: ${instanceId}`);
    } else {
      console.log('🆕 Creando nueva instancia para Gear Agent');
      const { data: newInstance } = await supabaseAdmin
        .from('remote_instances')
        .insert({
          site_id: siteId,
          user_id: userId,
          name: 'Gear Assistant (WhatsApp)',
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
