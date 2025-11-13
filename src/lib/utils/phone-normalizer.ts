/**
 * Utilitario para normalizar números de teléfono y generar variantes para búsqueda
 * Maneja diferentes formatos como códigos de país, ladas, y caracteres de formato
 */

// Cache for normalization results
const searchCache = new Map<string, string[]>();
const storageCache = new Map<string, string>();

/**
 * Generates a normalized cache key by removing spaces and formatting characters
 * This ensures that "+52 5544414173" and "+525544414173" use the same cache entry
 * 
 * @param phone - Phone number in any format
 * @returns Normalized cache key (cleaned phone number)
 */
function getCacheKey(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return '';
  }
  // Remove spaces, dashes, parentheses, dots, etc.
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  // Remove non-numeric characters except the initial +
  cleaned = cleaned.replace(/[^\d+]/g, '');
  return cleaned;
}

/**
 * Generates variants with spaces for international format numbers
 * This helps match numbers stored with spaces (e.g., "+52 5544414173")
 * 
 * @param cleaned - Cleaned phone number (no spaces)
 * @returns Array of variants with common spacing patterns
 */
function generateSpacedVariants(cleaned: string): string[] {
  const variants: string[] = [];
  
  // Only generate spaced variants for international format (+XX...)
  if (!cleaned.startsWith('+')) {
    return variants;
  }
  
  const withoutPlus = cleaned.substring(1);
  
  // Pattern 1: +XX XXXXXXXXXX (country code + space + rest)
  // For Mexico (+52): +52 XXXXXXXXXX
  if (withoutPlus.length >= 10) {
    // Try country codes of 1, 2, or 3 digits
    for (let ccLen = 1; ccLen <= 3 && ccLen < withoutPlus.length; ccLen++) {
      const cc = withoutPlus.substring(0, ccLen);
      const rest = withoutPlus.substring(ccLen);
      
      // +XX XXXXXXXXXX
      if (rest.length >= 10) {
        variants.push(`+${cc} ${rest}`);
      }
      
      // +XX XX XXXX XXXX (common formatting for 10-digit numbers)
      if (rest.length === 10) {
        const area = rest.substring(0, 2);
        const part1 = rest.substring(2, 6);
        const part2 = rest.substring(6);
        variants.push(`+${cc} ${area} ${part1} ${part2}`);
      }
      
      // +XX XXXXXXXXX (9 digits)
      if (rest.length === 9) {
        variants.push(`+${cc} ${rest}`);
      }
    }
  }
  
  return variants;
}

/**
 * Normaliza un número de teléfono removiendo caracteres de formato
 * y generando las variantes más comunes para búsqueda
 * 
 * @param phone - Número de teléfono en cualquier formato
 * @returns Array de variantes normalizadas del número para búsqueda
 */
