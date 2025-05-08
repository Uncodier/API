import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Busca un lead existente por email, teléfono o nombre
 * @param email - Email del lead
 * @param phone - Teléfono del lead
 * @param name - Nombre del lead
 * @param siteId - ID del sitio
 * @returns ID del lead encontrado o null si no existe
 */
export async function findLeadByInfo(email?: string, phone?: string, name?: string, siteId?: string): Promise<string | null> {
  try {
    if (!email && !phone && !name) {
      console.log(`⚠️ No se proporcionó información para buscar lead`);
      return null;
    }
    
    let query = supabaseAdmin.from('leads').select('id');
    
    // Siempre filtrar por site_id si está disponible
    if (siteId) {
      query = query.eq('site_id', siteId);
      console.log(`🔍 Filtrando búsqueda de lead por site_id="${siteId}"`);
    }
    
    // Construir la consulta según los datos disponibles
    if (email && phone) {
      // Si tenemos ambos, email y phone, usar correctamente el operador OR de Supabase
      query = query.or(`email.eq.${email},phone.eq.${phone}`);
      console.log(`🔍 Buscando lead con email="${email}" O phone="${phone}"`);
    } else {
      // Si solo tenemos uno de los dos, usar el operador eq correspondiente
      if (email) {
        query = query.eq('email', email);
        console.log(`🔍 Buscando lead con email="${email}"`);
      }
      
      if (phone) {
        query = query.eq('phone', phone);
        console.log(`🔍 Buscando lead con phone="${phone}"`);
      }
    }
    
    // Solo usar name como último recurso si no hay email ni phone
    if (name && !email && !phone) {
      query = query.eq('name', name);
      console.log(`🔍 Buscando lead solo con name="${name}"`);
    }
    
    // Ejecutar la consulta
    const { data, error } = await query.limit(1);
    
    if (error) {
      console.error('Error al buscar lead por información:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró lead con la información proporcionada ${siteId ? `para el sitio ${siteId}` : ''}`);
      return null;
    }
    
    console.log(`✅ Lead encontrado con ID: ${data[0].id} ${siteId ? `para el sitio ${siteId}` : ''}`);
    return data[0].id;
  } catch (error) {
    console.error('Error al buscar lead por información:', error);
    return null;
  }
}

/**
 * Crea un nuevo lead en la base de datos
 * @param name - Nombre del lead (requerido)
 * @param email - Email del lead
 * @param phone - Teléfono del lead
 * @param siteId - ID del sitio
 * @param visitorId - ID del visitante
 * @param origin - Origen del lead (default: 'chat')
 * @returns ID del lead creado o null si falló
 */
export async function createLead(name: string, email?: string, phone?: string, siteId?: string, visitorId?: string, origin?: string): Promise<string | null> {
  try {
    // Validar que tengamos al menos la información básica necesaria
    if (!name) {
      console.error('❌ No se puede crear un lead sin nombre');
      return null;
    }
    
    console.log(`➕ Creando nuevo lead con name=${name}, email=${email || 'N/A'}, phone=${phone || 'N/A'}, site_id=${siteId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, origin=${origin || 'chat'}`);
    
    // Crear objeto con datos mínimos
    const leadData: any = {
      name: name,
      status: 'contacted',
      origin: origin || 'chat'
    };
    
    // Agregar campos opcionales si están presentes
    if (email) leadData.email = email;
    if (phone) leadData.phone = phone;
    
    // Primero obtenemos los datos completos del sitio para usar site.id y site.user_id
    if (siteId && isValidUUID(siteId)) {
      try {
        const { data: site, error: siteError } = await supabaseAdmin
          .from('sites')
          .select('id, user_id')
          .eq('id', siteId)
          .single();
        
        if (siteError) {
          console.error(`❌ Error al obtener sitio: ${siteError.message}`);
        } else if (site) {
          // Usar directamente site.id y site.user_id
          leadData.site_id = site.id;
          leadData.user_id = site.user_id;
          console.log(`👤 Usando site.id=${site.id} y site.user_id=${site.user_id} directamente`);
        } else {
          // Fallback a siteId si no se pudo obtener el sitio
          leadData.site_id = siteId;
          console.warn(`⚠️ No se encontró el sitio ${siteId}, usando el ID proporcionado`);
        }
      } catch (e) {
        console.error('❌ Excepción al obtener datos del sitio:', e);
        // Fallback a siteId
        leadData.site_id = siteId;
      }
    }
    
    console.log(`📦 Datos para crear lead:`, JSON.stringify(leadData));
    
    // Intentar insertar el lead directamente
    const { data, error } = await supabaseAdmin
      .from('leads')
      .insert([leadData])
      .select()
      .single();
    
    if (error) {
      console.error(`❌ Error al crear nuevo lead (código ${error.code}):`, error.message);
      console.error(`❌ Detalles del error:`, JSON.stringify(error));
      console.error(`❌ Datos que se intentaron insertar:`, JSON.stringify(leadData));
      
      // Si el error es de constraint unique, puede ser que el lead ya exista
      if (error.code === '23505') { // Código PostgreSQL para "unique violation"
        console.log('🔄 Error de duplicado, intentando encontrar el lead existente...');
        // Intentar buscar el lead existente por los mismos campos
        const existingLeadId = await findLeadByInfo(email, phone, name, siteId);
        if (existingLeadId) {
          console.log(`✅ Se encontró lead existente con ID: ${existingLeadId}`);
          return existingLeadId;
        }
      }
      
      return null;
    }
    
    if (!data || !data.id) {
      console.error('❌ No se recibió ID para el lead creado');
      return null;
    }
    
    console.log(`✅ Nuevo lead creado con ID: ${data.id} ${siteId ? `para el sitio ${siteId}` : ''}`);
    return data.id;
  } catch (error) {
    console.error('❌ Excepción al crear nuevo lead:', error);
    return null;
  }
}

/**
 * Crea una tarea de seguimiento para un lead
 * @param leadId - ID del lead (requerido)
 * @param siteId - ID del sitio
 * @param userId - ID del usuario asignado a la tarea
 * @param commandId - ID del comando que generó la tarea
 * @returns ID de la tarea creada o null si falló
 */
export async function createTaskForLead(leadId: string, siteId?: string, userId?: string, commandId?: string): Promise<string | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`❌ ID de lead no válido para crear tarea: ${leadId}`);
      return null;
    }
    
    console.log(`✏️ Creando tarea para lead: ${leadId}`);
    
    // Obtener información del lead para usar en la tarea
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('id, name, user_id, site_id')
      .eq('id', leadId)
      .single();
    
    if (leadError || !lead) {
      console.error(`❌ Error al obtener información del lead para la tarea:`, leadError || 'Lead no encontrado');
      return null;
    }
    
    // Preparar datos para la tarea
    const taskData: any = {
      lead_id: leadId,
      title: `Seguimiento para ${lead.name}`,
      type: 'follow_up',
      stage: 'pending',
      status: 'active',
      // Programar seguimiento para el siguiente día hábil (aquí usamos +1 día)
      scheduled_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      description: `Tarea de seguimiento creada automáticamente para el lead generado vía chat web.`,
    };
    
    // Priorizar los IDs proporcionados, pero usar los del lead como respaldo
    taskData.user_id = userId || lead.user_id;
    taskData.site_id = siteId || lead.site_id;
    
    // Añadir command_id si está presente y es válido
    if (commandId && isValidUUID(commandId)) {
      taskData.command_id = commandId;
    }
    
    console.log(`📋 Datos para la tarea:`, JSON.stringify(taskData));
    
    // Insertar la tarea en la base de datos
    const { data: task, error: taskError } = await supabaseAdmin
      .from('tasks')
      .insert([taskData])
      .select()
      .single();
    
    if (taskError) {
      console.error(`❌ Error al crear tarea para lead:`, taskError);
      return null;
    }
    
    console.log(`✅ Tarea creada exitosamente con ID: ${task.id}`);
    return task.id;
  } catch (error) {
    console.error(`❌ Excepción al crear tarea para lead:`, error);
    return null;
  }
}

