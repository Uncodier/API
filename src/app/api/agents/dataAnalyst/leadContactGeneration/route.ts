import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Configurar timeout máximo a 5 minutos (300 segundos)
// Máximo para plan Pro de Vercel
export const maxDuration = 300;

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para validar dominio
function isValidDomain(domain: string): boolean {
  // Permitir subdominios: sub.example.com, example.com, example-test.co.uk
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

// Extraer dominio a partir de una URL del sitio
function extractDomainFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    // Fallback: eliminar protocolo y rutas si viene en formato no estándar
    const cleaned = url
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .trim();
    return cleaned || null;
  }
}

// Función para encontrar agente con role "Data Analyst"
async function findDataAnalystAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Data Analyst')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente con role "Data Analyst":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con role "Data Analyst" activo para el sitio: ${siteId}`);
      return null;
    }
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente Data Analyst:', error);
    return null;
  }
}

// Función para detectar lenguaje del nombre y contexto
function detectLanguageAndRegion(name: string, context: string): {language: string, region: string, cultural_patterns: string[]} {
  const nameWords = name.toLowerCase().split(' ');
  const contextLower = context.toLowerCase();
  
  // Patrones de nombres por idioma/región
  const spanishPatterns = ['maría', 'josé', 'juan', 'carlos', 'ana', 'luis', 'antonio', 'francisco', 'manuel', 'carmen', 'isabel', 'miguel', 'rafael', 'fernando', 'diego', 'alejandro', 'gonzález', 'rodríguez', 'martínez', 'lópez', 'garcía', 'pérez', 'sánchez', 'ramírez', 'torres', 'flores', 'rivera', 'gómez', 'díaz', 'hernández'];
  const frenchPatterns = ['jean', 'marie', 'pierre', 'michel', 'alain', 'philippe', 'bernard', 'christophe', 'nicolas', 'daniel', 'françois', 'laurent', 'david', 'julien', 'pascal', 'thierry', 'olivier', 'sébastien', 'fabrice', 'stéphane', 'dupont', 'martin', 'bernard', 'thomas', 'petit', 'robert', 'richard', 'durand', 'dubois', 'moreau'];
  const germanPatterns = ['hans', 'peter', 'wolfgang', 'klaus', 'jürgen', 'dieter', 'günter', 'frank', 'bernd', 'stefan', 'thomas', 'michael', 'andreas', 'christian', 'werner', 'helmut', 'uwe', 'rainer', 'müller', 'schmidt', 'schneider', 'fischer', 'weber', 'meyer', 'wagner', 'becker', 'schulz', 'hoffmann', 'schäfer'];
  const italianPatterns = ['mario', 'giovanni', 'antonio', 'francesco', 'luigi', 'vincenzo', 'giuseppe', 'salvatore', 'michele', 'angelo', 'carlo', 'roberto', 'stefano', 'andrea', 'marco', 'paolo', 'alessandro', 'massimo', 'rossi', 'russo', 'ferrari', 'esposito', 'bianchi', 'romano', 'colombo', 'ricci', 'marino', 'greco', 'bruno'];
  const dutchPatterns = ['jan', 'pieter', 'kees', 'henk', 'willem', 'geert', 'dirk', 'piet', 'johan', 'cornelis', 'anton', 'johannes', 'adrianus', 'jacobus', 'van', 'de', 'der', 'den', 'jansen', 'bakker', 'visser', 'smit', 'meijer', 'boer', 'mulder', 'berg', 'dijkstra'];
  
  // Detectar por nombre
  let language = 'english';
  let region = 'international';
  let cultural_patterns: string[] = [];
  
  if (nameWords.some(word => spanishPatterns.includes(word))) {
    language = 'spanish';
    region = 'hispanic';
    cultural_patterns = ['compound_first_names', 'maternal_surnames', 'formal_titles'];
  } else if (nameWords.some(word => frenchPatterns.includes(word))) {
    language = 'french';
    region = 'france';
    cultural_patterns = ['hyphenated_names', 'formal_address'];
  } else if (nameWords.some(word => germanPatterns.includes(word))) {
    language = 'german';
    region = 'germany';
    cultural_patterns = ['compound_names', 'professional_titles'];
  } else if (nameWords.some(word => italianPatterns.includes(word))) {
    language = 'italian';
    region = 'italy';
    cultural_patterns = ['multiple_surnames', 'regional_variations'];
  } else if (nameWords.some(word => dutchPatterns.includes(word))) {
    language = 'dutch';
    region = 'netherlands';
    cultural_patterns = ['tussenvoegsel', 'compound_surnames'];
  }
  
  // Detectar por contexto geográfico
  const regionKeywords = {
    'spain': 'spanish',
    'méxico': 'spanish',
    'argentina': 'spanish',
    'colombia': 'spanish',
    'chile': 'spanish',
    'france': 'french',
    'canada': 'bilingual',
    'germany': 'german',
    'italy': 'italian',
    'netherlands': 'dutch',
    'brazil': 'portuguese',
    'portugal': 'portuguese',
    'uk': 'british',
    'united kingdom': 'british',
    'australia': 'australian',
    'ireland': 'irish'
  };
  
  for (const [country, lang] of Object.entries(regionKeywords)) {
    if (contextLower.includes(country)) {
      if (lang === 'spanish') {
        language = 'spanish';
        region = 'hispanic';
        cultural_patterns = ['compound_first_names', 'maternal_surnames', 'formal_titles'];
      } else if (lang === 'french') {
        language = 'french';
        region = 'france';
        cultural_patterns = ['hyphenated_names', 'formal_address'];
      }
      // ... otros idiomas
      break;
    }
  }
  
  return { language, region, cultural_patterns };
}