export function normalizePhoneForSearch(phone: string): string[] {
  if (!phone || typeof phone !== 'string') {
    return [];
  }

  // Check cache first using normalized key
  const cacheKey = getCacheKey(phone);
  if (cacheKey && searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`📞 [Cache Hit] Variantes desde cache para "${phone}" (key: ${cacheKey}): ${cached.length} variantes`);
      return cached;
    }
  }

  // Remover espacios, guiones, paréntesis, puntos, etc.
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  
  // Remover caracteres no numéricos excepto el + inicial
  cleaned = cleaned.replace(/[^\d+]/g, '');
  
  // Array para almacenar todas las variantes posibles
  const variants: string[] = [];
  
  // Agregar el número original limpio si no está vacío
  if (cleaned && cleaned.length > 0) {
    variants.push(cleaned);
  }
  
  // Detectar y convertir prefijos internacionales comunes a formato +
  if (cleaned.startsWith('00')) {
    const withPlus = `+${cleaned.substring(2)}`;
    variants.push(withPlus);
    cleaned = withPlus;
  } else if (cleaned.startsWith('011')) {
    const withPlus = `+${cleaned.substring(3)}`;
    variants.push(withPlus);
    cleaned = withPlus;
  }

  // Si empieza con +, generar variantes sin el + y probar múltiples particiones de código de país (1-3 dígitos)
  if (cleaned.startsWith('+')) {
    const withoutPlus = cleaned.substring(1);
    variants.push(withoutPlus);

    const digits = withoutPlus;
    if (/^\d{7,15}$/.test(digits)) {
      // Probar CC de 1, 2 y 3 dígitos
      for (let ccLen = 1; ccLen <= 3 && ccLen < digits.length; ccLen++) {
        const cc = digits.substring(0, ccLen);
        const rest = digits.substring(ccLen);
        // Variante completa
        variants.push(`+${cc}${rest}`);
        variants.push(`${cc}${rest}`);
        // Quitar un posible dígito de marcación nacional (0,1,9)
        if (rest.length > 1 && (rest.startsWith('0') || rest.startsWith('1') || rest.startsWith('9'))) {
          const restNoTrunk = rest.substring(1);
          variants.push(`+${cc}${restNoTrunk}`);
          variants.push(`${cc}${restNoTrunk}`);
          // Also add the rest without country code (for cases like +5215555551234 -> 15555551234)
          variants.push(rest);
        }
      }
    }
  } else {
    // Si no empieza con +, generar variantes con códigos comunes
    
    // Agregar variante con +52 (México)
    variants.push(`+52${cleaned}`);
    variants.push(`52${cleaned}`);
    
    // Si el número tiene 10 dígitos, podría ser un número mexicano sin lada
    // Agregar variante con lada 1
    if (cleaned.length === 10) {
      variants.push(`+521${cleaned}`);
      variants.push(`521${cleaned}`);
    }
    
    // Si el número tiene 11 dígitos y empieza con 1, podría ser con lada
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      const withoutLeading1 = cleaned.substring(1);
      variants.push(withoutLeading1);
      variants.push(`+52${withoutLeading1}`);
      variants.push(`52${withoutLeading1}`);
    }
  }

  // Incluir también la forma canónica de almacenamiento para asegurar matching
  try {
    const canonical = normalizePhoneForStorage(phone);
    if (canonical) {
      variants.push(canonical);
      if (canonical.startsWith('+')) {
        variants.push(canonical.substring(1));
      }
    }
  } catch (_) {}

  // Variante de últimos 10 dígitos como fallback de matching (cuidadosa para colisiones)
  const digitsOnly = cleaned.replace(/[^\d]/g, '');
  if (digitsOnly.length >= 10) {
    variants.push(digitsOnly.slice(-10));
  }
  
  // Add variants with spaces to match numbers stored with spaces
  // This is critical for matching "+52 5544414173" with "+525544414173"
  const spacedVariants = generateSpacedVariants(cleaned);
  variants.push(...spacedVariants);
  
  // Remover duplicados y números vacíos
  const uniqueVariants = Array.from(new Set(variants)).filter(v => v.length > 0);
  
  // Store in cache using normalized key
  if (cacheKey) {
    searchCache.set(cacheKey, uniqueVariants);
    console.log(`📞 [Cache Set] Variantes guardadas en cache para "${phone}" (key: ${cacheKey}): ${uniqueVariants.length} variantes`);
  }
  
  console.log(`📞 Generadas ${uniqueVariants.length} variantes para "${phone}": ${uniqueVariants.join(', ')}`);
  
  return uniqueVariants;
}

/**
 * Normaliza un número de teléfono para almacenamiento
 * Intenta mantener el formato más completo disponible
 * 
 * @param phone - Número de teléfono en cualquier formato
 * @returns Número normalizado para almacenamiento
 */
