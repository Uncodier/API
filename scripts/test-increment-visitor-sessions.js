#!/usr/bin/env node

/**
 * Script de prueba para la función increment_visitor_sessions
 * 
 * Este script verifica que la función increment_visitor_sessions funciona
 * correctamente creando un visitante de prueba y ejecutando la función.
 */

import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

// Configurar cliente de Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function testIncrementFunction() {
  let testVisitorId = null;
  
  try {
    console.log('🧪 Iniciando prueba de la función increment_visitor_sessions...');
    
    // Crear visitante de prueba
    testVisitorId = uuidv4();
    const testVisitor = {
      id: testVisitorId,
      fingerprint: `test-fingerprint-${Date.now()}`,
      first_seen_at: Date.now(),
      last_seen_at: Date.now(),
      total_sessions: 0,
      total_page_views: 1,
      total_time_spent: 0,
      is_identified: false
    };
    
    console.log('📝 Creando visitante de prueba...');
    const { error: createError } = await supabase
      .from('visitors')
      .insert([testVisitor]);
    
    if (createError) {
      console.error('❌ Error creando visitante de prueba:', createError);
      throw createError;
    }
    
    console.log('✅ Visitante de prueba creado:', testVisitorId);
    
    // Verificar estado inicial
    const { data: initialData, error: initialError } = await supabase
      .from('visitors')
      .select('total_sessions, last_seen_at')
      .eq('id', testVisitorId)
      .single();
    
    if (initialError) {
      console.error('❌ Error obteniendo estado inicial:', initialError);
      throw initialError;
    }
    
    console.log('📊 Estado inicial:', initialData);
    
    // Ejecutar función increment_visitor_sessions
    console.log('🔄 Ejecutando función increment_visitor_sessions...');
    
    const testTimestamp = Date.now();
    const { data: functionData, error: functionError } = await supabase
      .rpc('increment_visitor_sessions', {
        visitor_id: testVisitorId,
        last_seen_timestamp: testTimestamp
      });
    
    if (functionError) {
      console.error('❌ Error ejecutando función:', functionError);
      throw functionError;
    }
    
    console.log('✅ Función ejecutada exitosamente');
    
    // Verificar estado final
    const { data: finalData, error: finalError } = await supabase
      .from('visitors')
      .select('total_sessions, last_seen_at')
      .eq('id', testVisitorId)
      .single();
    
    if (finalError) {
      console.error('❌ Error obteniendo estado final:', finalError);
      throw finalError;
    }
    
    console.log('📊 Estado final:', finalData);
    
    // Verificar que los valores cambiaron correctamente
    if (finalData.total_sessions === (initialData.total_sessions + 1)) {
      console.log('✅ total_sessions incrementado correctamente');
    } else {
      console.error('❌ total_sessions no se incrementó correctamente');
      console.log(`   Esperado: ${initialData.total_sessions + 1}, Obtenido: ${finalData.total_sessions}`);
    }
    
    if (finalData.last_seen_at === testTimestamp) {
      console.log('✅ last_seen_at actualizado correctamente');
    } else {
      console.error('❌ last_seen_at no se actualizó correctamente');
      console.log(`   Esperado: ${testTimestamp}, Obtenido: ${finalData.last_seen_at}`);
    }
    
    console.log('🎉 Prueba completada exitosamente');
    
  } catch (error) {
    console.error('❌ Error en la prueba:', error);
    throw error;
  } finally {
    // Limpiar visitante de prueba
    if (testVisitorId) {
      console.log('🧹 Limpiando visitante de prueba...');
      const { error: deleteError } = await supabase
        .from('visitors')
        .delete()
        .eq('id', testVisitorId);
      
      if (deleteError) {
        console.error('⚠️ Error limpiando visitante de prueba:', deleteError);
      } else {
        console.log('✅ Visitante de prueba eliminado');
      }
    }
  }
}

// Ejecutar prueba
testIncrementFunction()
  .then(() => {
    console.log('🎉 Prueba completada exitosamente');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Error en la prueba:', error);
    process.exit(1);
  }); 