// Función para generar patrones específicos por cultura
function generateCulturalEmailPatterns(name: string, domain: string, language: string, region: string, cultural_patterns: string[]): string[] {
  const patterns: string[] = [];
  const nameParts = name.toLowerCase().split(' ').filter(part => part.length > 0);
  
  if (nameParts.length === 0) return patterns;
  
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];
  
  // Patrones específicos por cultura
  if (language === 'spanish' || region === 'hispanic') {
    // En países hispanos, a menudo se usan dos apellidos
    if (nameParts.length >= 3) {
      const paternalSurname = nameParts[nameParts.length - 2];
      const maternalSurname = nameParts[nameParts.length - 1];
      
      patterns.push(`${firstName}.${paternalSurname}@${domain}`);
      patterns.push(`${firstName}.${paternalSurname}.${maternalSurname}@${domain}`);
      patterns.push(`${firstName}${paternalSurname}@${domain}`);
    }
    
    // Nombres compuestos son comunes
    if (nameParts.length >= 2 && nameParts[0].length <= 6 && nameParts[1].length <= 6) {
      const compoundFirst = `${nameParts[0]}${nameParts[1]}`;
      patterns.push(`${compoundFirst}@${domain}`);
      if (lastName) {
        patterns.push(`${compoundFirst}.${lastName}@${domain}`);
      }
    }
  }
  
  if (language === 'dutch' || region === 'netherlands') {
    // Nombres holandeses con tussenvoegsel (van, de, der, etc.)
    const tussenvoegselWords = ['van', 'de', 'der', 'den', 'van der', 'van den'];
    let cleanedName = name.toLowerCase();
    
    for (const tussenvoegsel of tussenvoegselWords) {
      if (cleanedName.includes(` ${tussenvoegsel} `)) {
        const beforeTussen = cleanedName.split(` ${tussenvoegsel} `)[0].split(' ').pop() || '';
        const afterTussen = cleanedName.split(` ${tussenvoegsel} `)[1].split(' ')[0] || '';
        
        patterns.push(`${firstName}.${beforeTussen}@${domain}`);
        patterns.push(`${firstName}.${afterTussen}@${domain}`);
        patterns.push(`${firstName}.${tussenvoegsel.replace(/\s/g, '')}.${afterTussen}@${domain}`);
      }
    }
  }
  
  if (language === 'german' || region === 'germany') {
    // Nombres alemanes tienden a ser más formales
    if (firstName && lastName) {
      patterns.push(`${firstName}.${lastName}@${domain}`);
      patterns.push(`${lastName}.${firstName}@${domain}`); // Orden inverso común en Alemania
    }
  }
  
  if (language === 'french' || region === 'france') {
    // Nombres franceses con guiones
    const hyphenatedParts = name.split('-');
    if (hyphenatedParts.length > 1) {
      const cleanParts = hyphenatedParts.map(part => part.toLowerCase().trim());
      patterns.push(`${cleanParts.join('')}@${domain}`);
      patterns.push(`${cleanParts.join('.')}@${domain}`);
    }
  }
  
  return patterns;
}