export function normalizePhoneForStorage(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return '';
  }

  // Check cache first using normalized key
  const cacheKey = getCacheKey(phone);
  if (cacheKey && storageCache.has(cacheKey)) {
    const cached = storageCache.get(cacheKey);
    if (cached !== undefined) {
      console.log(`📞 [Cache Hit] Normalización desde cache para "${phone}" (key: ${cacheKey}): "${cached}"`);
      return cached;
    }
  }

  // Remover espacios, guiones, paréntesis, puntos, etc.
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  
  // Remover caracteres no numéricos excepto el + inicial
  cleaned = cleaned.replace(/[^\d+]/g, '');

  // Convertir prefijos internacionales comunes a +
  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.substring(2)}`;
  } else if (cleaned.startsWith('011')) {
    cleaned = `+${cleaned.substring(3)}`;
  }
  
  // Si ya tiene formato internacional (+), normalizar trunk digit tras código de país (0/1/9) de forma genérica
  if (cleaned.startsWith('+')) {
    // Caso específico MX histórico: +521XXXXXXXXXX -> +52XXXXXXXXXX
    if (/^\+521\d{10}$/.test(cleaned)) {
      return `+52${cleaned.substring(4)}`;
    }
    // Regla genérica: quitar un único 0 inmediatamente después del código de país si aparece (trunk local)
    const m = cleaned.match(/^(\+\d{1,3})0(\d{6,14})$/);
    if (m) {
      return `${m[1]}${m[2]}`;
    }
    return cleaned;
  }
  
  // Si no tiene +, determinar si agregar código de país
  // Para números de 10 dígitos en México, agregar +52
  if (cleaned.length === 10 && /^[1-9]/.test(cleaned)) {
    return `+52${cleaned}`;
  }
  
  // Mantener heurística MX existente (compatibilidad)
  // Para números de 11 dígitos que empiezan con 1, mantener el 1 como parte del número
  // Esto es para casos como 15555551234 -> +5215555551234 (no +525555551234)
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+52${cleaned}`;
  }
  
  // Para números de 12 dígitos que empiecen con 52, agregar +
  if (cleaned.length === 12 && cleaned.startsWith('52')) {
    return `+${cleaned}`;
  }
  
  // Para otros casos, retornar el número limpio sin modificar
  const result = cleaned;
  
  // Store in cache using normalized key
  if (cacheKey) {
    storageCache.set(cacheKey, result);
    console.log(`📞 [Cache Set] Normalización guardada en cache para "${phone}" (key: ${cacheKey}): "${result}"`);
  }
  
  return result;
}

/**
 * Verifica si dos números de teléfono son equivalentes
 * considerando diferentes formatos y códigos de país
 * 
 * @param phone1 - Primer número a comparar
 * @param phone2 - Segundo número a comparar
 * @returns true si los números son equivalentes
 */
export function arePhoneNumbersEquivalent(phone1: string, phone2: string): boolean {
  if (!phone1 || !phone2) {
    return false;
  }
  
  const variants1 = normalizePhoneForSearch(phone1);
  const variants2 = normalizePhoneForSearch(phone2);
  
  // Verificar si alguna variante del primer número coincide con alguna del segundo
  return variants1.some(v1 => variants2.includes(v1));
} 

/**
 * Intenta rescatar un número de teléfono que no está en formato internacional válido
 * aplicando heurísticas comunes para diferentes países y prefijos
 * 
 * @param phone - Número de teléfono en formato problemático
 * @returns Número normalizado en formato internacional o null si no se puede rescatar
 */
