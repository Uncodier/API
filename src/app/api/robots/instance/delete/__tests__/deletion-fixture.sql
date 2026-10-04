-- Isolated PostgreSQL fixture. No environment credentials or remote database.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE TABLE sites(id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE site_ownership(site_id uuid PRIMARY KEY REFERENCES sites, user_id uuid);
CREATE TABLE site_members(site_id uuid REFERENCES sites, user_id uuid, role text, status text);
CREATE TABLE test_capabilities(site_id uuid, allowed boolean);
CREATE FUNCTION public.current_user_site_role(p_site_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.sites WHERE id=p_site_id AND user_id=auth.uid())
    OR EXISTS (SELECT 1 FROM public.site_ownership WHERE site_id=p_site_id AND user_id=auth.uid()) THEN 'owner'
    ELSE (SELECT role FROM public.site_members WHERE site_id=p_site_id AND user_id=auth.uid() AND status='active' LIMIT 1) END
$$;
CREATE FUNCTION public.user_can(p_site_id uuid, p_command text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT allowed FROM public.test_capabilities WHERE site_id=p_site_id AND p_command='delete'
$$;
CREATE TABLE remote_instances(id uuid PRIMARY KEY, site_id uuid REFERENCES sites, status text,
  provider_instance_id text, configuration jsonb DEFAULT '{}', metadata jsonb DEFAULT '{}',
  is_archived boolean DEFAULT false, updated_at timestamptz DEFAULT now());
CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL REFERENCES sites,status text,
  metadata jsonb DEFAULT '{}',instructions text,backlog jsonb DEFAULT '{}',backlog_revision bigint DEFAULT 0,
  cron_lock_active boolean DEFAULT false,cron_lock_expires_at timestamptz,cron_lock_run_id text,
  updated_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid REFERENCES remote_instances ON DELETE CASCADE,
  site_id uuid,status text,metadata jsonb DEFAULT '{}',steps jsonb DEFAULT '[]',instructions text,retry_count integer,
  completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
  parent_plan_id uuid REFERENCES instance_plans ON DELETE CASCADE);
CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES remote_instances ON DELETE CASCADE,log_type text NOT NULL,
  level text,message text NOT NULL,details jsonb DEFAULT '{}',tool_args jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),
  parent_log_id uuid REFERENCES instance_logs ON DELETE SET NULL);
CREATE TABLE requirement_status(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid REFERENCES requirements ON DELETE CASCADE,site_id uuid,
  instance_id uuid REFERENCES remote_instances ON DELETE CASCADE,
  stage text,message text,active_sandbox_id text,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
CREATE TABLE requirement_user_action_receipts(requirement_id uuid REFERENCES requirements ON DELETE CASCADE,
  action_id uuid REFERENCES instance_logs ON DELETE CASCADE, action_created_at timestamptz,revision bigint,
  PRIMARY KEY(requirement_id,action_id));
CREATE TABLE requirement_cron_cycle_outcomes(requirement_id uuid REFERENCES requirements ON DELETE CASCADE,
  cycle_id text,runner_instance_id uuid,PRIMARY KEY(requirement_id,cycle_id));
CREATE TABLE campaigns(id uuid PRIMARY KEY,site_id uuid);
CREATE TABLE segments(id uuid PRIMARY KEY);
CREATE TABLE catalog_items(id uuid PRIMARY KEY);
CREATE TABLE campaign_requirements(campaign_id uuid REFERENCES campaigns,
  requirement_id uuid REFERENCES requirements,PRIMARY KEY(campaign_id,requirement_id));
CREATE TABLE requirement_segments(requirement_id uuid REFERENCES requirements,
  segment_id uuid REFERENCES segments,PRIMARY KEY(requirement_id,segment_id));
CREATE TABLE catalog_item_requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,catalog_item_id uuid NOT NULL REFERENCES catalog_items,
  requirement_id uuid NOT NULL REFERENCES requirements ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES remote_instances ON DELETE RESTRICT);
CREATE TABLE instance_context(instance_id uuid PRIMARY KEY REFERENCES remote_instances ON DELETE CASCADE, value text);
CREATE TABLE unrelated_instance_refs(id uuid PRIMARY KEY,instance_id uuid REFERENCES remote_instances);
CREATE TABLE api_keys(id uuid PRIMARY KEY,site_id uuid,status text CHECK(status IN ('active','revoked')),metadata jsonb);
CREATE TABLE assets(id uuid PRIMARY KEY,site_id uuid,instance_id uuid REFERENCES remote_instances ON DELETE CASCADE);
ALTER TABLE requirement_status ADD COLUMN asset_id uuid REFERENCES assets ON DELETE CASCADE;
CREATE TABLE agent_assets(asset_id uuid REFERENCES assets ON DELETE CASCADE);
CREATE TABLE content_assets(asset_id uuid REFERENCES assets ON DELETE CASCADE);
CREATE TABLE workflow_triggers(id uuid PRIMARY KEY,instance_id uuid REFERENCES remote_instances ON DELETE CASCADE,
  site_id uuid,template_plan_id uuid REFERENCES instance_plans ON DELETE SET NULL,enabled boolean DEFAULT false);
CREATE TABLE workflow_runs(id uuid PRIMARY KEY,instance_id uuid REFERENCES remote_instances ON DELETE CASCADE,
  site_id uuid,template_plan_id uuid REFERENCES instance_plans ON DELETE SET NULL,
  run_plan_id uuid REFERENCES instance_plans ON DELETE CASCADE,trigger_id uuid REFERENCES workflow_triggers ON DELETE SET NULL,status text);
CREATE TABLE instance_nodes(id uuid PRIMARY KEY,instance_id uuid REFERENCES remote_instances ON DELETE CASCADE,site_id uuid,status text);

-- The old root guard misses site_ownership. Its other table triggers must survive.
CREATE FUNCTION public.check_delete_permission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE site uuid;
BEGIN
  IF TG_TABLE_NAME IN ('requirements','assets') THEN site := OLD.site_id;
  ELSIF TG_TABLE_NAME = 'campaign_requirements' THEN SELECT site_id INTO site FROM public.campaigns WHERE id=OLD.campaign_id;
  ELSE SELECT site_id INTO site FROM public.requirements WHERE id=OLD.requirement_id; END IF;
  IF site IS NOT NULL AND auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sites WHERE id=site AND user_id=auth.uid()
  ) AND NOT EXISTS (SELECT 1 FROM public.site_members WHERE site_id=site AND user_id=auth.uid() AND role='admin' AND status='active') THEN
    RAISE EXCEPTION 'Legacy deletion denied' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER trigger_delete_protection_requirements BEFORE DELETE ON requirements
  FOR EACH ROW EXECUTE FUNCTION check_delete_permission();
CREATE TRIGGER trigger_delete_protection_requirement_segments BEFORE DELETE ON requirement_segments
  FOR EACH ROW EXECUTE FUNCTION check_delete_permission();
CREATE TRIGGER trigger_delete_protection_assets BEFORE DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION check_delete_permission();
CREATE TRIGGER trigger_delete_protection_campaign_requirements BEFORE DELETE ON campaign_requirements
  FOR EACH ROW EXECUTE FUNCTION check_delete_permission();