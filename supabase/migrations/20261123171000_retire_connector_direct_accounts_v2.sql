BEGIN;
SET LOCAL lock_timeout = '5s';

-- Apply only after the Ask API/workers use connector_ask_connections.
-- Historical receipt helpers and Support remain intact.
DROP FUNCTION public.connector_direct_accounts_v2(uuid,uuid,uuid,uuid,uuid,text);
COMMIT;