// Función para detectar si es un puesto directivo
function isExecutivePosition(context: string): boolean {
  const contextLower = context.toLowerCase();
  
  // Puestos directivos en español
  const executiveRoles = [
    // C-Level
    'ceo', 'cto', 'cfo', 'cmo', 'coo', 'chief executive', 'chief technology', 'chief financial', 'chief marketing', 'chief operating',
    
    // Directores
    'director', 'directora', 'director general', 'directora general', 'director ejecutivo', 'directora ejecutiva',
    'director de', 'directora de', 'managing director', 'executive director',
    
    // Gerentes senior
    'gerente general', 'gerenta general', 'general manager', 'country manager',
    'regional manager', 'gerente regional', 'gerenta regional',
    
    // Presidentes y VPs
    'presidente', 'presidenta', 'president', 'vicepresidente', 'vicepresidenta', 'vice president', 'vp ',
    
    // Fundadores y propietarios
    'fundador', 'fundadora', 'founder', 'co-founder', 'cofundador', 'cofundadora',
    'propietario', 'propietaria', 'owner', 'socio', 'socia', 'partner',
    
    // Otros ejecutivos
    'executive', 'ejecutivo', 'ejecutiva', 'senior manager', 'gerente senior', 'gerenta senior'
  ];
  
  return executiveRoles.some(role => contextLower.includes(role));
}

// Función para extraer departamento/rol del contexto
function extractDepartmentFromContext(context: string): string[] {
  const departments = [];
  const contextLower = context.toLowerCase();
  
  // Mapeo de roles/departamentos a prefijos de email comunes
  const departmentMap: { [key: string]: string[] } = {
    // Roles ejecutivos específicos primero (más específicos)
    'marketing director': ['marketing', 'mercadeo', 'mkt'],
    'sales director': ['sales', 'ventas', 'comercial'],
    'finance director': ['finance', 'finanzas', 'accounting'],
    'hr director': ['hr', 'rrhh', 'people'],
    'tech director': ['tech', 'it', 'sistemas'],
    'operations director': ['operations', 'ops', 'operaciones'],
    'director de marketing': ['marketing', 'mercadeo', 'mkt'],
    'director de ventas': ['sales', 'ventas', 'comercial'],
    'director de finanzas': ['finance', 'finanzas', 'accounting'],
    'director de rrhh': ['hr', 'rrhh', 'people'],
    'director de tecnología': ['tech', 'it', 'sistemas'],
    'director de operaciones': ['operations', 'ops', 'operaciones'],
    
    // C-Level roles
    'ceo': ['ceo', 'gerencia', 'direccion'],
    'cto': ['cto', 'tech', 'technology'],
    'cfo': ['cfo', 'finance', 'finanzas'],
    'cmo': ['cmo', 'marketing', 'mercadeo'],
    
    // Departamentos
    'marketing': ['marketing', 'mercadeo', 'mkt'],
    'ventas': ['ventas', 'sales', 'comercial'],
    'sales': ['sales', 'ventas', 'comercial'],
    'recursos humanos': ['rrhh', 'hr', 'people'],
    'human resources': ['hr', 'rrhh', 'people'],
    'tecnología': ['tech', 'it', 'sistemas'],
    'technology': ['tech', 'it', 'sistemas'],
    'finanzas': ['finanzas', 'finance', 'contabilidad'],
    'finance': ['finance', 'finanzas', 'accounting'],
    'operaciones': ['ops', 'operaciones', 'operations'],
    'operations': ['operations', 'ops', 'operaciones'],
    'legal': ['legal', 'juridico', 'compliance'],
    'comunicaciones': ['comunicaciones', 'comm', 'prensa'],
    'communications': ['comm', 'comunicaciones', 'pr'],
    'diseño': ['design', 'diseno', 'creative'],
    'design': ['design', 'diseno', 'creative'],
    'producto': ['product', 'producto', 'pm'],
    'product': ['product', 'producto', 'pm'],
    'soporte': ['support', 'soporte', 'help'],
    'support': ['support', 'soporte', 'help'],
    
    // Roles genéricos al final (menos específicos)
    'director': ['gerencia', 'direccion'],
    'gerente': ['gerencia', 'management', 'direccion']
  };
  
  // Buscar coincidencias en el contexto (de más específico a menos específico)
  for (const [role, prefixes] of Object.entries(departmentMap)) {
    if (contextLower.includes(role)) {
      departments.push(...prefixes);
      break; // Usar solo la primera coincidencia (más específica)
    }
  }
  
  // Eliminar duplicados
  return Array.from(new Set(departments));
}

