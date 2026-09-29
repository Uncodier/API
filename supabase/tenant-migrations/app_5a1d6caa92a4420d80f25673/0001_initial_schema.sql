-- Initial, never-applied NEX schema. Backend-only intake is not anonymous DB access.
-- Equivalent read-only JWT helpers avoid requiring managed auth-schema privileges.
-- PostgREST validates/signs the request context; no RPC here can set these claims.
CREATE FUNCTION app_5a1d6caa92a4420d80f25673.current_user_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
  )::uuid
$$;

CREATE FUNCTION app_5a1d6caa92a4420d80f25673.request_claims()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

CREATE FUNCTION app_5a1d6caa92a4420d80f25673.is_backend_request()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT COALESCE(
    app_5a1d6caa92a4420d80f25673.current_user_id() = '541396e1-a904-4a81-8cbf-0ca4e3b8b2b4'::uuid
    AND app_5a1d6caa92a4420d80f25673.request_claims()->>'tenant_id' = '49f4d8b1-52cb-4abb-8387-da487c64deaf'
    AND app_5a1d6caa92a4420d80f25673.request_claims()->>'schema' = 'app_5a1d6caa92a4420d80f25673', false
  )
$$;

CREATE TABLE app_5a1d6caa92a4420d80f25673.users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  full_name text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'driver', 'staff', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON app_5a1d6caa92a4420d80f25673.users (lower(email));
ALTER TABLE app_5a1d6caa92a4420d80f25673.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_self ON app_5a1d6caa92a4420d80f25673.users
  FOR SELECT TO authenticated
  USING (id = app_5a1d6caa92a4420d80f25673.current_user_id() OR app_5a1d6caa92a4420d80f25673.is_backend_request());
CREATE POLICY users_backend_driver_intake ON app_5a1d6caa92a4420d80f25673.users
  FOR INSERT TO authenticated
  WITH CHECK (app_5a1d6caa92a4420d80f25673.is_backend_request() AND role = 'driver');
-- No self-write policy for role/email/membership; role assignment is administrative.

