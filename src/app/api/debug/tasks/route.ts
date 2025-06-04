import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: NextRequest) {
  try {
    console.log('[Debug] Iniciando debug de tasks');
    
    // Crear cliente admin directamente
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
    console.log('[Debug] URL:', supabaseUrl ? 'EXISTS' : 'MISSING');
    console.log('[Debug] Service Key:', serviceRoleKey ? 'EXISTS' : 'MISSING');
    
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    console.log('[Debug] Cliente admin creado');
    
    // Consulta simple: contar todas las tareas
    console.log('[Debug] Ejecutando consulta de conteo...');
    const { count: totalCount, error: countError } = await adminClient
      .from('tasks')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('[Debug] Error en conteo:', countError);
      return NextResponse.json({
        success: false,
        error: countError,
        step: 'count'
      });
    }
    
    console.log('[Debug] Total tasks:', totalCount);
    
    // Obtener algunas tareas de ejemplo
    console.log('[Debug] Obteniendo tareas de ejemplo...');
    const { data: sampleTasks, error: sampleError } = await adminClient
      .from('tasks')
      .select('id, title, lead_id, status, stage, type')
      .limit(3);
    
    if (sampleError) {
      console.error('[Debug] Error obteniendo samples:', sampleError);
      return NextResponse.json({
        success: false,
        error: sampleError,
        step: 'sample'
      });
    }
    
    console.log('[Debug] Sample tasks:', sampleTasks);
    
    // Probar filtro por lead_id específico
    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get('lead_id');
    
    let leadTasks = null;
    if (leadId) {
      console.log('[Debug] Probando filtro por lead_id:', leadId);
      const { data, error: leadError, count: leadCount } = await adminClient
        .from('tasks')
        .select('id, title, lead_id, status, stage', { count: 'exact' })
        .eq('lead_id', leadId);
      
      if (leadError) {
        console.error('[Debug] Error filtrando por lead:', leadError);
        return NextResponse.json({
          success: false,
          error: leadError,
          step: 'lead_filter'
        });
      }
      
      console.log('[Debug] Tasks para lead:', data);
      console.log('[Debug] Count para lead:', leadCount);
      leadTasks = { data, count: leadCount };
    }
    
    return NextResponse.json({
      success: true,
      totalCount,
      sampleTasks,
      leadId,
      leadTasks,
      debug: 'all_good'
    });
    
  } catch (error: any) {
    console.error('[Debug] Error general:', error);
    return NextResponse.json({
      success: false,
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
} 