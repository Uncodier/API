/**
 * Ejemplos de uso del EmailSignatureService
 * 
 * Este archivo demuestra cómo usar el servicio de firmas
 * en diferentes escenarios típicos.
 */

import { EmailSignatureService } from './EmailSignatureService';

// Ejemplo 1: Generar firma básica para un agente
async function generateBasicSignature() {
  const signature = await EmailSignatureService.generateAgentSignature(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'María González'
  );
  
  console.log('=== Firma en Texto Plano ===');
  console.log(signature.plainText);
  
  console.log('\n=== Firma Formateada ===');
  console.log(signature.formatted);
}

// Ejemplo 2: Generar firma sin nombre de agente (genérica)
async function generateGenericSignature() {
  const signature = await EmailSignatureService.generateAgentSignature(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  );
  
  console.log('=== Firma Genérica ===');
  console.log(signature.formatted);
}

// Ejemplo 3: Uso en el contexto de un email
async function handleEmailContext() {
  const emailMessage = `Hola Juan,

Gracias por contactarnos. He revisado tu consulta sobre los servicios de desarrollo web.

Estaremos encantados de ayudarte con tu proyecto. Te enviaremos una propuesta detallada en las próximas 24 horas.

¿Hay algo específico que te gustaría que incluyamos en la propuesta?

Saludos,`;

  const signature = await EmailSignatureService.generateAgentSignature(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Carlos Rodríguez'
  );

  const finalEmail = emailMessage + '\n\n' + signature.formatted;
  
  console.log('=== Email Completo con Firma ===');
  console.log(finalEmail);
}

// Ejemplo 4: Manejo de errores
async function handleErrors() {
  try {
    // Intentar con un site_id que no existe
    const signature = await EmailSignatureService.generateAgentSignature(
      'invalid-site-id',
      'Test Agent'
    );
    
    console.log('=== Firma de Fallback ===');
    console.log(signature.formatted);
  } catch (error) {
    console.error('Error generando firma:', error);
  }
}

// Función principal para ejecutar todos los ejemplos
async function runAllExamples() {
  console.log('🔥 Ejemplos de EmailSignatureService\n');
  
  try {
    await generateBasicSignature();
    console.log('\n' + '='.repeat(50) + '\n');
    
    await generateGenericSignature();
    console.log('\n' + '='.repeat(50) + '\n');
    
    await handleEmailContext();
    console.log('\n' + '='.repeat(50) + '\n');
    
    await handleErrors();
    
  } catch (error) {
    console.error('Error ejecutando ejemplos:', error);
  }
}

// Ejemplos de diferentes formatos de respuesta
export const signatureExamples = {
  // Ejemplo de firma completa con logo en formato de 2 columnas
  complete: `
    <table style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; border-collapse: collapse; width: 100%; max-width: 400px;">
      <tr>
        <td style="vertical-align: middle; padding-right: 15px; width: 60px; text-align: center;">
          <img src="https://techcorp.com/logo.png" alt="Logo" style="width: 50px; height: 50px; object-fit: contain;">
        </td>
        <td style="vertical-align: middle;">
          <div style="font-weight: 600; font-size: 16px; color: #333; margin-bottom: 4px;">María González</div>
          <div style="font-size: 14px; color: #007bff; margin-bottom: 8px;">TechCorp Solutions - <span style="font-style: italic; color: #666;">"Empresa líder en desarrollo de software"</span></div>
          <div style="font-size: 13px; margin: 2px 0;">📧 <a href="mailto:info@techcorp.com" style="color: #007bff; text-decoration: none;">info@techcorp.com</a></div>
          <div style="font-size: 13px; margin: 2px 0;">🌐 <a href="https://techcorp.com" style="color: #007bff; text-decoration: none;">https://techcorp.com</a></div>
          <div style="font-size: 13px; margin: 2px 0;">📞 <a href="tel:+34987654321" style="color: #333; text-decoration: none;">+34 987 654 321</a></div>
        </td>
      </tr>
    </table>`,

  // Ejemplo de firma básica sin logo
  basic: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.4; max-width: 300px;">
      <div style="font-weight: 600; font-size: 16px; color: #333;">Equipo de Atención al Cliente</div>
    </div>`,

  // Ejemplo de firma con datos parciales
  partial: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.4; max-width: 300px;">
      <div style="font-weight: 600; font-size: 16px; color: #333; margin-bottom: 4px;">Ana García</div>
      <div style="font-size: 14px; color: #007bff; margin-bottom: 8px;">MiEmpresa</div>
      <div style="font-size: 13px; margin: 2px 0;">📧 <a href="mailto:contacto@miempresa.com" style="color: #007bff; text-decoration: none;">contacto@miempresa.com</a></div>
      <div style="font-size: 13px; margin: 2px 0;">🌐 <a href="https://miempresa.com" style="color: #007bff; text-decoration: none;">https://miempresa.com</a></div>
    </div>`
};

// Exportar para uso en otros archivos
export {
  runAllExamples,
  generateBasicSignature,
  generateGenericSignature,
  handleEmailContext,
  handleErrors
};

// Ejecutar ejemplos si se ejecuta directamente
if (require.main === module) {
  runAllExamples();
} 