/**
 * Ejemplo de uso de la API de validación de emails con NeverBounce
 * 
 * Este ejemplo muestra cómo usar la integración de NeverBounce para validar
 * direcciones de email antes de procesarlas en tu aplicación.
 */

interface EmailValidationResult {
  success: true;
  data: {
    email: string;
    isValid: boolean;
    result: string;
    flags: string[];
    suggested_correction: string | null;
    execution_time: number;
    message: string;
    timestamp: string;
  };
}

interface EmailValidationError {
  success: false;
  error: {
    code: string;
    message: string;
    details: string;
  };
}

/**
 * Valida una dirección de email usando la API de NeverBounce
 */
export async function validateEmail(email: string): Promise<EmailValidationResult | EmailValidationError> {
  try {
    const response = await fetch('/api/integrations/neverbounce/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Error validating email');
    }

    return result;
  } catch (error: any) {
    return {
      error: 'Validation failed',
      message: error.message || 'Unknown error occurred',
    };
  }
}

/**
 * Valida múltiples emails de forma secuencial
 */
export async function validateEmailList(emails: string[]): Promise<EmailValidationResult[]> {
  const results: EmailValidationResult[] = [];
  
  for (const email of emails) {
    const result = await validateEmail(email);
    
    // Solo agregar si es un resultado válido (no error)
    if ('success' in result && result.success) {
      results.push(result);
    } else {
      // Agregar resultado de error como inválido
      results.push({
        success: true,
        data: {
          email,
          isValid: false,
          result: 'error',
          flags: ['validation_error'],
          suggested_correction: null,
          execution_time: 0,
          message: 'success' in result ? result.error.message : 'Validation failed',
          timestamp: new Date().toISOString()
        }
      });
    }
    
    // Pequeña pausa entre validaciones para evitar rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * Filtra una lista de emails, retornando solo los válidos
 */
export async function filterValidEmails(emails: string[]): Promise<string[]> {
  const results = await validateEmailList(emails);
  return results.filter(result => result.data.isValid).map(result => result.data.email);
}

/**
 * Ejemplo de uso en un formulario de registro
 */
export async function validateRegistrationEmail(email: string): Promise<{
  isValid: boolean;
  message: string;
  suggestion?: string;
}> {
  const result = await validateEmail(email);
  
  if (!result.success) {
    return {
      isValid: false,
      message: `Error al validar email: ${result.error.message}`
    };
  }
  
  if (!result.data.isValid) {
    let message = 'La dirección de email no es válida';
    
    switch (result.data.result) {
      case 'invalid':
        message = 'La dirección de email no existe o no puede recibir correos';
        break;
      case 'disposable':
        message = 'No se permiten direcciones de email temporales o desechables';
        break;
      case 'catchall':
        message = 'Esta dirección podría no ser específica (dominio catch-all)';
        break;
      case 'unknown':
        message = 'No se pudo verificar la validez de esta dirección de email';
        break;
    }
    
    return {
      isValid: false,
      message,
      suggestion: result.data.suggested_correction || undefined
    };
  }
  
  // Verificar flags adicionales para dar advertencias
  const warnings: string[] = [];
  
  if (result.data.flags.includes('role_account')) {
    warnings.push('Esta parece ser una cuenta de rol (ej: info@, admin@)');
  }
  
  if (result.data.flags.includes('free_email_host')) {
    warnings.push('Esta es una dirección de email gratuita');
  }
  
  return {
    isValid: true,
    message: warnings.length > 0 
      ? `Email válido. Nota: ${warnings.join(', ')}`
      : 'Email válido y verificado'
  };
}

/**
 * Función para limpiar una lista de emails eliminando duplicados e inválidos
 */
export async function cleanEmailList(emails: string[]): Promise<{
  originalCount: number;
  cleanedEmails: string[];
  removedCount: number;
  invalidEmails: string[];
  duplicatesRemoved: number;
}> {
  const originalCount = emails.length;
  
  // Remover duplicados
  const uniqueEmails = [...new Set(emails.map(email => email.toLowerCase().trim()))];
  const duplicatesRemoved = originalCount - uniqueEmails.length;
  
  // Validar emails únicos
  const results = await validateEmailList(uniqueEmails);
  
  const cleanedEmails: string[] = [];
  const invalidEmails: string[] = [];
  
  results.forEach(result => {
    if (result.data.isValid) {
      cleanedEmails.push(result.data.email);
    } else {
      invalidEmails.push(result.data.email);
    }
  });
  
  return {
    originalCount,
    cleanedEmails,
    removedCount: invalidEmails.length,
    invalidEmails,
    duplicatesRemoved
  };
}

// Ejemplo de uso:
/*
async function example() {
  // Validar un email individual
  const validation = await validateRegistrationEmail('test@example.com');
  console.log('Validación:', validation);
  
  // Limpiar una lista de emails
  const emailList = [
    'valid@example.com',
    'invalid@notreal.xyz',
    'test@10minutemail.com', // desechable
    'valid@example.com', // duplicado
  ];
  
  const cleaned = await cleanEmailList(emailList);
  console.log('Lista limpia:', cleaned);
}
*/