CREATE TABLE app_5a1d6caa92a4420d80f25673.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_5a1d6caa92a4420d80f25673.users(id),
  plate text NOT NULL,
  type text NOT NULL,
  capacity numeric NOT NULL CHECK (capacity > 0 AND capacity <= 1000000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_plate_unique ON app_5a1d6caa92a4420d80f25673.vehicles (upper(plate));
ALTER TABLE app_5a1d6caa92a4420d80f25673.vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY vehicles_read_own ON app_5a1d6caa92a4420d80f25673.vehicles
  FOR SELECT TO authenticated
  USING (user_id = app_5a1d6caa92a4420d80f25673.current_user_id() OR app_5a1d6caa92a4420d80f25673.is_backend_request());
CREATE POLICY vehicles_backend_intake ON app_5a1d6caa92a4420d80f25673.vehicles
  FOR INSERT TO authenticated
  WITH CHECK (app_5a1d6caa92a4420d80f25673.is_backend_request());

CREATE TABLE app_5a1d6caa92a4420d80f25673.loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  type text,
  weight numeric,
  dimensions text,
  origin text,
  destination text,
  pickup_date date,
  delivery_date date,
  status text NOT NULL DEFAULT 'pending',
  client_email text,
  client_phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_5a1d6caa92a4420d80f25673.loads ENABLE ROW LEVEL SECURITY;
CREATE POLICY loads_authorized_read ON app_5a1d6caa92a4420d80f25673.loads
  FOR SELECT TO authenticated
  USING (user_id = app_5a1d6caa92a4420d80f25673.current_user_id() OR EXISTS (
    SELECT 1 FROM app_5a1d6caa92a4420d80f25673.users u
    WHERE u.id = app_5a1d6caa92a4420d80f25673.current_user_id() AND u.role IN ('staff', 'admin')
  ));
CREATE POLICY loads_backend_intake ON app_5a1d6caa92a4420d80f25673.loads
  FOR INSERT TO authenticated
  WITH CHECK (app_5a1d6caa92a4420d80f25673.is_backend_request());
CREATE POLICY loads_staff_update ON app_5a1d6caa92a4420d80f25673.loads
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM app_5a1d6caa92a4420d80f25673.users u WHERE u.id = app_5a1d6caa92a4420d80f25673.current_user_id() AND u.role IN ('staff', 'admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM app_5a1d6caa92a4420d80f25673.users u WHERE u.id = app_5a1d6caa92a4420d80f25673.current_user_id() AND u.role IN ('staff', 'admin')));

CREATE TABLE app_5a1d6caa92a4420d80f25673.bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES app_5a1d6caa92a4420d80f25673.loads(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES app_5a1d6caa92a4420d80f25673.users(id),
  vehicle_id uuid REFERENCES app_5a1d6caa92a4420d80f25673.vehicles(id) ON DELETE SET NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_5a1d6caa92a4420d80f25673.bids ENABLE ROW LEVEL SECURITY;
CREATE POLICY bids_read_own ON app_5a1d6caa92a4420d80f25673.bids
  FOR SELECT TO authenticated USING (driver_id = app_5a1d6caa92a4420d80f25673.current_user_id());
CREATE POLICY bids_create_own ON app_5a1d6caa92a4420d80f25673.bids
  FOR INSERT TO authenticated
  WITH CHECK (driver_id = app_5a1d6caa92a4420d80f25673.current_user_id() AND EXISTS (
    SELECT 1 FROM app_5a1d6caa92a4420d80f25673.vehicles v
    WHERE v.id = vehicle_id AND v.user_id = app_5a1d6caa92a4420d80f25673.current_user_id()
  ));

CREATE FUNCTION app_5a1d6caa92a4420d80f25673.register_driver(
  p_name text, p_email text, p_vehicle_type text, p_plate text, p_capacity numeric
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  new_user_id uuid := gen_random_uuid();
  new_vehicle_id uuid := gen_random_uuid();
  existing_registration jsonb;
BEGIN
  IF NOT app_5a1d6caa92a4420d80f25673.is_backend_request() THEN
    RAISE EXCEPTION 'Backend registration authorization required' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 120
    OR p_email IS NULL OR length(p_email) > 254 OR p_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR p_vehicle_type IS NULL OR length(btrim(p_vehicle_type)) NOT BETWEEN 1 AND 80
    OR p_plate IS NULL OR btrim(p_plate) !~ '^[A-Za-z0-9 -]{2,20}$'
    OR p_capacity IS NULL OR NOT (p_capacity > 0 AND p_capacity <= 1000000)
  THEN
    RAISE EXCEPTION 'Invalid driver registration payload' USING ERRCODE = '22023';
  END IF;
  -- Serialize rate-limit accounting and duplicate checks within this tenant only.
  PERFORM pg_advisory_xact_lock(hashtextextended('app_5a1d6caa92a4420d80f25673:driver-intake', 0));
  SELECT jsonb_build_object('user_id', u.id, 'vehicle_id', v.id)
  INTO existing_registration
  FROM app_5a1d6caa92a4420d80f25673.users u
  JOIN app_5a1d6caa92a4420d80f25673.vehicles v ON v.user_id = u.id
  WHERE lower(u.email) = lower(btrim(p_email)) AND u.role = 'driver'
    AND u.full_name = btrim(p_name) AND v.type = btrim(p_vehicle_type)
    AND upper(v.plate) = upper(btrim(p_plate)) AND v.capacity = p_capacity;
  IF existing_registration IS NOT NULL THEN
    RETURN existing_registration;
  END IF;
  IF (SELECT count(*) FROM app_5a1d6caa92a4420d80f25673.users
      WHERE role = 'driver' AND created_at > now() - interval '1 minute') >= 50 THEN
    RAISE EXCEPTION 'Driver registration rate limit exceeded' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app_5a1d6caa92a4420d80f25673.users (id, email, full_name, role)
  VALUES (new_user_id, lower(btrim(p_email)), btrim(p_name), 'driver');
  INSERT INTO app_5a1d6caa92a4420d80f25673.vehicles (id, user_id, type, plate, capacity)
  VALUES (new_vehicle_id, new_user_id, btrim(p_vehicle_type), upper(btrim(p_plate)), p_capacity);
  RETURN jsonb_build_object('user_id', new_user_id, 'vehicle_id', new_vehicle_id);
END;
$$;