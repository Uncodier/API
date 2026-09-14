-- Eliminar datos antiguos y de pruebas de las tablas de estado
-- Esto limpiará el estado degradado y permitirá que las sondas vuelvan a insertar
-- datos sanos, y la telemetría pasiva también tome precedencia de forma limpia.

BEGIN;

-- 1. Limpiar las sondas antiguas de API que están en estado degradado/caído 
-- (Opcionalmente, puedes eliminar todo el historial si no necesitas el SLA histórico: DELETE FROM public.system_status)
DELETE FROM public.system_status 
WHERE system_key IN ('api_auth', 'cron', 'integrations', 'ai_portkey')
  AND status != 'up'
  AND created_at > now() - interval '3 days';

-- 2. Limpiar los registros en runs para refrescar el overall_status
-- Solo borramos los runs más recientes degradados para no afectar SLA a largo plazo
DELETE FROM public.system_status_runs
WHERE overall_status != 'healthy'
  AND created_at > now() - interval '1 days';

-- 3. Limpiar telemetría de fallos que pudieran haberse generado ahora mismo
DELETE FROM public.system_telemetry
WHERE status != 'up';

COMMIT;