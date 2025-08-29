/**
 * Debug script to understand false positive duplication detection
 * This script helps identify why new emails are being detected as duplicates
 */

import { EmailDuplicationService } from '../src/lib/services/email/EmailDuplicationService.js';
import { supabaseAdmin } from '../src/lib/database/supabase-client.js';

async function debugFalsePositive() {
  console.log('🔍 Debugging false positive duplication detection...\n');

  try {
    // 1. Verificar mensajes existentes en una conversación específica
    console.log('📊 1. Verificando mensajes existentes...');
    
    // Reemplaza con IDs reales de tu caso
    const conversationId = 'tu-conversation-id-aqui';
    const leadId = 'tu-lead-id-aqui';
    const siteId = 'tu-site-id-aqui';
    
    if (conversationId === 'tu-conversation-id-aqui') {
      console.log('⚠️ Por favor, reemplaza los IDs de prueba con IDs reales de tu caso');
      return;
    }

    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select('id, custom_data, created_at, role, content')
      .eq('conversation_id', conversationId)
      .eq('lead_id', leadId)
      .not('custom_data', 'is', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Error obteniendo mensajes:', error);
      return;
    }

    console.log(`✅ Encontrados ${messages.length} mensajes en la conversación`);

    // 2. Filtrar mensajes de email enviados
    const emailMessages = messages.filter(msg => {
      try {
        const customData = msg.custom_data;
        if (!customData || typeof customData !== 'object') return false;
        
        const isEmailChannel = customData.delivery?.channel === 'email' || customData.channel === 'email';
        const isSentStatus = customData.status === 'sent' || customData.delivery?.success === true;
        
        return isEmailChannel && isSentStatus;
      } catch (error) {
        return false;
      }
    });

    console.log(`📧 ${emailMessages.length} mensajes de email enviados encontrados`);

    // 3. Mostrar detalles de cada mensaje de email
    console.log('\n📋 Detalles de mensajes de email:');
    emailMessages.forEach((msg, index) => {
      const customData = msg.custom_data || {};
      const deliveryDetails = customData.delivery?.details || {};
      
      console.log(`\n${index + 1}. Mensaje ID: ${msg.id}`);
      console.log(`   - Subject: "${deliveryDetails.subject || customData.subject || 'N/A'}"`);
      console.log(`   - Recipient: "${deliveryDetails.recipient || 'N/A'}"`);
      console.log(`   - Email ID: "${customData.email_id || deliveryDetails.api_messageId || 'N/A'}"`);
      console.log(`   - Timestamp: ${deliveryDetails.timestamp || msg.created_at}`);
      console.log(`   - Created: ${msg.created_at}`);
    });

    // 4. Simular el email que está siendo detectado como duplicado
    console.log('\n🧪 4. Simulando email que está siendo detectado como duplicado...');
    
    // Reemplaza con los datos del email que está causando problemas
    const testEmail = {
      subject: 'Subject del email problemático',
      to: 'recipient@example.com',
      from: 'sender@example.com',
      date: new Date().toISOString(),
      messageId: 'message-id-del-email-problematico'
    };

    console.log('📧 Email de prueba:', testEmail);

    // 5. Ejecutar la detección de duplicados
    const result = await EmailDuplicationService.checkEmailDuplication(
      testEmail,
      conversationId,
      leadId,
      siteId
    );

    console.log('\n🎯 Resultado de la detección:');
    console.log('   - Es duplicado:', result.isDuplicate);
    console.log('   - Razón:', result.reason);
    console.log('   - Confianza:', result.confidence);
    console.log('   - ID del mensaje existente:', result.existingMessageId);

    // 6. Análisis detallado si es un falso positivo
    if (result.isDuplicate) {
      console.log('\n🔍 6. Análisis detallado del falso positivo:');
      
      const analysisData = EmailDuplicationService['extractEmailAnalysisData'](testEmail);
      console.log('   - Datos extraídos del email:', analysisData);
      
      // Verificar cada criterio individualmente
      console.log('\n   Verificando criterios individuales:');
      
      // Criterio 1: ID exacto
      const exactIdMatch = EmailDuplicationService['checkExactIdMatch'](analysisData, emailMessages);
      console.log('   - Coincidencia por ID exacto:', exactIdMatch.isDuplicate);
      
      // Criterio 2: Subject + recipient + timestamp
      const exactMatch = EmailDuplicationService['checkExactMatchConservative'](analysisData, emailMessages);
      console.log('   - Coincidencia exacta (conservador):', exactMatch.isDuplicate);
      
      // Criterio 3: Recipient + temporal
      const recipientMatch = EmailDuplicationService['checkRecipientTemporalMatchConservative'](analysisData, emailMessages);
      console.log('   - Coincidencia por recipient + tiempo (conservador):', recipientMatch.isDuplicate);
    }

    console.log('\n💡 Recomendaciones:');
    console.log('1. Revisa los logs detallados arriba');
    console.log('2. Verifica si el email realmente es nuevo o ya existe');
    console.log('3. Ajusta los parámetros de tiempo si es necesario');
    console.log('4. Considera agregar más contexto para la detección');

  } catch (error) {
    console.error('❌ Error en debug:', error);
  }
}

// Ejecutar debug
debugFalsePositive().catch(console.error);
