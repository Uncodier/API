#!/usr/bin/env node

/**
 * Script para verificar el estado de aprobación de un Content Template en Twilio
 * Uso: node scripts/test-template-approval.js <template_sid>
 */

const fetch = require('node-fetch');

async function checkTemplateApproval(templateSid, accountSid, authToken) {
  try {
    console.log(`🔍 Verificando estado de template: ${templateSid}`);
    
    const apiUrl = `https://content.twilio.com/v1/Content/${templateSid}/ApprovalRequests`;
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ Error verificando aprobación:', errorData);
      return;
    }
    
    const approvalData = await response.json();
    
    console.log('📊 Estado de aprobación completo:', JSON.stringify(approvalData, null, 2));
    
    if (approvalData.whatsapp) {
      console.log('\n📱 Estado específico de WhatsApp:');
      console.log('   Status:', approvalData.whatsapp.status);
      console.log('   Approved:', approvalData.whatsapp.status === 'approved');
      
      if (approvalData.whatsapp.status === 'approved') {
        console.log('✅ Template APROBADO para WhatsApp');
      } else {
        console.log('⏳ Template AÚN NO APROBADO para WhatsApp');
        console.log('   Estado actual:', approvalData.whatsapp.status);
      }
    } else {
      console.log('❌ No se encontró información de aprobación de WhatsApp');
    }
    
  } catch (error) {
    console.error('💥 Error:', error.message);
  }
}

// Obtener parámetros de línea de comandos
const templateSid = process.argv[2];

if (!templateSid) {
  console.error('❌ Uso: node scripts/test-template-approval.js <template_sid>');
  console.error('   Ejemplo: node scripts/test-template-approval.js HX4682d841bc32d6f41bb3479e402776c43');
  process.exit(1);
}

// Obtener credenciales desde variables de entorno o usar defaults de ejemplo
const accountSid = process.env.TWILIO_ACCOUNT_SID || 'AC33ea5f1f199268060327c120507dd223';
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!authToken) {
  console.error('❌ Falta TWILIO_AUTH_TOKEN en variables de entorno');
  process.exit(1);
}

console.log('🚀 Iniciando verificación de template...');
console.log('   Template SID:', templateSid);
console.log('   Account SID:', accountSid);
console.log('   Auth Token:', authToken ? '***[REDACTED]***' : 'NOT SET');

checkTemplateApproval(templateSid, accountSid, authToken); 