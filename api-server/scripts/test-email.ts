#!/usr/bin/env ts-node

/**
 * Script para probar el envío de correos electrónicos
 * 
 * Este script utiliza el servicio de notificaciones para enviar un correo
 * electrónico de prueba y verificar que la configuración SMTP es correcta.
 * 
 * Uso:
 * ```
 * npx ts-node scripts/test-email.ts
 * ```
 */

import dotenv from 'dotenv';
import path from 'path';
import { NotificationService } from '../src/lib/services/notification-service';

// Cargar variables de entorno
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Función principal
async function main() {
  console.log('🚀 Iniciando prueba de envío de correo electrónico...');
  
  // Verificar si tenemos las variables de entorno necesarias
  const emailUser = process.env.EMAIL_USER;
  const emailHost = process.env.EMAIL_HOST;
  
  if (!emailUser || !emailHost) {
    console.error('❌ Error: Faltan variables de entorno necesarias para el envío de correos.');
    console.error('Por favor, configura EMAIL_HOST, EMAIL_PORT, EMAIL_USER y EMAIL_PASSWORD en tu archivo .env');
    process.exit(1);
  }
  
  // Generar un HTML de ejemplo
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      <h2 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">Correo de prueba</h2>
      
      <p style="margin: 20px 0; font-size: 16px;">
        Este es un correo de prueba enviado desde el servicio de notificaciones de Uncodie.
      </p>
      
      <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #6366f1; margin: 20px 0;">
        <p style="margin: 0; font-style: italic;">Si estás recibiendo este correo, significa que la configuración SMTP es correcta.</p>
      </div>
      
      <div style="margin: 30px 0; text-align: center;">
        <a href="https://uncodie.com" style="display: inline-block; background-color: #6366f1; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Visitar sitio web
        </a>
      </div>
      
      <p style="color: #777; font-size: 14px; margin-top: 40px;">
        Este correo fue generado automáticamente. Por favor, no responda a este mensaje.
      </p>
    </div>
  `;
  
  // Información del entorno
  console.log('📧 Enviando correo de prueba a:', emailUser);
  console.log('🖥️  Servidor SMTP:', emailHost);
  
  try {
    // Enviar el correo de prueba
    const result = await NotificationService.sendEmail({
      to: emailUser,
      subject: '🧪 Correo de prueba - Uncodie Notifications',
      html: htmlContent,
      text: 'Este es un correo de prueba del servicio de notificaciones de Uncodie. Si estás recibiendo este mensaje, la configuración SMTP es correcta.'
    });
    
    if (result) {
      console.log('✅ Correo enviado exitosamente!');
      console.log('Por favor, verifica tu bandeja de entrada para confirmar que has recibido el correo.');
    } else {
      console.error('❌ Error al enviar el correo. Revisa los logs para más detalles.');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error al enviar el correo:', error);
    process.exit(1);
  }
}

// Ejecutar la función principal
main().catch((error) => {
  console.error('Error inesperado:', error);
  process.exit(1);
}); 