export function attemptPhoneRescue(phone: string): string | null {
  if (!phone || typeof phone !== 'string') {
    return null;
  }

  console.log(`🔧 [PhoneRescue] Intentando rescatar: "${phone}"`);

  // Limpiar el número de caracteres de formato
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  cleaned = cleaned.replace(/[^\d+]/g, '');
  
  if (!cleaned) {
    console.log(`❌ [PhoneRescue] Número vacío después de limpiar`);
    return null;
  }

  // Si ya está en formato internacional válido, retornarlo
  if (cleaned.startsWith('+') && /^\+[1-9]\d{6,14}$/.test(cleaned)) {
    console.log(`✅ [PhoneRescue] Ya está en formato válido: ${cleaned}`);
    return cleaned;
  }

  console.log(`🔍 [PhoneRescue] Número limpio: "${cleaned}"`);

  // Array de intentos de rescate
  const rescueAttempts: string[] = [];

  // Remover el + si existe para procesar el número
  const numberOnly = cleaned.startsWith('+') ? cleaned.substring(1) : cleaned;

  // 1. Intentar remover prefijos de salida comunes
  let processedNumber = numberOnly;
  
  // Remover prefijos "011" primero (código de salida internacional en algunos países)
  if (processedNumber.startsWith('011')) {
    processedNumber = processedNumber.substring(3);
    console.log(`🔄 [PhoneRescue] Removido prefijo "011": ${processedNumber}`);
  }
  // Remover prefijos "00" (código de salida internacional común)
  else if (processedNumber.startsWith('00')) {
    processedNumber = processedNumber.substring(2);
    console.log(`🔄 [PhoneRescue] Removido prefijo "00": ${processedNumber}`);
  }
  // Remover prefijos "01" (código de salida nacional común en algunos países)
  else if (processedNumber.startsWith('01')) {
    processedNumber = processedNumber.substring(2);
    console.log(`🔄 [PhoneRescue] Removido prefijo "01": ${processedNumber}`);
  }

  // 2. Aplicar heurísticas basadas en la longitud del número
  
  // Para números de 10 dígitos - Asumir México sin código de país
  if (processedNumber.length === 10 && /^[1-9]/.test(processedNumber)) {
    rescueAttempts.push(`+52${processedNumber}`);
    console.log(`🇲🇽 [PhoneRescue] Intento México (10 dígitos): +52${processedNumber}`);
  }
  
  // Para números de 11 dígitos
  if (processedNumber.length === 11) {
    // Si empieza con 1, podría ser México con lada
    if (processedNumber.startsWith('1')) {
      rescueAttempts.push(`+52${processedNumber}`);
      console.log(`🇲🇽 [PhoneRescue] Intento México con lada (11 dígitos): +52${processedNumber}`);
    }
    // Si empieza con otro dígito, podría ser un número de 10 dígitos con un 1 extra
    else {
      rescueAttempts.push(`+52${processedNumber.substring(1)}`);
      console.log(`🇲🇽 [PhoneRescue] Intento México removiendo primer dígito: +52${processedNumber.substring(1)}`);
    }
  }
  
  // Para números de 12 dígitos
  if (processedNumber.length === 12) {
    // Si empieza con 52, podría ser México sin +
    if (processedNumber.startsWith('52')) {
      rescueAttempts.push(`+${processedNumber}`);
      console.log(`🇲🇽 [PhoneRescue] Intento México (12 dígitos con 52): +${processedNumber}`);
    }
    // Si no empieza con 52, intentar como México
    else {
      rescueAttempts.push(`+52${processedNumber.substring(2)}`);
      console.log(`🇲🇽 [PhoneRescue] Intento México removiendo 2 dígitos: +52${processedNumber.substring(2)}`);
    }
  }
  
  // Para números de 13 dígitos
  if (processedNumber.length === 13) {
    // Si empieza con 521, podría ser México con lada sin +
    if (processedNumber.startsWith('521')) {
      rescueAttempts.push(`+${processedNumber}`);
      console.log(`🇲🇽 [PhoneRescue] Intento México con lada (13 dígitos): +${processedNumber}`);
    }
  }

  // 3. Otros códigos de país comunes
  if (processedNumber.length === 10) {
    // Estados Unidos/Canadá (+1)
    rescueAttempts.push(`+1${processedNumber}`);
    console.log(`🇺🇸 [PhoneRescue] Intento USA/Canadá: +1${processedNumber}`);
    
    // España (+34)
    rescueAttempts.push(`+34${processedNumber}`);
    console.log(`🇪🇸 [PhoneRescue] Intento España: +34${processedNumber}`);
  }

  // 4. Intentar con el número tal como está si tiene longitud razonable
  if (processedNumber.length >= 7 && processedNumber.length <= 15) {
    rescueAttempts.push(`+${processedNumber}`);
    console.log(`🌍 [PhoneRescue] Intento genérico: +${processedNumber}`);
  }

  // 5. Validar cada intento y retornar el primero válido
  const phoneRegex = /^\+[1-9]\d{6,14}$/;
  
  for (const attempt of rescueAttempts) {
    if (phoneRegex.test(attempt)) {
      console.log(`✅ [PhoneRescue] Rescate exitoso: "${phone}" -> "${attempt}"`);
      return attempt;
    } else {
      console.log(`❌ [PhoneRescue] Intento fallido (formato inválido): ${attempt}`);
    }
  }

  console.log(`❌ [PhoneRescue] No se pudo rescatar el número: "${phone}"`);
  return null;
} 