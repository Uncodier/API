-- Forward hardening: do not change the already-applied initial migration.
ALTER FUNCTION app_5a1d6caa92a4420d80f25673.current_user_id()
  SET search_path = pg_catalog, app_5a1d6caa92a4420d80f25673;
ALTER FUNCTION app_5a1d6caa92a4420d80f25673.request_claims()
  SET search_path = pg_catalog, app_5a1d6caa92a4420d80f25673;
ALTER FUNCTION app_5a1d6caa92a4420d80f25673.is_backend_request()
  SET search_path = pg_catalog, app_5a1d6caa92a4420d80f25673;
ALTER FUNCTION app_5a1d6caa92a4420d80f25673.register_driver(text, text, text, text, numeric)
  SET search_path = pg_catalog, app_5a1d6caa92a4420d80f25673;