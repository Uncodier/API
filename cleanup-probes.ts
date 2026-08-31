import { supabaseAdmin } from './src/lib/database/supabase-client';

async function cleanup() {
  console.log('Cleaning up corrupted system_status records...');
  
  // Borrar de system_status_runs las corridas fallidas por el bug de los probes 
  // (por ejemplo las últimas 2 horas, o las que tengan overall_status down por el error de tokens)
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);
  
  const { data: runs, error: runsError } = await supabaseAdmin
    .from('system_status_runs')
    .delete()
    .gte('created_at', oneDayAgo.toISOString())
    .eq('overall_status', 'down')
    .select('id');

  if (runsError) {
    console.error('Error eliminando runs:', runsError);
    return;
  }
  
  console.log(`Eliminados ${runs?.length || 0} registros de system_status_runs.`);
  console.log('Los registros de system_status relacionados se borrarán automáticamente si hay ON DELETE CASCADE, o puedes truncar/borrar manualmente.');

  // Si no hay ON DELETE CASCADE, borramos también de system_status
  if (runs && runs.length > 0) {
    const runIds = runs.map(r => r.id);
    const { data: checks, error: checksError } = await supabaseAdmin
      .from('system_status')
      .delete()
      .in('run_id', runIds)
      .select('id');
      
    if (checksError) {
      console.error('Error eliminando checks:', checksError);
    } else {
      console.log(`Eliminados ${checks?.length || 0} registros huérfanos de system_status.`);
    }
  }

  console.log('Limpieza completada.');
}

cleanup().catch(console.error);