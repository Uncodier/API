BEGIN;
SET LOCAL lock_timeout = '5s';

-- Provider references and OAuth correlation never contain credential material.
CREATE TABLE public.site_connector_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'composio' CHECK (provider = 'composio'),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 200),
  provider_user_id text NOT NULL CHECK (length(provider_user_id) BETWEEN 1 AND 200),
  credential_revision text NOT NULL CHECK (length(credential_revision) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, provider),
  UNIQUE (id, site_id),
  UNIQUE (id, site_id, project_id)
);

CREATE TABLE public.connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  -- Derived by trigger; a verified project, not a credential row, owns accounts.
  provider_project_id text NOT NULL,
  toolkit_slug text NOT NULL CHECK (toolkit_slug ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  provider_account_id text NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 200),
  auth_config_id text NOT NULL CHECK (length(auth_config_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  provider_status text NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 40),
  enabled boolean NOT NULL DEFAULT false,
  revocation_pending boolean NOT NULL DEFAULT false,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES auth.users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_id, site_id, provider_project_id)
    REFERENCES public.site_connector_providers(id, site_id, project_id),
  UNIQUE (provider_project_id, provider_account_id),
  UNIQUE (id, site_id),
  UNIQUE (id, site_id, provider_id, toolkit_slug, auth_config_id, provider_account_id),
  CHECK (NOT enabled OR (provider_status = 'ACTIVE' AND NOT revocation_pending AND verified_at IS NOT NULL))
);
CREATE INDEX connectors_site_toolkit_idx ON public.connectors(site_id, toolkit_slug);

CREATE TABLE public.connector_members (
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  can_view boolean NOT NULL DEFAULT false,
  can_use boolean NOT NULL DEFAULT false,
  expires_at timestamptz CHECK (expires_at IS NULL OR isfinite(expires_at)),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  granted_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, user_id),
  FOREIGN KEY (connector_id, site_id) REFERENCES public.connectors(id, site_id) ON DELETE CASCADE,
  CHECK (NOT can_use OR can_view)
);
CREATE INDEX connector_members_actor_idx ON public.connector_members(site_id, user_id, connector_id);

-- Existing agents have a global UUID PK; this composite key protects tenant edges.
CREATE UNIQUE INDEX connector_agents_site_identity_idx ON public.agents(id, site_id);
CREATE TABLE public.connector_agents (
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  expires_at timestamptz CHECK (expires_at IS NULL OR isfinite(expires_at)),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  granted_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, agent_id),
  FOREIGN KEY (connector_id, site_id) REFERENCES public.connectors(id, site_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, site_id) REFERENCES public.agents(id, site_id) ON DELETE CASCADE
);

CREATE FUNCTION public.connector_valid_text_array(p_values text[], p_limit integer, p_pattern text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT p_values IS NOT NULL AND coalesce(array_ndims(p_values), 1) = 1
    AND cardinality(p_values) <= p_limit
    AND NOT EXISTS (SELECT 1 FROM unnest(p_values) v WHERE v IS NULL OR v !~ p_pattern)
    AND cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) v);
$$;
REVOKE ALL ON FUNCTION public.connector_valid_text_array(text[], integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.connector_valid_text_array(text[], integer, text) TO authenticated, service_role;
ALTER TABLE public.connectors ADD CONSTRAINT connectors_scopes_bounded
  CHECK (public.connector_valid_text_array(granted_scopes, 200, '^[^[:cntrl:]][^[:cntrl:]]{0,255}$'));

CREATE TABLE public.connector_policies (
  site_id uuid NOT NULL,
  connector_id uuid PRIMARY KEY,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  allowed_hosts text[] NOT NULL DEFAULT '{}',
  require_approval boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connector_id, site_id) REFERENCES public.connectors(id, site_id) ON DELETE CASCADE,
  CHECK (public.connector_valid_text_array(allowed_tools, 200, '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$')),
  CHECK (public.connector_valid_text_array(allowed_hosts, 2, '^(assistant|direct)$'))
);

CREATE TABLE public.site_connector_auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  toolkit_slug text NOT NULL CHECK (toolkit_slug ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  auth_config_id text NOT NULL CHECK (length(auth_config_id) BETWEEN 1 AND 200),
  provider_account_id text CHECK (length(provider_account_id) BETWEEN 1 AND 200),
  nonce_hash text NOT NULL UNIQUE CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  credential_revision text NOT NULL CHECK (length(credential_revision) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completing','completed','failed','expired','outcome_unknown')),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  connector_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_id, site_id) REFERENCES public.site_connector_providers(id, site_id),
  FOREIGN KEY (connector_id, site_id, provider_id, toolkit_slug, auth_config_id, provider_account_id)
    REFERENCES public.connectors(id, site_id, provider_id, toolkit_slug, auth_config_id, provider_account_id),
  CHECK (connector_id IS NULL OR provider_account_id IS NOT NULL),
  CHECK ((status = 'completed') = (connector_id IS NOT NULL))
);
CREATE INDEX connector_auth_attempts_site_idx ON public.site_connector_auth_attempts(site_id, created_at DESC);

-- Administrative events only: no names, addresses, URLs, provider payload or tool arguments.
CREATE TABLE public.connector_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  event_type text NOT NULL CHECK (event_type IN ('access_updated','policy_updated','auth_completed')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connector_id, site_id) REFERENCES public.connectors(id, site_id) ON DELETE CASCADE,
  UNIQUE (connector_id, revision)
);

ALTER TABLE public.site_connector_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_connector_auth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_connector_providers, public.connectors, public.connector_members,
  public.connector_agents, public.connector_policies, public.site_connector_auth_attempts,
  public.connector_audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.site_connector_providers, public.connectors,
  public.site_connector_auth_attempts TO service_role;
GRANT SELECT ON public.connector_members, public.connector_agents, public.connector_policies,
  public.connector_audit_events TO service_role;

COMMIT;