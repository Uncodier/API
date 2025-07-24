/**
 * Utilitario para normalizar números de teléfono y generar variantes para búsqueda
 * Maneja diferentes formatos como códigos de país, ladas, y caracteres de formato
 */

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
  
  // Si empieza con +, generar variantes sin el +
  if (cleaned.startsWith('+')) {
    const withoutPlus = cleaned.substring(1);
    variants.push(withoutPlus);
    
    // Para números mexicanos (+52), generar variantes adicionales
    if (withoutPlus.startsWith('52')) {
      const without52 = withoutPlus.substring(2);
      variants.push(without52);
      
      // Si después del 52 viene un 1 (lada), generar variante sin el 1
      if (without52.startsWith('1') && without52.length > 1) {
        const without521 = without52.substring(1);
        variants.push(without521);
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
  
  // Remover duplicados y números vacíos
  const uniqueVariants = Array.from(new Set(variants)).filter(v => v.length > 0);
  
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

  // Remover espacios, guiones, paréntesis, puntos, etc.
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  
  // Remover caracteres no numéricos excepto el + inicial
  cleaned = cleaned.replace(/[^\d+]/g, '');
  
  // Si ya tiene formato internacional (+), mantenerlo
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  // Si no tiene +, determinar si agregar código de país
  // Para números de 10 dígitos en México, agregar +52
  if (cleaned.length === 10 && /^[1-9]/.test(cleaned)) {
    return `+52${cleaned}`;
  }
  
  // Para números de 11 dígitos que empiecen con 1, podría ser +52 1 (lada)
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+52${cleaned}`;
  }
  
  // Para números de 12 dígitos que empiecen con 52, agregar +
  if (cleaned.length === 12 && cleaned.startsWith('52')) {
    return `+${cleaned}`;
  }
  
  // Para otros casos, retornar el número limpio sin modificar
  return cleaned;
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