// Función para generar patrones de email comunes (ordenados por probabilidad)
function generateEmailPatterns(name: string, domain: string, context: string = ''): string[] {
  const cleanName = name.toLowerCase().trim();
  const nameParts = cleanName.split(' ').filter(part => part.length > 0);
  
  if (nameParts.length === 0) {
    return [];
  }
  
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
  const middleName = nameParts.length > 2 ? nameParts[1] : '';
  
  const personalPatterns = [];
  const departmentalPatterns = [];
  
  // Detectar lenguaje, región y patrones culturales
  const { language, region, cultural_patterns } = detectLanguageAndRegion(name, context);
  
  // Extraer departamentos del contexto
  const departments = extractDepartmentFromContext(context);
  
  // Generar patrones culturales específicos
  const culturalPatterns = generateCulturalEmailPatterns(name, domain, language, region, cultural_patterns);
  
  // PRIMERA PARTE: 10 PATRONES PERSONALES (ordenados por probabilidad y considerando cultura)
  if (firstName && lastName) {
    // Integrar patrones culturales en los primeros lugares si existen
    if (culturalPatterns.length > 0) {
      personalPatterns.push(...culturalPatterns.slice(0, 3)); // Primeros 3 culturales
    }
    
    // Patrones universales ordenados por probabilidad
    const universalPatterns = [];
    universalPatterns.push(`${firstName}.${lastName}@${domain}`); // Más común globalmente
    
    // Ajustar orden según región
    if (region === 'germany' || language === 'german') {
      universalPatterns.push(`${lastName}.${firstName}@${domain}`); // Común en Alemania
    }
    
    universalPatterns.push(`${firstName.charAt(0)}.${lastName}@${domain}`);
    universalPatterns.push(`${firstName.charAt(0)}${lastName}@${domain}`);
    universalPatterns.push(`${firstName}${lastName}@${domain}`);
    universalPatterns.push(`${firstName}_${lastName}@${domain}`);
    universalPatterns.push(`${firstName}@${domain}`);
    universalPatterns.push(`${firstName}.${lastName.charAt(0)}@${domain}`);
    
    if (region !== 'germany') {
      universalPatterns.push(`${lastName}.${firstName}@${domain}`);
    }
    
    universalPatterns.push(`${firstName}-${lastName}@${domain}`);
    
    // Nombre del medio
    if (middleName) {
      universalPatterns.push(`${firstName}.${middleName.charAt(0)}.${lastName}@${domain}`);
      universalPatterns.push(`${lastName}_${firstName}@${domain}`);
    } else {
      universalPatterns.push(`${lastName}_${firstName}@${domain}`);
      universalPatterns.push(`${firstName.charAt(0)}.${middleName ? middleName.charAt(0) + '.' : ''}${lastName.charAt(0)}@${domain}`);
    }
    
    // Agregar patrones universales (evitando duplicados)
    for (const pattern of universalPatterns) {
      if (!personalPatterns.includes(pattern) && personalPatterns.length < 10) {
        personalPatterns.push(pattern);
      }
    }
    
    // Completar con patrones culturales adicionales si es necesario
    if (personalPatterns.length < 10 && culturalPatterns.length > 3) {
      for (const pattern of culturalPatterns.slice(3)) {
        if (!personalPatterns.includes(pattern) && personalPatterns.length < 10) {
          personalPatterns.push(pattern);
        }
      }
    }
    
  } else if (firstName) {
    // Solo nombre disponible
    personalPatterns.push(`${firstName}@${domain}`);
    
    // Usar patrones culturales si están disponibles
    if (culturalPatterns.length > 0) {
      personalPatterns.push(...culturalPatterns.slice(0, 5));
    }
    
    // Completar con variaciones numeradas si es necesario
    for (let i = 1; personalPatterns.length < 10; i++) {
      const pattern = `${firstName}${i}@${domain}`;
      if (!personalPatterns.includes(pattern)) {
        personalPatterns.push(pattern);
      }
    }
  }
  
  // SEGUNDA PARTE: 5 PATRONES DEPARTAMENTALES O GENÉRICOS DE CONTACTO
  if (departments.length > 0 && firstName) {
    // Si se detectó departamento, generar patrones departamentales
    const primaryDept = departments[0]; // Usar el primer departamento detectado
    
    if (lastName) {
      // 1. Nombre completo en subdominio departamental
      departmentalPatterns.push(`${firstName}.${lastName}@${primaryDept}.${domain}`);
      
      // 2. Departamento como prefijo
      departmentalPatterns.push(`${primaryDept}.${firstName}@${domain}`);
      
      // 3. Solo nombre en subdominio departamental
      departmentalPatterns.push(`${firstName}@${primaryDept}.${domain}`);
      
      // 4. Departamento + apellido
      departmentalPatterns.push(`${primaryDept}.${lastName}@${domain}`);
      
      // 5. Inicial + departamento
      departmentalPatterns.push(`${firstName.charAt(0)}.${primaryDept}@${domain}`);
    } else {
      // Solo nombre disponible
      departmentalPatterns.push(`${firstName}@${primaryDept}.${domain}`);
      departmentalPatterns.push(`${primaryDept}.${firstName}@${domain}`);
      departmentalPatterns.push(`${primaryDept}@${domain}`);
      departmentalPatterns.push(`${firstName}.${primaryDept}@${domain}`);
      departmentalPatterns.push(`info.${primaryDept}@${domain}`);
    }
  } else {
    // Si NO se detectó departamento, generar emails genéricos de contacto
    // Considerar idioma/región para emails genéricos apropiados
    if (language === 'spanish' || region === 'hispanic') {
      departmentalPatterns.push(`info@${domain}`);
      departmentalPatterns.push(`contacto@${domain}`);
      departmentalPatterns.push(`ventas@${domain}`);
      departmentalPatterns.push(`hola@${domain}`);
      departmentalPatterns.push(`admin@${domain}`);
    } else {
      departmentalPatterns.push(`info@${domain}`);
      departmentalPatterns.push(`contact@${domain}`);
      departmentalPatterns.push(`admin@${domain}`);
      departmentalPatterns.push(`support@${domain}`);
      departmentalPatterns.push(`hello@${domain}`);
    }
  }
  
  // Combinar patrones: 10 personales + 5 departamentales/genéricos
  const allPatterns = [...personalPatterns.slice(0, 10), ...departmentalPatterns.slice(0, 5)];
  
  // Eliminar duplicados manteniendo el orden
  const seen = new Set<string>();
  const uniquePatterns = allPatterns.filter(pattern => {
    if (seen.has(pattern)) {
      return false;
    }
    seen.add(pattern);
    return true;
  });
  
  // Asegurar que siempre tengamos exactamente 15 emails
  if (uniquePatterns.length < 15) {
    // Si necesitamos más emails, generar variaciones adicionales
    const additionalPatterns = [];
    
    if (firstName && lastName) {
      // Generar más variaciones si es necesario
      const extraVariations = [
        `${lastName}.${firstName}@${domain}`,
        `${firstName}${lastName.charAt(0)}@${domain}`,
        `${firstName.charAt(0)}${lastName.charAt(0)}@${domain}`,
        `${firstName}1@${domain}`,
        `${firstName}2@${domain}`,
        `${lastName}@${domain}`,
        `${firstName.charAt(0)}.${lastName.charAt(0)}@${domain}`,
        `${firstName}_${lastName.charAt(0)}@${domain}`,
        `${firstName}.${lastName}1@${domain}`,
        `${firstName}-${lastName.charAt(0)}@${domain}`
      ];
      
      for (const pattern of extraVariations) {
        if (!seen.has(pattern) && uniquePatterns.length < 15) {
          uniquePatterns.push(pattern);
          seen.add(pattern);
        }
      }
    }
    
    // Si aún necesitamos más, agregar emails genéricos adicionales
    if (uniquePatterns.length < 15) {
      const moreGenericEmails = [
        `sales@${domain}`,
        `marketing@${domain}`,
        `office@${domain}`,
        `team@${domain}`,
        `general@${domain}`,
        `reception@${domain}`,
        `mail@${domain}`,
        `help@${domain}`,
        `service@${domain}`,
        `business@${domain}`
      ];
      
      for (const pattern of moreGenericEmails) {
        if (!seen.has(pattern) && uniquePatterns.length < 15) {
          uniquePatterns.push(pattern);
          seen.add(pattern);
        }
      }
    }
  }
  
  // Verificar si es un puesto directivo para agregar emails genéricos adicionales
  const isExecutive = isExecutivePosition(context);
  let finalPatterns = uniquePatterns.slice(0, 15);
  
  if (isExecutive) {
    // Para puestos directivos, agregar 5 emails genéricos adicionales
    const executiveGenericEmails = [];
    const { language, region } = detectLanguageAndRegion(name, context);
    
    if (language === 'spanish' || region === 'hispanic') {
      // Emails genéricos en español para ejecutivos
      const spanishExecutiveEmails = [
        `direccion@${domain}`,
        `gerencia@${domain}`,
        `presidencia@${domain}`,
        `ejecutivos@${domain}`,
        `administracion@${domain}`,
        `gestion@${domain}`,
        `corporativo@${domain}`,
        `directorio@${domain}`
      ];
      executiveGenericEmails.push(...spanishExecutiveEmails);
    } else {
      // Emails genéricos en inglés para ejecutivos
      const englishExecutiveEmails = [
        `management@${domain}`,
        `executive@${domain}`,
        `leadership@${domain}`,
        `board@${domain}`,
        `corporate@${domain}`,
        `executives@${domain}`,
        `administration@${domain}`,
        `governance@${domain}`
      ];
      executiveGenericEmails.push(...englishExecutiveEmails);
    }
    
    // Agregar emails genéricos que no estén duplicados
    const executiveSeen = new Set(finalPatterns);
    for (const email of executiveGenericEmails) {
      if (!executiveSeen.has(email) && finalPatterns.length < 20) {
        finalPatterns.push(email);
        executiveSeen.add(email);
      }
    }
  }
  
  return finalPatterns;
}

