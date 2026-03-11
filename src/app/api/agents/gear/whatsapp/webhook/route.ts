import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runGearAgentWorkflow, runUnregisteredGearAgentWorkflow } from '../workflow';

import { normalizePhoneForSearch, normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { handleTwilioMediaAndCreateTask, TwilioMediaDownload } from '@/lib/services/twilio/TwilioMediaTaskService';

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
    if (!webhookData.From || !webhookData.To) {
      console.error('❌ Datos incompletos en el webhook de Twilio');
      return NextResponse.json({ success: false, error: 'Missing required webhook data' }, { status: 400 });
    }
    
    const rawPhoneNumber = extractPhoneNumber(webhookData.From);
    const phoneNumber = normalizePhoneForStorage(rawPhoneNumber) || rawPhoneNumber;
    const businessPhoneNumber = extractPhoneNumber(webhookData.To);
    const profileName = webhookData.ProfileName || '';
    
    let messageContent = webhookData.Body || '';
    const messageSid = webhookData.MessageSid;
    const businessAccountId = webhookData.AccountSid || process.env.GEAR_TWILIO_ACCOUNT_SID;
    
    // Procesar contenido multimedia y adjuntos de Twilio
    const numMedia = parseInt(webhookData.NumMedia || '0');
    const mediaDownloads: TwilioMediaDownload[] = [];
    
    if (numMedia > 0) {
      const mediaList = [];
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = webhookData[`MediaUrl${i}`];
        const mediaType = webhookData[`MediaContentType${i}`];
        if (mediaUrl) {
          mediaList.push(`[Archivo adjunto - ${mediaType}]: ${mediaUrl}`);
          mediaDownloads.push({
            url: mediaUrl,
            contentType: mediaType,
          });
        }
      }
      if (mediaList.length > 0) {
        messageContent += (messageContent ? '\n\n' : '') + mediaList.join('\n');
      }
    }
    
    // Procesar ubicación
    if (webhookData.Latitude && webhookData.Longitude) {
      const address = webhookData.Address || 'Ubicación compartida';
      messageContent += (messageContent ? '\n\n' : '') + `[Ubicación adjunta]: ${address} (Lat: ${webhookData.Latitude}, Lng: ${webhookData.Longitude})`;
    }

    if (!messageContent.trim()) {
       messageContent = '[Mensaje vacío o formato no soportado]';
    }
    
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
    let instanceId: string | null = null;
    let systemPromptOverride: string | undefined = undefined;
    let needsProjectSelection = false;

    if (user) {
      userId = user.id;
      
      // Obtener todos los sitios pertenecientes a este usuario (como owner)
      const { data: userSites } = await supabaseAdmin
        .from('sites')
        .select('id, name')
        .eq('user_id', userId);

      // Obtener todos los sitios donde este usuario es miembro
      const { data: memberSites } = await supabaseAdmin
        .from('site_members')
        .select('site_id, sites:site_id(id, name)')
        .eq('user_id', userId);

      // Combinar y deduplicar sitios
      const allSites = new Map<string, { id: string, name: string }>();
      
      if (userSites) {
        userSites.forEach(site => allSites.set(site.id, site));
      }
      
      if (memberSites) {
        memberSites.forEach(member => {
          const siteData: any = member.sites;
          if (siteData && siteData.id) {
            allSites.set(siteData.id, { id: siteData.id, name: siteData.name });
          }
        });
      }

      const availableSites = Array.from(allSites.values());

      // Verificar tabla remote_sessions
      const { data: session } = await supabaseAdmin
        .from('remote_sessions')
        .select('site_id, instance_id')
        .eq('phone_number', phoneNumber)
        .maybeSingle();

      if (session && session.site_id) {
        // Validamos que el sitio seleccionado aún sea de su propiedad o sea miembro
        const hasAccess = availableSites.some(s => s.id === session.site_id);
        if (hasAccess) {
          siteId = session.site_id;
          if (session.instance_id) {
            instanceId = session.instance_id;
          }
          console.log(`✅ [Gear] Usando sitio activo de remote_sessions: ${siteId}`);
        }
      } 
      
      // Si no hay sesión remota, determinamos basado en sus sitios disponibles
      if (!siteId && availableSites.length > 0) {
        if (availableSites.length === 1) {
          siteId = availableSites[0].id;
          console.log(`✅ [Gear] Usando único sitio del usuario: ${siteId}`);
          
          // Guardar automáticamente en remote_sessions
          // Si recién le asignamos su único sitio, limpiamos la instancia por si acaso había basura.
          await supabaseAdmin.from('remote_sessions').upsert({
            phone_number: phoneNumber,
            user_id: userId,
            site_id: siteId,
            instance_id: null
          }, { onConflict: 'phone_number' });
          
        } else if (availableSites.length > 1) {
          // El usuario tiene varios sitios, debe elegir uno.
          needsProjectSelection = true;
          systemPromptOverride = "You are Makinari's Gear Assistant. The user has multiple projects but hasn't selected an active one. If you haven't showed them their projects yet, use the instance_project tool with action='list' to get their projects and ask which one they want to manage. If they reply indicating which project they want to use, use the instance_project tool with action='set' and the corresponding site_id to set it. Do not perform any other changes until they select a project.";
          console.log(`⚠️ [Gear] Usuario con múltiples sitios sin seleccionar. Necesita elegir.`);
        }
      } else if (!siteId) {
        // El usuario está registrado pero no tiene ningún sitio creado
        needsProjectSelection = true;
        systemPromptOverride = "You are Makinari's Gear Assistant. The user is registered but has no projects yet. Politely tell them they need to log in to the web app to create their first project. You cannot create a project for them from here.";
        console.log(`⚠️ [Gear] Usuario registrado sin sitios.`);
      }
    } else {
      // El usuario no está registrado en absoluto
      systemPromptOverride = `You are Makinari's Gear Assistant. The user with phone number ${phoneNumber} is NOT registered in Makinari. You MUST politely explain that their phone number is not linked to any Makinari account. If they already have an account, ask them to log in to the web app and link their phone number in their profile settings for security reasons. If they don't have an account, you can help them create one using the create_account tool. Explain briefly what Makinari is if they ask. Do not allow them to manage any sites or access ANY data until their phone is linked to an account. Tell them explicitly that you cannot provide any information without a linked account for security reasons. DO NOT under any circumstances return data from the database. NEVER execute tools that fetch data like get_leads, query_database, etc.`;
      console.log(`❌ [Gear] Número no registrado: ${phoneNumber}. Solicitando registro o vinculación de cuenta.`);
    }
    
    // 2. Fallback: Intentar encontrar site_id por account_sid en los ajustes
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
    // SOLO usamos el fallback si vamos a interactuar con alguien no registrado para ofrecerle el registro o alguien en lobby
    if (!siteId && process.env.GEAR_SITE_ID) {
      siteId = process.env.GEAR_SITE_ID;
      console.log(`✅ [Gear] Usando site_id de Makinari (GEAR_SITE_ID) como contexto genérico/lobby: ${siteId}`);
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
        console.log(`⚠️ [Gear] Usando site_id por nombre "Makinari" como contexto genérico/lobby: ${siteId}`);
      }
    }
    
    if (!siteId) {
      console.error('❌ No se pudo encontrar un site_id válido para inicializar el agente');
      return NextResponse.json({ success: true }); // Twilio siempre espera 200
    }
    
    // Si tenemos systemPromptOverride y no incluimos esta advertencia, se la agregamos al final para mayor seguridad:
    if (systemPromptOverride && !systemPromptOverride.includes('NOT registered')) {
        systemPromptOverride += `\n\nIMPORTANT SECURITY RULE: You MUST ensure that you ONLY perform actions and fetch data for the site ID explicitly provided to you in the tools. The user is logged in securely.`;
    } else if (!systemPromptOverride) {
        systemPromptOverride = `IMPORTANT SECURITY RULE: You are interacting with an authenticated user for site ID ${siteId}. You MUST ensure you ONLY perform actions and fetch data for this site. Do not share global data or cross-site data.`;
    }
    
    // Añadimos instrucción de formato para WhatsApp
    systemPromptOverride += `\n\nIMPORTANT FORMATTING RULE: You are talking to a user via WhatsApp. You MUST format your responses using WhatsApp formatting: *bold*, _italic_, ~strikethrough~, and \`\`\`code\`\`\`. Avoid markdown headers like # and markdown links like [text](url). Use bullet points like - item.`;
    
    // 3. Trigger Unregistered Workflow si no hay usuario o necesita seleccionar proyecto
    if (!userId || needsProjectSelection) {
      console.log(`🚀 Iniciando unregistered GearAgent workflow (o Lobby) para ${phoneNumber}...`);
      await start(runUnregisteredGearAgentWorkflow, [{
        message: messageContent,
        messageSid,
        siteId,
        userPhone: rawPhoneNumber,
        businessAccountId,
        systemPrompt: systemPromptOverride,
        userId: userId, // Pasamos el userId por si necesita usar tools de usuario registrado
        profileName // Pasamos el profileName por si lo necesita para crear el lead
      }]);
      console.log('✅ Unregistered/Lobby Workflow iniciado');
      return NextResponse.json({ success: true }, { status: 200 });
    }

    // 4. Si hay usuario, crear/recuperar instancia y disparar el Workflow normal
    // instanceId ya podría estar definido desde remote_sessions
    
    // Necesitamos que cada visitante de un mismo sitio tenga su propia instancia
    // para que las conversaciones no se mezclen. Por lo tanto, agregamos el phoneNumber
    // para aislar la instancia.
    
    const instanceIdentifier = `Gear Assistant - ${phoneNumber}`;
    
    if (!instanceId) {
      // Fallback: Buscar instancia existente por nombre
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
        console.log(`✅ Usando instancia existente (fallback por nombre) para ${phoneNumber}: ${instanceId}`);
        
        // Actualizar la sesión para no tener que buscar por nombre la próxima vez
        await supabaseAdmin.from('remote_sessions').upsert({
          phone_number: phoneNumber,
          user_id: userId,
          site_id: siteId,
          instance_id: instanceId
        }, { onConflict: 'phone_number' });
        
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
          
          // Guardar el instance_id en la sesión para futuras consultas
          await supabaseAdmin.from('remote_sessions').upsert({
            phone_number: phoneNumber,
            user_id: userId,
            site_id: siteId,
            instance_id: instanceId
          }, { onConflict: 'phone_number' });
        }
      }
    } else {
      console.log(`✅ Usando instancia de remote_sessions para ${phoneNumber}: ${instanceId}`);
      
      // Opcional: Podrías validar que la instancia exista y no esté eliminada/destruida.
      const { data: instStatus } = await supabaseAdmin
        .from('remote_instances')
        .select('status')
        .eq('id', instanceId)
        .single();
        
      if (!instStatus || instStatus.status === 'destroyed' || instStatus.status === 'deleted') {
         console.log(`⚠️ La instancia guardada estaba destruida o no existe. Creando una nueva...`);
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
          console.log(`✅ Nueva instancia creada tras reemplazo: ${instanceId}`);
          
          await supabaseAdmin.from('remote_sessions').upsert({
            phone_number: phoneNumber,
            user_id: userId,
            site_id: siteId,
            instance_id: instanceId
          }, { onConflict: 'phone_number' });
        }
      }
    }
    
    if (!instanceId) {
      console.error('❌ No se pudo obtener/crear una instancia');
      return NextResponse.json({ success: true });
    }

    // 4.1 PROCESAR MEDIOS (IMÁGENES, ARCHIVOS) SI LOS HAY
    // Solo si el usuario está registrado, tiene un sitio y una instancia válida.
    if (mediaDownloads.length > 0 && userId && siteId && instanceId) {
      console.log(`📎 Procesando ${mediaDownloads.length} archivos adjuntos de WhatsApp...`);
      try {
        const accountSid = businessAccountId || process.env.GEAR_TWILIO_ACCOUNT_SID;
        const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN;
        
        if (accountSid && authToken) {
          const mediaResult = await handleTwilioMediaAndCreateTask({
            siteId,
            userId,
            instanceId,
            messageText: messageContent,
            workflowOrigin: 'whatsapp',
            media: mediaDownloads,
            twilioAuth: { accountSid, authToken },
          });
          
          if (mediaResult.success) {
            console.log(`✅ ${mediaDownloads.length} archivos procesados y guardados exitosamente como assets de la instancia`);
            // Agregar al contenido del mensaje que se ha subido el archivo exitosamente para que la IA lo sepa
            messageContent += `\n[System Note: User has successfully uploaded ${mediaDownloads.length} media file(s). They have been attached to your instance context.]`;
          } else {
            console.warn(`⚠️ Error procesando archivos: ${mediaResult.error}`);
          }
        } else {
          console.warn(`⚠️ Faltan credenciales de Twilio para descargar los archivos de WhatsApp`);
        }
      } catch (err) {
        console.error(`❌ Error inesperado al procesar medios de Twilio:`, err);
      }
    }
    
    // 4.5. INSERTAR MENSAJE DEL USUARIO EN instance_logs ANTES DE INICIAR EL WORKFLOW
    // Esto es crucial para que el workflow.ts encuentre el historial y el contexto de qué responder.
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'user_action',
      level: 'info',
      message: messageContent,
      details: {
        prompt_source: 'whatsapp_webhook',
        message_sid: messageSid
      },
      instance_id: instanceId,
      site_id: siteId,
      user_id: userId,
    });
    console.log(`📝 Log de mensaje de usuario insertado en instance_logs para instancia ${instanceId}`);
    
    // Trigger Workflow normal
    console.log(`🚀 Iniciando workflow GearAgent normal para ${phoneNumber}...`);
    
    await start(runGearAgentWorkflow, [{
      instanceId,
      message: messageContent,
      messageSid,
      siteId,
      userId,
      userPhone: rawPhoneNumber, // Mantenemos el número crudo para que Twilio pueda responder correctamente
      customTools: [],
      useSdkTools: false, 
      systemPrompt: systemPromptOverride
    }]);
    
    console.log('✅ Workflow iniciado');
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error('❌ Error al procesar webhook de Twilio WhatsApp (Gear):', error);
    
    if (error?.name === 'InsufficientCreditsError' || error?.message?.includes('Insufficient credits')) {
      console.warn('⚠️ WhatsApp message processing aborted due to insufficient credits');
      return NextResponse.json({ success: false, error: 'INSUFFICIENT_CREDITS' }, { status: 402 });
    }
    
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
