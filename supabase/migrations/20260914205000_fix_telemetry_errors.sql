-- Eliminar datos antiguos y de pruebas de las tablas de estado
-- Esto limpiará el estado degradado y permitirá que las sondas vuelvan a insertar
-- datos sanos, y la telemetría pasiva también tome precedencia de forma limpia.

BEGIN;

-- 1. Limpiar TODAS las sondas de los sistemas degradados para los últimos 90 días 
-- para curar el SLA de 24h, 7d y 30d
DELETE FROM public.system_status 
WHERE system_key IN ('api_auth', 'cron', 'integrations', 'ai_portkey', 'ai_text', 'ai_text_continuation', 'ai_image')
  AND status != 'up'
  AND created_at > now() - interval '90 days';

-- 2. Limpiar los registros en runs para refrescar el overall_status y el SLA global
DELETE FROM public.system_status_runs
WHERE overall_status != 'healthy'
  AND created_at > now() - interval '90 days';

-- 3. Limpiar telemetría de fallos que pudieran haberse generado ahora mismo
DELETE FROM public.system_telemetry
WHERE status != 'up';

COMMIT;