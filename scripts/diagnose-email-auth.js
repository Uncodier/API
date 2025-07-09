#!/usr/bin/env node

/**
 * Script para diagnosticar problemas de autenticación de email
 * 
 * Uso: node scripts/diagnose-email-auth.js <site_id>
 */

const { createClient } = require('@supabase/supabase-js');

// Configuración de Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Faltan variables de entorno de Supabase');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function diagnoseEmailAuth(siteId) {
  try {
    console.log('🔍 Diagnosticando autenticación de email...\n');
    
    // 1. Verificar settings del sitio
    console.log('📋 Verificando settings del sitio...');
    const { data: settings, error: settingsError } = await supabase
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    if (settingsError) {
      console.error('❌ Error obteniendo settings:', settingsError.message);
      return;
    }
    
    if (!settings?.channels?.email) {
      console.error('❌ No se encontró configuración de email en settings');
      return;
    }
    
    console.log('✅ Configuración de email encontrada:');
    console.log('   - Email:', settings.channels.email.email);
    console.log('   - Servidor entrante:', settings.channels.email.incomingServer);
    console.log('   - Puerto entrante:', settings.channels.email.incomingPort);
    console.log('   - Aliases:', settings.channels.email.aliases);
    
    // 2. Verificar token almacenado
    console.log('\n🔐 Verificando token almacenado...');
    const { data: tokens, error: tokenError } = await supabase
      .from('secure_tokens')
      .select('*')
      .eq('site_id', siteId)
      .eq('token_type', 'email');
    
    if (tokenError) {
      console.error('❌ Error obteniendo tokens:', tokenError.message);
      return;
    }
    
    if (!tokens || tokens.length === 0) {
      console.error('❌ No se encontró token de email almacenado');
      console.log('📝 Para almacenar un token:');
      console.log('curl -X POST your-domain/api/secure-tokens/encrypt \\');
      console.log('  -H "Content-Type: application/json" \\');
      console.log('  -d \'{"value":"{\\"email\\":\\"tu-email@gmail.com\\",\\"password\\":\\"tu-contraseña\\"}","site_id":"' + siteId + '","token_type":"email","store_in_db":true}\'');
      return;
    }
    
    console.log('✅ Token encontrado:');
    console.log('   - ID:', tokens[0].id);
    console.log('   - Identificador:', tokens[0].identifier || 'No especificado');
    console.log('   - Fecha creación:', tokens[0].created_at);
    console.log('   - Último uso:', tokens[0].last_used);
    
    // 3. Intentar desencriptar el token
    console.log('\n🔓 Intentando desencriptar token...');
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_ORIGIN || 'http://localhost:3000'}/api/secure-tokens/decrypt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: siteId,
          token_type: 'email'
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        console.log('✅ Token desencriptado exitosamente');
        const tokenValue = result.data.tokenValue;
        
        if (typeof tokenValue === 'object') {
          console.log('📧 Configuración de email:');
          console.log('   - Email:', tokenValue.email);
          console.log('   - Contraseña:', tokenValue.password ? '***' + tokenValue.password.slice(-4) : 'No especificada');
          console.log('   - Host:', tokenValue.host || 'No especificado');
          console.log('   - Puerto:', tokenValue.imapPort || 'No especificado');
          
          // Verificar si es contraseña de aplicación para Gmail
          if (tokenValue.email && tokenValue.email.includes('@gmail.com')) {
            if (tokenValue.password && tokenValue.password.length === 16 && /^[a-z]+$/.test(tokenValue.password)) {
              console.log('✅ Parece ser una contraseña de aplicación válida para Gmail');
            } else {
              console.log('⚠️  Si usas Gmail con 2FA, necesitas una contraseña de aplicación');
              console.log('   Genera una en: https://myaccount.google.com/security');
            }
          }
        } else {
          console.log('📝 Token como string:', typeof tokenValue === 'string' ? tokenValue.slice(0, 10) + '...' : tokenValue);
        }
      } else {
        console.error('❌ Error desencriptando token:', result.error);
      }
    } catch (fetchError) {
      console.error('❌ Error en petición de desencriptación:', fetchError.message);
    }
    
    // 4. Sugerencias de solución
    console.log('\n💡 Sugerencias para resolver el problema:');
    console.log('1. Verifica que el email y contraseña sean correctos');
    console.log('2. Para Gmail con 2FA: usa contraseña de aplicación');
    console.log('3. Para Outlook: habilita IMAP y usa contraseña de aplicación');
    console.log('4. Verifica que el servidor IMAP y puerto sean correctos');
    console.log('5. Algunos proveedores requieren configuraciones específicas de seguridad');
    
  } catch (error) {
    console.error('❌ Error durante diagnóstico:', error);
  }
}

// Ejecutar diagnóstico
const siteId = process.argv[2];
if (!siteId) {
  console.error('❌ Uso: node scripts/diagnose-email-auth.js <site_id>');
  process.exit(1);
}

diagnoseEmailAuth(siteId); 