// Inicializar el sistema de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { 
      name, 
      domain,
      context = '',
      site_id
    } = body;
    
    // Validar parámetros requeridos
    if (!name || !domain || !site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'name, domain, and site_id are required' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidDomain(domain)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'domain must be a valid domain format (e.g., company.com)' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Obtener información del sitio para evitar confusiones de dominio
    let siteUrl: string | null = null;
    let siteDomainNote: string | null = null;
    try {
      const { data: siteData } = await supabaseAdmin
        .from('sites')
        .select('url')
        .eq('id', site_id)
        .single();
      siteUrl = siteData?.url || null;
      siteDomainNote = extractDomainFromUrl(siteUrl);
    } catch {
      // Si falla, continuamos sin bloquear el flujo
      siteUrl = null;
      siteDomainNote = null;
    }
    
    // Buscar agente Data Analyst
    const dataAnalystAgent = await findDataAnalystAgent(site_id);
    if (!dataAnalystAgent) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATA_ANALYST_NOT_FOUND', 
            message: 'No se encontró un agente con role "Data Analyst" para este sitio' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log(`📧 Iniciando generación de emails de contacto para: ${name} en dominio: ${domain}`);
    
    // Detectar información cultural para el contexto
    const culturalInfo = detectLanguageAndRegion(name, context);
    
    // Generar patrones básicos de email
    const basicEmailPatterns = generateEmailPatterns(name, domain, context);
    
    // Crear contexto para el análisis de IA
    const emailGenerationContext = `Lead Contact Email Generation Request:

CONTACT INFORMATION:
- Name: ${name}
- Domain: ${domain}
- Additional Context: ${context}
\nSITE INFORMATION (for disambiguation only):
- Site URL: ${siteUrl || 'N/A'}
- Site Domain: ${siteDomainNote || 'N/A'}

CULTURAL ANALYSIS:
- Detected Language: ${culturalInfo.language}
- Detected Region: ${culturalInfo.region}
- Cultural Patterns: ${culturalInfo.cultural_patterns.join(', ') || 'None detected'}

BASIC EMAIL PATTERNS GENERATED (${basicEmailPatterns.length} patterns):
${basicEmailPatterns.map((email, index) => `${index + 1}. ${email}`).join('\n')}

TASK REQUIREMENTS:
Please analyze the provided name, domain, and context to generate a comprehensive list of email addresses for this contact:

**EXECUTIVE POSITIONS** (CEO, Director, President, Founder, VP, etc.): Generate EXACTLY 20 emails
**NON-EXECUTIVE POSITIONS**: Generate EXACTLY 15 emails

EMAIL STRUCTURE:
- FIRST 10 EMAILS: Personal email patterns (ordered from most probable to least probable)
- NEXT 5 EMAILS: Department/role-specific email patterns OR generic contact emails
- LAST 5 EMAILS (EXECUTIVES ONLY): Additional generic executive contact emails

MANDATORY EMAIL STRUCTURE:
1. **Personal Patterns (10 emails)**: Use name variations with cultural considerations
2. **Departmental/Generic Patterns (5 emails)**: 
   - IF role/department detected in context: Use department-specific patterns (e.g., sales.firstname@domain.com, firstname@marketing.domain.com)
   - IF NO clear role/department: Use generic contact patterns (e.g., info@domain.com, contact@domain.com, admin@domain.com, support@domain.com, hello@domain.com)
3. **Executive Generic Patterns (5 emails - ONLY for executive positions)**:
   - Spanish/Hispanic: direccion@domain.com, gerencia@domain.com, presidencia@domain.com, ejecutivos@domain.com, administracion@domain.com
   - English/Other: management@domain.com, executive@domain.com, leadership@domain.com, board@domain.com, corporate@domain.com

Consider:

1. **Cultural Context**: Use the detected language (${culturalInfo.language}) and region (${culturalInfo.region}) information
2. **Naming Conventions**: Consider cultural naming patterns (${culturalInfo.cultural_patterns.join(', ') || 'standard international'})
3. **Regional Preferences**: 
   - Hispanic names: Often use compound first names and both paternal/maternal surnames
   - German names: Prefer lastname.firstname order in business contexts
   - Dutch names: Handle tussenvoegsel (van, de, der) appropriately
   - French names: Consider hyphenated names and formal address patterns
4. Common email naming conventions (firstname.lastname is most common ~90% globally)
5. Industry-specific email formats considering regional business culture
6. **Department-specific email patterns**: 
   - With subdomain: firstname@sales.domain.com, firstname@marketing.domain.com
   - With prefix: sales.firstname@domain.com, marketing.firstname@domain.com
   - Role-based: manager.firstname@domain.com, director.firstname@domain.com
7. **Generic contact emails** (when no department detected):
   - info@domain.com, contact@domain.com, admin@domain.com
   - support@domain.com, hello@domain.com, ventas@domain.com (for Spanish)
   - hola@domain.com, contacto@domain.com (for Hispanic regions)
8. Cultural variations in separators and ordering
9. Use of initials vs full names (varies by culture and hierarchy)
10. Regional business communication preferences
11. Company size influence adapted to regional business practices
12. Language-specific character handling (accents, special characters)

CRITICAL REQUIREMENTS: 
- EXECUTIVE POSITIONS: Generate EXACTLY 20 emails (15 standard + 5 executive generic)
- NON-EXECUTIVE POSITIONS: Generate EXACTLY 15 emails
- If role/department detected: Include department-specific patterns in emails 11-15
- If NO role/department detected: Include generic contact emails in emails 11-15
- For EXECUTIVES: Include executive generic emails in emails 16-20
- Apply cultural naming conventions based on detected language/region
- Consider regional business email etiquette and formality levels
\nABSOLUTE DOMAIN POLICY (Do NOT violate):
- Use ONLY the lead's domain provided: ${domain}
- The site's/company's domain is ${siteDomainNote || 'N/A'} (from ${siteUrl || 'N/A'}).
- NEVER use or propose any email address on the site's/company's domain or any of its subdomains.
- Do NOT confuse the site's domain with the lead's domain. All generated emails MUST be on ${domain}.

EXECUTIVE POSITION DETECTION:
Consider these roles as executive positions requiring 20 emails: CEO, CTO, CFO, CMO, COO, Director, President, VP, Vice President, Founder, Co-founder, Owner, Partner, General Manager, Country Manager, Regional Manager, Executive, Senior Manager, Managing Director, Executive Director.

IMPORTANT: Return the emails in strict order of probability considering both universal patterns and cultural context. Provide confidence scores (0-1) for each email and reasoning for the pattern selection including cultural considerations.`;
    
    const commandData = CommandFactory.createCommand({
      task: 'generate contact email addresses for lead',
      userId: dataAnalystAgent.userId,
      description: `Lead Contact Email Generation for ${name} at ${domain}`,
      agentId: dataAnalystAgent.agentId,
      site_id: site_id,
      context: emailGenerationContext.trim(),
      targets: [
        {
          email_generation_analysis: {
            confidence_scores: 'array',
            recommendations: 'array',
            email_patterns_analysis: {
              industry_considerations: 'string',
              cultural_considerations: 'string',
              pattern_reasoning: 'string', 
              pattern_confidence: 'number',
              most_likely_pattern: 'string'
            },
            generated_emails: 'array',
            domain: 'string',
            contact_name: 'string'
          }
        }
      ],
      tools: [],
      supervisor: [
        {
          agent_role: 'email_generation_manager',
          status: 'not_initialized'
        }
      ],
      // Set model to 4o
      model: 'gpt-4o',
      modelType: 'openai'
    });
    
    console.log(`🔧 Creando comando de generación de emails de contacto`);
    
    // Enviar comando para ejecución
    const internalCommandId = await commandService.submitCommand(commandData);
    
    console.log(`📝 Comando de generación de emails creado: ${internalCommandId}`);
    
    // Obtener el UUID real del comando buscando en la base de datos
    let realCommandId = null;
    try {
      // Buscar el comando más reciente para este agente
      const { data: recentCommands, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('agent_id', dataAnalystAgent.agentId)
        .eq('description', `Lead Contact Email Generation for ${name} at ${domain}`)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && recentCommands && recentCommands.length > 0) {
        realCommandId = recentCommands[0].id;
        console.log(`🔍 UUID real del comando encontrado: ${realCommandId}`);
      }
    } catch (error) {
      console.log('No se pudo obtener el UUID del comando desde BD, usando ID interno');
    }
    
    // Si no tenemos el UUID real, usar el ID interno
    const commandIdToSearch = realCommandId || internalCommandId;
    
    // Esperar a que el comando se complete
    let completedCommand = null;
    // Detectar si estamos en entorno de test para reducir tiempos
    const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
    const maxRetries = isTestEnvironment ? 5 : 580; // 5 intentos en test, 580 en producción (~4.8 minutos)
    const retryDelay = isTestEnvironment ? 10 : 500; // 10ms en test, 500ms en producción
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Buscar comando en base de datos por ID
        const { data: commandData, error } = await supabaseAdmin
          .from('commands')
          .select('*')
          .eq('id', commandIdToSearch)
          .single();
        
        if (!error && commandData) {
          if (commandData.status === 'completed') {
            completedCommand = commandData;
            console.log(`✅ Comando completado después de ${attempt + 1} intentos`);
            break;
          } else if (commandData.status === 'failed') {
            console.error(`❌ Comando falló después de ${attempt + 1} intentos`);
            return NextResponse.json(
              { 
                success: false, 
                error: { 
                  code: 'COMMAND_EXECUTION_FAILED', 
                  message: 'Lead contact email generation command failed to execute',
                  commandId: commandIdToSearch
                } 
              },
              { status: 500 }
            );
          }
        }
        
        // Si no está completado, esperar antes del siguiente intento
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        console.log(`Intento ${attempt + 1}/${maxRetries}: Comando aún procesándose...`);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    if (!completedCommand) {
      console.log('⚠️ Comando no completado después del tiempo máximo de espera');
    }
    
    // Preparar respuesta base
    const responseData: any = {
      commandId: commandIdToSearch,
      status: completedCommand ? 'completed' : 'timeout',
      message: completedCommand ? 'Lead contact email generation completed' : 'Lead contact email generation timed out - command may still be processing',
      agent_id: dataAnalystAgent.agentId,
      contact_name: name,
      domain: domain,
      context: context,
      site_id: site_id,
      basic_patterns_generated: basicEmailPatterns,
      site_url: siteUrl,
      site_domain_note: siteDomainNote,
      timestamp: new Date().toISOString()
    };

    // Si el comando está completado, extraer los resultados del análisis
    let emailGenerationResult = null;
    if (completedCommand && completedCommand.results) {
      try {
        const results = Array.isArray(completedCommand.results) ? completedCommand.results : [completedCommand.results];
        const resultWithEmailGeneration = results.find((result: any) => result.email_generation_analysis);
        
        if (resultWithEmailGeneration) {
          emailGenerationResult = resultWithEmailGeneration.email_generation_analysis;
          responseData.email_generation_analysis = emailGenerationResult;
        }
      } catch (error) {
        console.error('Error extracting email_generation_analysis from completed command:', error);
      }
    }
    
    // Si no hay resultados de IA, usar los patrones básicos generados
    if (!emailGenerationResult && basicEmailPatterns.length > 0) {
      responseData.fallback_emails = basicEmailPatterns;
      responseData.message += ' - Using basic pattern generation as fallback';
    }
    
    return NextResponse.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Error en ruta leadContactGeneration:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
}