/**
 * Función principal para gestionar un lead: busca un lead existente o crea uno nuevo si es necesario
 * @param params - Parámetros para la gestión del lead
 * @returns Objeto con información del lead gestionado
 */
export async function manageLeadCreation({
  leadId,
  name,
  email,
  phone,
  siteId,
  visitorId,
  origin = 'chat',
  createTask = false
}: {
  leadId?: string,
  name?: string,
  email?: string,
  phone?: string,
  siteId?: string,
  visitorId?: string,
  origin?: string,
  createTask?: boolean
}): Promise<{
  leadId: string | null,
  isNewLead: boolean,
  taskId: string | null
}> {
  // Si ya tenemos un lead_id, verificamos que sea válido
  if (leadId && isValidUUID(leadId)) {
    console.log(`👤 Usando lead_id existente: ${leadId}`);
    return { leadId, isNewLead: false, taskId: null };
  }
  
  // Si no tenemos lead_id pero tenemos información para crear/buscar uno
  if (!leadId && (name || email || phone)) {
    console.log(`🔍 Buscando o creando lead con: name=${name || 'N/A'}, email=${email || 'N/A'}, phone=${phone || 'N/A'}, site_id=${siteId || 'N/A'}`);
    
    // Primero intentar buscar un lead existente si tenemos email o phone
    let foundLeadId = null;
    if (email || phone) {
      console.log(`🔎 Intentando buscar lead existente por email o teléfono ${siteId ? `para el sitio ${siteId}` : ''}`);
      foundLeadId = await findLeadByInfo(email, phone, name, siteId);
    }
    
    if (foundLeadId) {
      console.log(`✅ Lead existente encontrado con ID: ${foundLeadId}`);
      return { leadId: foundLeadId, isNewLead: false, taskId: null };
    } else if (name) {
      // Si no se encuentra lead, crear uno nuevo
      console.log(`🆕 No se encontró lead existente. Creando nuevo lead con nombre: ${name} para el sitio: ${siteId || 'sin sitio'}`);
      
      // Verificar email y phone para diagnóstico
      if (!email) console.log(`⚠️ Creando lead sin email`);
      if (!phone) console.log(`⚠️ Creando lead sin teléfono`);
      if (!siteId) console.log(`⚠️ Creando lead sin sitio asociado`);
      
      const newLeadId = await createLead(name, email, phone, siteId, visitorId, origin);
      
      if (newLeadId) {
        console.log(`✅ Nuevo lead creado exitosamente con ID: ${newLeadId}`);
        
        // Si se solicitó crear una tarea, hacerlo
        let taskId = null;
        if (createTask) {
          const createdTaskId = await createTaskForLead(newLeadId, siteId);
          if (createdTaskId) {
            console.log(`✅ Tarea creada exitosamente para el lead: ${newLeadId}, tarea ID: ${createdTaskId}`);
            taskId = createdTaskId;
          } else {
            console.error(`❌ Error al crear tarea para el lead: ${newLeadId}`);
          }
        }
        
        return { leadId: newLeadId, isNewLead: true, taskId };
      } else {
        console.error(`❌ Error al crear nuevo lead para: ${name} en sitio: ${siteId || 'sin sitio'}`);
      }
    }
  }
  
  // Si llegamos aquí, no pudimos encontrar ni crear un lead
  return { leadId: null, isNewLead: false, taskId: null };
} 