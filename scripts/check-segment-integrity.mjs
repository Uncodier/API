#!/usr/bin/env node

/**
 * Script para verificar la integridad de segment_id en la tabla leads
 * Identifica leads que referencian segmentos que no existen
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Cargar variables de entorno
config();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Error: Faltan variables de entorno NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkSegmentIntegrity() {
  console.log('🔍 Verificando integridad de segment_id en leads...\n');

  try {
    // 1. Obtener todos los leads con segment_id no nulo
    console.log('📋 Obteniendo leads con segment_id asignado...');
    const { data: leadsWithSegments, error: leadsError } = await supabase
      .from('leads')
      .select('id, segment_id, created_at, updated_at')
      .not('segment_id', 'is', null);

    if (leadsError) {
      console.error('❌ Error obteniendo leads:', leadsError);
      return;
    }

    console.log(`✅ Encontrados ${leadsWithSegments.length} leads con segment_id asignado\n`);

    if (leadsWithSegments.length === 0) {
      console.log('✅ No hay leads con segment_id para verificar');
      return;
    }

    // 2. Obtener todos los segment_ids únicos
    const uniqueSegmentIds = [...new Set(leadsWithSegments.map(lead => lead.segment_id))];
    console.log(`🔑 Encontrados ${uniqueSegmentIds.length} segment_ids únicos`);

    // 3. Verificar cuáles de estos segment_ids existen en la tabla segments
    console.log('📊 Verificando existencia en tabla segments...');
    const { data: existingSegments, error: segmentsError } = await supabase
      .from('segments')
      .select('id, name, is_active')
      .in('id', uniqueSegmentIds);

    if (segmentsError) {
      console.error('❌ Error obteniendo segmentos:', segmentsError);
      return;
    }

    const existingSegmentIds = new Set(existingSegments.map(segment => segment.id));
    const inactiveSegmentIds = new Set(
      existingSegments.filter(segment => !segment.is_active).map(segment => segment.id)
    );

    console.log(`✅ ${existingSegments.length} segmentos encontrados en la base de datos`);
    console.log(`⚠️  ${inactiveSegmentIds.size} segmentos están inactivos\n`);

    // 4. Identificar segment_ids problemáticos
    const orphanedLeads = [];
    const inactiveSegmentLeads = [];

    for (const lead of leadsWithSegments) {
      if (!existingSegmentIds.has(lead.segment_id)) {
        orphanedLeads.push(lead);
      } else if (inactiveSegmentIds.has(lead.segment_id)) {
        inactiveSegmentLeads.push(lead);
      }
    }

    // 5. Mostrar resultados
    console.log('📊 RESULTADOS DE INTEGRIDAD:\n');

    if (orphanedLeads.length > 0) {
      console.log(`❌ ${orphanedLeads.length} leads con segment_id que NO EXISTE:`);
      orphanedLeads.forEach(lead => {
        console.log(`   - Lead: ${lead.id} → Segment: ${lead.segment_id} (actualizado: ${lead.updated_at})`);
      });
      console.log();
    }

    if (inactiveSegmentLeads.length > 0) {
      console.log(`⚠️  ${inactiveSegmentLeads.length} leads asignados a segmentos INACTIVOS:`);
      inactiveSegmentLeads.forEach(lead => {
        const segment = existingSegments.find(s => s.id === lead.segment_id);
        console.log(`   - Lead: ${lead.id} → Segment: ${segment.name} (${segment.id}) [INACTIVO]`);
      });
      console.log();
    }

    if (orphanedLeads.length === 0 && inactiveSegmentLeads.length === 0) {
      console.log('✅ Todos los segment_ids están correctos');
    }

    // 6. Sugerir acciones de remediación
    if (orphanedLeads.length > 0 || inactiveSegmentLeads.length > 0) {
      console.log('🛠️  ACCIONES RECOMENDADAS:\n');
      
      if (orphanedLeads.length > 0) {
        console.log('Para leads con segment_id huérfanos:');
        console.log('   1. Investigar por qué fueron eliminados esos segmentos');
        console.log('   2. Considerar crear nuevos segmentos o usar NULL');
        console.log('   3. SQL para limpiar: UPDATE leads SET segment_id = NULL WHERE segment_id NOT IN (SELECT id FROM segments);');
        console.log();
      }

      if (inactiveSegmentLeads.length > 0) {
        console.log('Para leads en segmentos inactivos:');
        console.log('   1. Reactivar segmentos si son necesarios');
        console.log('   2. Reasignar leads a segmentos activos');
        console.log('   3. SQL para limpiar: UPDATE leads SET segment_id = NULL WHERE segment_id IN (SELECT id FROM segments WHERE is_active = false);');
        console.log();
      }
    }

    // 7. Estadísticas finales
    const validLeads = leadsWithSegments.length - orphanedLeads.length - inactiveSegmentLeads.length;
    console.log('📈 ESTADÍSTICAS FINALES:');
    console.log(`   • Total leads con segment_id: ${leadsWithSegments.length}`);
    console.log(`   • Leads válidos: ${validLeads} (${((validLeads / leadsWithSegments.length) * 100).toFixed(1)}%)`);
    console.log(`   • Leads con problemas: ${orphanedLeads.length + inactiveSegmentLeads.length} (${(((orphanedLeads.length + inactiveSegmentLeads.length) / leadsWithSegments.length) * 100).toFixed(1)}%)`);

  } catch (error) {
    console.error('❌ Error durante la verificación:', error);
  }
}

// Ejecutar la verificación
checkSegmentIntegrity()
  .then(() => {
    console.log('\n✅ Verificación completada');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error fatal:', error);
    process.exit(1);
  });
