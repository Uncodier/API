import { getAvailableAgentProjects, resolveAgentProjectSession, AGENT_PROJECT_SELECTION_PROMPT, AGENT_NO_PROJECTS_PROMPT } from '@/lib/services/channels/agent-project-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runGearEmailWorkflow, runUnregisteredGearEmailWorkflow } from './workflow';
import { resetRequirementOnUserAction } from '@/lib/services/requirement-cron-reset';
import { insertUserActionLog } from '@/app/api/robots/instance/assistant/user-message-log';
import { agentProjectSessionKey, saveAgentProjectSession } from '@/lib/services/channels/agent-project-session';

export async function handleGearEmailWebhook(message: any, userEmail: string, profileName?: string) {
  console.log(`📩 Webhook de Email (Gear) recibido para ${userEmail}`);
  
  const messageContent = message.body || message.text || message.content || message.html || '[Mensaje vacío o formato no soportado]';
  const messageId = message.message_id;
  
  // 1. Identificar al usuario basado en el email
  const { data: users, error: userError } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', userEmail.toLowerCase().trim());

  if (userError) {
    console.error('❌ Error buscando usuario por email:', userError);
  }

  const user = users && users.length > 0 ? {
    id: users[0].id
  } : null;

  let siteId: string | null = null;
  let userId: string | null = null;
  let instanceId: string | null = null;
  let systemPromptOverride: string | undefined = undefined;
  let needsProjectSelection = false;

  if (user?.id) {
    const authenticatedUserId: string = user.id;
    userId = authenticatedUserId;
    
    const availableSites = await getAvailableAgentProjects(authenticatedUserId);

    // Verificar tabla remote_sessions
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('remote_sessions')
      .select('user_id, site_id, instance_id')
      .eq('phone_number', agentProjectSessionKey(userEmail))
      .maybeSingle();

    if (sessionError) throw new Error('Agent project session unavailable');
    const resolvedSession = resolveAgentProjectSession(authenticatedUserId, availableSites, session);
    siteId = resolvedSession.siteId;
    instanceId = resolvedSession.instanceId;
    if (resolvedSession.unavailableSession) console.log('[Gear Email] Previous project access unavailable; resolving another project');

    if (!siteId && availableSites.length > 0) {
      if (availableSites.length === 1) {
        siteId = availableSites[0].id;
        console.log(`✅ [Gear Email] Usando único sitio del usuario: ${siteId}`);
        
        await saveAgentProjectSession(userEmail, authenticatedUserId, siteId, null);
        
      } else if (availableSites.length > 1) {
        needsProjectSelection = true;
        systemPromptOverride = AGENT_PROJECT_SELECTION_PROMPT;
        console.log(`⚠️ [Gear Email] Usuario con múltiples sitios sin seleccionar. Necesita elegir.`);
      }
    } else if (!siteId) {
      needsProjectSelection = true;
      systemPromptOverride = AGENT_NO_PROJECTS_PROMPT;
      console.log(`⚠️ [Gear Email] Usuario registrado sin sitios.`);
    }
  } else {
    systemPromptOverride = `You are Makinari's Gear Assistant. The user with email ${userEmail} is NOT registered in Makinari. You MUST politely explain that their email is not linked to any Makinari account. If they already have an account, ask them to log in to the web app and link their email in their profile settings for security reasons. If they don't have an account, you can help them create one using the create_account tool. Explain briefly what Makinari is if they ask. Do not allow them to manage any sites or access ANY data until their email is linked to an account. Tell them explicitly that you cannot provide any information without a linked account for security reasons. DO NOT under any circumstances return data from the database. NEVER execute tools that fetch data like get_leads, query_database, etc.`;
    console.log(`❌ [Gear Email] Email no registrado: ${userEmail}. Solicitando registro o vinculación de cuenta.`);
  }

  // Fallback: Makinari por defecto (entorno)
  if (!siteId && process.env.GEAR_SITE_ID) {
    siteId = process.env.GEAR_SITE_ID;
    console.log(`✅ [Gear Email] Usando site_id de Makinari (GEAR_SITE_ID) como contexto genérico/lobby: ${siteId}`);
  }
  
  if (!siteId) {
    const { data: siteByName } = await supabaseAdmin
      .from('sites')
      .select('id')
      .ilike('name', '%Makinari%')
      .limit(1)
      .maybeSingle();
      
    if (siteByName) {
      siteId = siteByName.id;
      console.log(`⚠️ [Gear Email] Usando site_id por nombre "Makinari" como contexto genérico/lobby: ${siteId}`);
    }
  }

  if (!siteId) {
    console.error('❌ No se pudo encontrar un site_id válido para inicializar el agente email');
    return;
  }
  
  if (systemPromptOverride && !systemPromptOverride.includes('NOT registered')) {
      systemPromptOverride += `\n\nIMPORTANT SECURITY RULE: You MUST ensure that you ONLY perform actions and fetch data for the site ID explicitly provided to you in the tools. The user is logged in securely.`;
  } else if (!systemPromptOverride) {
      systemPromptOverride = `IMPORTANT SECURITY RULE: You are interacting with an authenticated user for site ID ${siteId}. You MUST ensure you ONLY perform actions and fetch data for this site. Do not share global data or cross-site data.`;
  }
  
  // Añadimos instrucción de formato para Email
  systemPromptOverride += `\n\nIMPORTANT FORMATTING RULE: You are talking to a user via Email. You can use standard Markdown formatting. Keep it professional.`;

  // 3. Trigger Unregistered Workflow si no hay usuario o necesita seleccionar proyecto
  if (!userId || needsProjectSelection) {
    console.log(`🚀 Iniciando unregistered GearAgent email workflow (o Lobby) para ${userEmail}...`);
    await start(runUnregisteredGearEmailWorkflow, [{
      message: messageContent,
      messageSid: messageId,
      siteId,
      userEmail: userEmail,
      systemPrompt: systemPromptOverride,
      userId: userId,
      profileName
    }]);
    console.log('✅ Unregistered/Lobby Email Workflow iniciado');
    return;
  }

  // 4. Si hay usuario, crear/recuperar instancia y disparar el Workflow normal
  const instanceIdentifier = `Gear Assistant Email - ${userEmail}`;
  
  if (!instanceId) {
    const { data: instances } = await supabaseAdmin
      .from('remote_instances')
      .select('id')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .eq('name', instanceIdentifier)
      .neq('status', 'destroyed')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(1);
      
    if (instances && instances.length > 0) {
      instanceId = instances[0].id;
      console.log(`✅ Usando instancia existente (fallback por nombre) para email ${userEmail}: ${instanceId}`);
      
      await saveAgentProjectSession(userEmail, userId, siteId, instanceId);
      
    } else {
      console.log(`🆕 Creando nueva instancia de Gear Email para ${userEmail}`);
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
        
        await saveAgentProjectSession(userEmail, userId, siteId, instanceId);
      }
    }
  } else {
    console.log(`✅ Usando instancia de remote_sessions para ${userEmail}: ${instanceId}`);
    
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
        
        await saveAgentProjectSession(userEmail, userId, siteId, instanceId);
      }
    }
  }
  
  if (!instanceId) {
    console.error('❌ No se pudo obtener/crear una instancia de email');
    return;
  }

  // 4.5. INSERTAR MENSAJE DEL USUARIO EN instance_logs
  const userAction = await insertUserActionLog({
    instanceId,
    siteId,
    userId,
    message: messageContent,
    skipDuplicateCheck: true,
    details: {
      prompt_source: 'email_webhook',
      message_id: messageId,
    },
  });
  console.log(`📝 Log de mensaje de usuario insertado en instance_logs para instancia ${instanceId}`);
  
  // Finish recovery before starting the workflow.
  await resetRequirementOnUserAction(
    instanceId,
    userAction.id,
  );
  
  // Trigger Workflow normal
  console.log(`🚀 Iniciando workflow GearAgent Email normal para ${userEmail}...`);
  
  await start(runGearEmailWorkflow, [{
    instanceId,
    message: messageContent,
    messageSid: messageId,
    siteId,
    userId,
    userEmail: userEmail,
    customTools: [],
    useSdkTools: false, 
    systemPrompt: systemPromptOverride
  }]);
  
  console.log('✅ Email Workflow iniciado');
}
