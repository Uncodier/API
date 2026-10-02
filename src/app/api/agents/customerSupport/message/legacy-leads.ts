import { supabaseAdmin } from '@/lib/database/supabase-client';
import { normalizePhoneForSearch, normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { isValidUUID } from './agent-data';
// Función para buscar un lead por email, teléfono o nombre
async function findLeadByInfo(email?: string, phone?: string, name?: string, siteId?: string): Promise<string | null> {
  try {
    if (!email && !phone && !name) {
      console.log(`⚠️ No se proporcionó información para buscar lead`);
      return null;
    }
    
    let query = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('leads').select('id');
    
    // Siempre filtrar por site_id si está disponible
    if (siteId) {
      query = query.eq('site_id', siteId);
      console.log(`🔍 Filtrando búsqueda de lead por site_id="${siteId}"`);
    }
    
    // Construir la consulta según los datos disponibles
    if (email && phone) {
      // Si tenemos ambos, email y phone, generar variantes del teléfono para búsqueda más flexible
      const phoneVariants = normalizePhoneForSearch(phone);
      const phoneQueries = phoneVariants.map(variant => `phone.eq."${variant}"`);
      const allQueries = [`email.eq.${email}`, ...phoneQueries];
      query = query.or(allQueries.join(','));
      console.log(`🔍 Buscando lead con email="${email}" O phone en variantes: ${phoneVariants.join(', ')}`);
    } else {
      // Si solo tenemos uno de los dos, usar el operador eq correspondiente
      if (email) {
        query = query.eq('email', email);
        console.log(`🔍 Buscando lead con email="${email}"`);
      }
      
      if (phone) {
        // Generar variantes del número de teléfono para búsqueda más flexible
        const phoneVariants = normalizePhoneForSearch(phone);
        if (phoneVariants.length > 1) {
          const phoneQueries = phoneVariants.map(variant => `phone.eq."${variant}"`);
          query = query.or(phoneQueries.join(','));
          console.log(`🔍 Buscando lead con phone en variantes: ${phoneVariants.join(', ')}`);
        } else if (phoneVariants.length === 1) {
          // En Supabase el eq no siempre funciona bien con caracteres especiales (como + o espacios) 
          // cuando se combina con or(). En or(), hemos añadido comillas. 
          // Aquí podemos mantener eq() normal o usar filter() si hay problemas, pero eq() 
          // directo en Supabase SDK habitualmente escapa bien los valores internamente.
          query = query.eq('phone', phoneVariants[0]);
          console.log(`🔍 Buscando lead con phone="${phoneVariants[0]}"`);
        } else {
          console.log(`⚠️ No se pudieron generar variantes válidas para el teléfono: ${phone}`);
        }
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

// Función para crear una tarea para un lead
async function createTaskForLead(leadId: string, siteId?: string, userId?: string, commandId?: string): Promise<string | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`❌ ID de lead no válido para crear tarea: ${leadId}`);
      return null;
    }
    
    console.log(`✏️ Creando tarea para lead: ${leadId}`);
    
    // Obtener información del lead para usar en la tarea
    const { data: lead, error: leadError } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('leads')
      .select('id, name, user_id, site_id')
      .eq('id', leadId)
      .single();
    
    if (leadError || !lead) {
      if (leadError && leadError.code === 'PGRST116') {
        console.log(`⚠️ Lead ${leadId} no encontrado para crear tarea. Saltando creación de tarea.`);
      } else {
        console.error(`❌ Error al obtener información del lead para la tarea:`, leadError || 'Lead no encontrado');
      }
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
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
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



// Función para crear un nuevo lead
async function createLead(name: string, email?: string, phone?: string, siteId?: string, visitorId?: string, origin?: string): Promise<string | null> {
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
    if (phone) {
      // Normalizar el teléfono para almacenamiento consistente
      const normalizedPhone = normalizePhoneForStorage(phone);
      leadData.phone = normalizedPhone;
      console.log(`📞 Teléfono normalizado para almacenamiento: "${phone}" -> "${normalizedPhone}"`);
    }
    
    // Primero obtenemos los datos completos del sitio para usar site.id y site.user_id
    if (siteId && isValidUUID(siteId)) {
      try {
        const { data: site, error: siteError } = await supabaseAdmin
          .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
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
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
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
