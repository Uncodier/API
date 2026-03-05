import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runGearAgentWorkflow } from '../workflow';

import { normalizePhoneForSearch, normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';

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
    
    const rawPhoneNumber = extractPhoneNumber(webhookData.From);
    const phoneNumber = normalizePhoneForStorage(rawPhoneNumber) || rawPhoneNumber;
    const businessPhoneNumber = extractPhoneNumber(webhookData.To);
    const messageContent = webhookData.Body;
    const messageSid = webhookData.MessageSid;
    const businessAccountId = webhookData.AccountSid || process.env.GEAR_TWILIO_ACCOUNT_SID;
    
    console.log(`📥 Procesando mensaje de Twilio WhatsApp (Gear) de ${phoneNumber} (raw: ${rawPhoneNumber}): ${messageContent.substring(0, 50)}...`);
    
    // 1. Identificar al usuario basado en el número de teléfono
    // Intenta encontrar el número en cualquiera de sus formatos usando el número crudo para mayor alcance
    const phoneVariants = normalizePhoneForSearch(rawPhoneNumber);
    
    // Llamamos a la función RPC segura para buscar en auth.users
    const { data: users, error: userError } = await supabaseAdmin
      .rpc('get_user_by_phone', { phone_variants: phoneVariants });

    if (userError) {
      console.error('❌ Error buscando usuario por teléfono vía RPC:', userError);
    }

    const user = users && users.length > 0 ? {
      id: users[0].id,
      metadata: users[0].raw_user_meta_data,
      phone: users[0].phone || users[0].raw_user_meta_data?.phone
    } : null;

    let siteId: string | null = null;
    let userId: string | null = null;
    let systemPromptOverride: string | undefined = undefined;

    if (user) {
      userId = user.id;
      
      // Obtener todos los sitios pertenecientes a este usuario
      const { data: userSites } = await supabaseAdmin
        .from('sites')
        .select('id, name')
        .eq('user_id', userId);

      // Si el usuario ya seleccionó un sitio activo
      if (user.metadata?.active_target_site_id) {
        // Validamos que el sitio seleccionado aún sea de su propiedad
        const isOwner = userSites?.some(s => s.id === user.metadata!.active_target_site_id);
        if (isOwner) {
          siteId = user.metadata.active_target_site_id;
          console.log(`✅ [Gear] Usando sitio activo seleccionado: ${siteId}`);
        }
      } 
      
      // Si no hay sitio activo seleccionado, determinamos basado en sus sitios disponibles
      if (!siteId && userSites && userSites.length > 0) {
        if (userSites.length === 1) {
          siteId = userSites[0].id;
          console.log(`✅ [Gear] Usando único sitio del usuario: ${siteId}`);
        } else if (userSites.length > 1) {
          // El usuario tiene varios sitios, debe elegir uno.
          siteId = userSites[0].id; 
          systemPromptOverride = "You are Makinari's Gear Assistant. The user has multiple projects but hasn't selected an active one. You MUST use the instance_project tool with action='list' to show them their projects and ask which one they want to manage. Do not perform any changes until they select a project.";
          console.log(`⚠️ [Gear] Usuario con múltiples sitios sin seleccionar. Forzando tool para elegir.`);
        }
      } else if (!siteId) {
        // El usuario está registrado pero no tiene ningún sitio creado
        systemPromptOverride = "You are Makinari's Gear Assistant. The user is registered but has no projects yet. Ask them if they want to create a new project.";
        console.log(`⚠️ [Gear] Usuario registrado sin sitios.`);
      }
    } else {
      // El usuario no está registrado en absoluto
      systemPromptOverride = `You are Makinari's Gear Assistant. The user with phone number ${phoneNumber} is NOT registered in Makinari. You MUST politely explain that their phone number is not linked to any Makinari account. If they already have an account, ask them to log in to the web app and link their phone number in their profile settings for security reasons. If they don't have an account, you can help them create one using the create_account tool. Explain briefly what Makinari is if they ask. Do not allow them to manage any sites or access ANY data until their phone is linked to an account. Tell them explicitly that you cannot provide any information without a linked account for security reasons. DO NOT under any circumstances return data from the database. NEVER execute tools that fetch data like get_leads, query_database, etc.`;
      console.log(`❌ [Gear] Número no registrado: ${phoneNumber}. Solicitando registro o vinculación de cuenta.`);
    }
    
    // Fallback: Intentar encontrar site_id por account_sid en los ajustes
    // SOLO si el usuario está registrado, permitimos el fallback de site
    if (userId && !siteId && businessAccountId) {
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

    // Fallback: Makinari por defecto (entorno)
    // SOLO usamos el fallback si vamos a interactuar con alguien no registrado para ofrecerle el registro
    if (!siteId && process.env.GEAR_SITE_ID) {
      siteId = process.env.GEAR_SITE_ID;
      console.log(`✅ [Gear] Usando site_id de Makinari (GEAR_SITE_ID) como contexto genérico: ${siteId}`);
    }
    
    // Fallback final: Buscar un sitio de Makinari por nombre
    if (!siteId) {
      const { data: siteByName } = await supabaseAdmin
        .from('sites')
        .select('id')
        .ilike('name', '%Makinari%')
        .limit(1)
        .maybeSingle();
        
      if (siteByName) {
        siteId = siteByName.id;
        console.log(`⚠️ [Gear] Usando site_id por nombre "Makinari" como contexto genérico: ${siteId}`);
      }
    }
    
    if (!siteId) {
      console.error('❌ No se pudo encontrar un site_id válido para inicializar el agente');
      return NextResponse.json({ success: true }); // Twilio siempre espera 200
    }
    
    // 2. Determinar el User ID para inicializar la instancia
    // Si el usuario no estaba registrado, usamos el user_id del dueño del sitio fallback (Makinari) 
    // pero marcamos fuertemente en el systemPrompt que NO le muestre información del owner
    if (!userId) {
      const { data: siteOwner } = await supabaseAdmin
        .from('sites')
        .select('user_id')
        .eq('id', siteId)
        .maybeSingle();
        
      if (siteOwner) {
        userId = siteOwner.user_id;
        console.log(`⚠️ Usando user_id del dueño del sitio de fallback solo como runner: ${userId}`);
      }
    }
    
    if (!userId) {
      console.error('❌ No se pudo encontrar un user_id válido para inicializar la instancia');
      return NextResponse.json({ success: true });
    }

    
    // Si tenemos systemPromptOverride y no incluimos esta advertencia, se la agregamos al final para mayor seguridad:
    if (systemPromptOverride && !systemPromptOverride.includes('NOT registered')) {
        systemPromptOverride += `\n\nIMPORTANT SECURITY RULE: You MUST ensure that you ONLY perform actions and fetch data for the site ID explicitly provided to you in the tools. The user is logged in securely.`;
    } else if (!systemPromptOverride) {
        systemPromptOverride = `IMPORTANT SECURITY RULE: You are interacting with an authenticated user for site ID ${siteId}. You MUST ensure you ONLY perform actions and fetch data for this site. Do not share global data or cross-site data.`;
    }
    
    // Añadimos instrucción de formato para WhatsApp
    systemPromptOverride += `\n\nIMPORTANT FORMATTING RULE: You are talking to a user via WhatsApp. You MUST format your responses using WhatsApp formatting: *bold*, _italic_, ~strikethrough~, and \`\`\`code\`\`\`. Avoid markdown headers like # and markdown links like [text](url). Use bullet points like - item.`;
    
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
      .neq('status', 'destroyed') // Find existing active instances (running, uninstantiated, etc.)
      .neq('status', 'deleted')
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
    
    // Validar si el agente no registrado está intentando usar el fallback de site_id para leer data
    // Si no tenemos un userId real, evitamos que tenga acceso a herramientas por seguridad
    const safeUseSdkTools = userId ? false : false; // Opcional: Podrías deshabilitar las tools si no hay userId, pero el prompt debería frenarlo. Dejar en false que es lo que tenías.
    
    await start(runGearAgentWorkflow, [{
      instanceId,
      message: messageContent,
      messageSid,
      siteId,
      userId,
      userPhone: rawPhoneNumber, // Mantenemos el número crudo para que Twilio pueda responder correctamente
      customTools: [],
      useSdkTools: false, // Puedes poner esto dinámico luego basado en si es admin o no.
      systemPrompt: systemPromptOverride
    }]);
    
    console.log('✅ Workflow iniciado');
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('❌ Error al procesar webhook de Twilio WhatsApp (Gear):', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
