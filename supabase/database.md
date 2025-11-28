[
  {
    "info_type": "SCHEMA_SUMMARY",
    "object_type": "FUNCTIONS",
    "count": 337
  },
  {
    "info_type": "SCHEMA_SUMMARY",
    "object_type": "TABLES",
    "count": 88
  },
  {
    "info_type": "SCHEMA_SUMMARY",
    "object_type": "TRIGGERS",
    "count": 34
  },
  {
    "info_type": "SCHEMA_SUMMARY",
    "object_type": "VIEWS",
    "count": 11
  }
]

-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

-- ⚠️ CAMBIO ESTRUCTURAL IMPORTANTE (2024-12-19):
-- Los campos device, browser y location han sido REMOVIDOS de la tabla 'visitors'
-- y se mantienen únicamente en la tabla 'visitor_sessions'.
-- Esto permite rastrear múltiples dispositivos/ubicaciones por visitante a través de sus sesiones.

CREATE TABLE public.agent_assets (
  agent_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  CONSTRAINT agent_assets_pkey PRIMARY KEY (agent_id, asset_id),
  CONSTRAINT agent_assets_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id),
  CONSTRAINT agent_assets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id),
  CONSTRAINT fk_command_agent_assets FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.agent_memories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  access_count integer DEFAULT 0,
  last_accessed timestamp with time zone DEFAULT now(),
  command_id uuid,
  chain_of_thoughts text,
  CONSTRAINT agent_memories_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_agent_memories FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  type text NOT NULL CHECK (type = ANY (ARRAY['sales'::text, 'support'::text, 'marketing'::text])),
  status text NOT NULL CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'training'::text])),
  prompt text NOT NULL,
  conversations integer DEFAULT 0,
  success_rate integer DEFAULT 0,
  configuration jsonb DEFAULT '{}'::jsonb,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_active timestamp with time zone DEFAULT now(),
  role text,
  tools jsonb DEFAULT '{}'::jsonb,
  activities jsonb DEFAULT '{}'::jsonb,
  integrations jsonb DEFAULT '{}'::jsonb,
  supervisor uuid,
  backstory text,
  command_id uuid,
  CONSTRAINT agents_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_agents FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT agents_supervisor_fkey FOREIGN KEY (supervisor) REFERENCES public.agents(id),
  CONSTRAINT agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT agents_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.allowed_domains (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  domain text NOT NULL CHECK (domain = 'localhost'::text OR domain ~* '^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,}$'::text OR domain ~* '^(\d{1,3}\.){3}\d{1,3}$'::text OR domain ~* '^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$'::text),
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT allowed_domains_pkey PRIMARY KEY (id),
  CONSTRAINT allowed_domains_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.analysis (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  url_path text NOT NULL,
  structure jsonb NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  status text DEFAULT 'completed'::text,
  request_time integer,
  provider text,
  model_id text,
  command_id uuid,
  CONSTRAINT analysis_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT fk_command_analysis FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT analysis_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying NOT NULL,
  key_hash text NOT NULL,
  prefix character varying NOT NULL CHECK (prefix::text ~* '^[a-zA-Z0-9_-]+$'::text),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  status USER-DEFINED DEFAULT 'active'::key_status,
  scopes ARRAY NOT NULL CHECK (array_length(scopes, 1) > 0),
  last_used_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  metadata jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT api_keys_pkey PRIMARY KEY (id),
  CONSTRAINT fk_site FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.assets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  file_path text NOT NULL,
  file_type text NOT NULL,
  file_size integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  is_public boolean DEFAULT false,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  CONSTRAINT assets_pkey PRIMARY KEY (id),
  CONSTRAINT assets_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_assets FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.billing (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  site_id uuid NOT NULL,
  plan character varying NOT NULL DEFAULT 'free'::character varying,
  card_name character varying,
  masked_card_number character varying,
  card_expiry character varying,
  stripe_customer_id character varying,
  stripe_payment_method_id character varying,
  card_address character varying,
  card_city character varying,
  card_postal_code character varying,
  card_country character varying,
  tax_id character varying,
  billing_address character varying,
  billing_city character varying,
  billing_postal_code character varying,
  billing_country character varying,
  auto_renew boolean DEFAULT true,
  credits_available integer DEFAULT 0,
  credits_used integer DEFAULT 0,
  subscription_start_date timestamp with time zone,
  subscription_end_date timestamp with time zone,
  status character varying DEFAULT 'active'::character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  command_id uuid,
  CONSTRAINT billing_pkey PRIMARY KEY (id),
  CONSTRAINT billing_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_billing FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.campaign_requirements (
  campaign_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  command_id uuid,
  CONSTRAINT campaign_requirements_pkey PRIMARY KEY (campaign_id, requirement_id),
  CONSTRAINT fk_command_campaign_requirements FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT campaign_requirements_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT campaign_requirements_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.requirements(id)
);
CREATE TABLE public.campaign_segments (
  campaign_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  command_id uuid,
  CONSTRAINT campaign_segments_pkey PRIMARY KEY (campaign_id, segment_id),
  CONSTRAINT campaign_segments_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT fk_command_campaign_segments FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT campaign_segments_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id)
);
CREATE TABLE public.campaign_subtasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['completed'::text, 'in-progress'::text, 'pending'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  CONSTRAINT campaign_subtasks_pkey PRIMARY KEY (id),
  CONSTRAINT campaign_subtasks_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT fk_command_campaign_subtasks FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.campaigns (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  priority USER-DEFINED NOT NULL DEFAULT 'medium'::campaign_priority,
  status USER-DEFINED NOT NULL DEFAULT 'pending'::campaign_status,
  due_date date,
  assignees integer DEFAULT 0,
  issues integer DEFAULT 0,
  revenue jsonb DEFAULT '{"actual": 0, "currency": "USD", "estimated": 0, "projected": 0}'::jsonb,
  budget jsonb DEFAULT '{"currency": "USD", "allocated": 0, "remaining": 0}'::jsonb,
  type text NOT NULL,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  CONSTRAINT campaigns_pkey PRIMARY KEY (id),
  CONSTRAINT campaigns_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_campaigns FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT campaigns_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  icon text,
  color text,
  is_active boolean DEFAULT true,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT categories_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.commands (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task text NOT NULL,
  status USER-DEFINED NOT NULL DEFAULT 'pending'::command_status,
  description text,
  results jsonb DEFAULT '[]'::jsonb,
  targets jsonb DEFAULT '[]'::jsonb,
  tools jsonb DEFAULT '[]'::jsonb,
  context text,
  supervisor jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  completion_date timestamp with time zone,
  duration integer,
  model text,
  agent_id uuid,
  user_id uuid NOT NULL,
  output_tokens numeric DEFAULT '0'::numeric,
  input_tokens numeric DEFAULT '0'::numeric,
  site_id uuid,
  agent_background text,
  functions jsonb DEFAULT '[]'::jsonb,
  performance integer DEFAULT 0,
  CONSTRAINT commands_pkey PRIMARY KEY (id),
  CONSTRAINT commands_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id),
  CONSTRAINT commands_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.companies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  website text,
  industry text CHECK (industry = ANY (ARRAY['technology'::text, 'finance'::text, 'healthcare'::text, 'education'::text, 'retail'::text, 'manufacturing'::text, 'services'::text, 'hospitality'::text, 'media'::text, 'real_estate'::text, 'logistics'::text, 'nonprofit'::text, 'other'::text])),
  size text CHECK (size = ANY (ARRAY['1-10'::text, '11-50'::text, '51-200'::text, '201-500'::text, '501-1000'::text, '1001-5000'::text, '5001-10000'::text, '10001+'::text])),
  annual_revenue text CHECK (annual_revenue = ANY (ARRAY['<1M'::text, '1M-10M'::text, '10M-50M'::text, '50M-100M'::text, '100M-500M'::text, '500M-1B'::text, '>1B'::text])),
  founded text,
  description text,
  address jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  legal_name text,
  tax_id text,
  tax_country text,
  registration_number text,
  vat_number text,
  legal_structure text CHECK (legal_structure = ANY (ARRAY['sole_proprietorship'::text, 'partnership'::text, 'llc'::text, 'corporation'::text, 'nonprofit'::text, 'cooperative'::text, 's_corp'::text, 'c_corp'::text, 'lp'::text, 'llp'::text, 'sa'::text, 'srl'::text, 'gmbh'::text, 'ltd'::text, 'plc'::text, 'bv'::text, 'nv'::text, 'other'::text])),
  phone text,
  email text,
  linkedin_url text,
  employees_count integer,
  is_public boolean DEFAULT false,
  stock_symbol text,
  parent_company_id uuid,
  logo_url text,
  cover_image_url text,
  social_media jsonb DEFAULT '{}'::jsonb,
  key_people jsonb DEFAULT '[]'::jsonb,
  funding_info jsonb DEFAULT '{}'::jsonb,
  certifications ARRAY DEFAULT ARRAY[]::text[],
  awards ARRAY DEFAULT ARRAY[]::text[],
  business_model text CHECK (business_model = ANY (ARRAY['b2b'::text, 'b2c'::text, 'b2b2c'::text, 'marketplace'::text, 'saas'::text, 'ecommerce'::text, 'other'::text])),
  products_services jsonb DEFAULT '[]'::jsonb,
  tech_stack ARRAY DEFAULT ARRAY[]::text[],
  languages ARRAY DEFAULT ARRAY['en'::text],
  business_hours jsonb DEFAULT '{}'::jsonb,
  video_url text,
  press_releases jsonb DEFAULT '[]'::jsonb,
  partnerships jsonb DEFAULT '[]'::jsonb,
  competitor_info jsonb DEFAULT '{}'::jsonb,
  sustainability_score integer CHECK (sustainability_score >= 0 AND sustainability_score <= 100),
  diversity_info jsonb DEFAULT '{}'::jsonb,
  remote_policy text CHECK (remote_policy = ANY (ARRAY['remote_first'::text, 'hybrid'::text, 'office_only'::text, 'flexible'::text])),
  office_locations jsonb DEFAULT '[]'::jsonb,
  market_cap bigint,
  last_funding_date date,
  ipo_date date,
  acquisition_date date,
  acquired_by_id uuid,
  CONSTRAINT companies_pkey PRIMARY KEY (id),
  CONSTRAINT companies_parent_company_id_fkey FOREIGN KEY (parent_company_id) REFERENCES public.companies(id),
  CONSTRAINT companies_acquired_by_id_fkey FOREIGN KEY (acquired_by_id) REFERENCES public.companies(id)
);
CREATE TABLE public.content (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  title text NOT NULL,
  description text,
  type text NOT NULL CHECK (type = ANY (ARRAY['blog_post'::text, 'video'::text, 'podcast'::text, 'social_post'::text, 'newsletter'::text, 'case_study'::text, 'whitepaper'::text, 'infographic'::text, 'webinar'::text, 'ebook'::text, 'ad'::text, 'landing_page'::text])),
  status text NOT NULL CHECK (status = ANY (ARRAY['draft'::text, 'review'::text, 'approved'::text, 'published'::text, 'archived'::text])),
  segment_id uuid,
  site_id uuid NOT NULL,
  author_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  published_at timestamp with time zone,
  tags ARRAY,
  estimated_reading_time integer,
  word_count integer,
  seo_score integer,
  user_id uuid,
  text text,
  campaign_id uuid,
  performance_rating smallint CHECK (performance_rating IS NULL OR performance_rating >= 1 AND performance_rating <= 5),
  metadata jsonb DEFAULT '{}'::jsonb,
  command_id uuid,
  instructions text,
  CONSTRAINT content_pkey PRIMARY KEY (id),
  CONSTRAINT content_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT content_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id),
  CONSTRAINT content_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT content_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT content_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT content_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.conversations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  visitor_id uuid,
  agent_id uuid,
  user_id uuid,
  lead_id uuid,
  site_id uuid,
  status text DEFAULT 'active'::text,
  title text,
  custom_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_message_at timestamp with time zone,
  is_archived boolean DEFAULT false,
  command_id uuid,
  flag integer DEFAULT 0,
  delegate_id uuid,
  channel text,
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT fk_lead FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT conversations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id),
  CONSTRAINT conversations_delegate_id_fkey FOREIGN KEY (delegate_id) REFERENCES public.agents(id),
  CONSTRAINT conversations_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_visitor FOREIGN KEY (visitor_id) REFERENCES public.visitors(id),
  CONSTRAINT fk_command_conversations FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.cron_status (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id text,
  schedule_id text,
  activity_name text,
  status text NOT NULL DEFAULT 'pending'::text,
  last_run timestamp with time zone,
  next_run timestamp with time zone,
  error_message text,
  retry_count integer DEFAULT 0,
  site_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT cron_status_pkey PRIMARY KEY (id),
  CONSTRAINT cron_status_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.debug_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  operation text,
  user_id uuid,
  site_id uuid,
  details jsonb,
  created_at timestamp with time zone DEFAULT now(),
  command_id uuid,
  CONSTRAINT debug_logs_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_debug_logs FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.experiment_segments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  experiment_id uuid,
  segment_id uuid,
  participants integer DEFAULT 0,
  command_id uuid,
  CONSTRAINT experiment_segments_pkey PRIMARY KEY (id),
  CONSTRAINT experiment_segments_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT experiment_segments_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES public.experiments(id),
  CONSTRAINT fk_command_experiment_segments FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.experiments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  status text NOT NULL CHECK (status = ANY (ARRAY['active'::text, 'completed'::text, 'draft'::text])),
  start_date timestamp with time zone,
  end_date timestamp with time zone,
  conversion numeric,
  roi numeric,
  preview_url text,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  hypothesis text,
  campaign_id uuid,
  command_id uuid,
  instructions text,
  validations text,
  CONSTRAINT experiments_pkey PRIMARY KEY (id),
  CONSTRAINT experiments_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT fk_command_experiments FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT experiments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT experiments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.external_resources (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL,
  url text NOT NULL,
  description text,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  CONSTRAINT external_resources_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_external_resources FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT external_resources_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT external_resources_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.kpis (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  value numeric NOT NULL,
  previous_value numeric,
  unit text NOT NULL,
  type text NOT NULL CHECK (type IS NOT NULL),
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  segment_id uuid,
  is_highlighted boolean DEFAULT false,
  target_value numeric,
  metadata jsonb DEFAULT '{}'::jsonb,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  trend numeric DEFAULT 0,
  benchmark numeric,
  command_id uuid,
  CONSTRAINT kpis_pkey PRIMARY KEY (id),
  CONSTRAINT kpis_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT kpis_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT fk_command_kpis FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT kpis_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  personal_email text,
  position text,
  segment_id uuid,
  status text NOT NULL CHECK (status = ANY (ARRAY['new'::text, 'contacted'::text, 'qualified'::text, 'converted'::text, 'lost'::text])),
  notes text,
  last_contact timestamp with time zone,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  phone text,
  origin text,
  social_networks jsonb DEFAULT '{}'::jsonb,
  address jsonb DEFAULT '{}'::jsonb,
  company jsonb DEFAULT '{}'::jsonb,
  subscription jsonb DEFAULT '{}'::jsonb,
  birthday text,
  campaign_id uuid,
  command_id uuid,
  language text,
  company_id uuid,
  attribution jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  assignee_id uuid,
  referral_lead_id uuid,
  CONSTRAINT leads_pkey PRIMARY KEY (id),
  CONSTRAINT leads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id),
  CONSTRAINT leads_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT leads_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT leads_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT leads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT leads_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES auth.users(id),
  CONSTRAINT fk_command_leads FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT leads_referral_lead_id_fkey FOREIGN KEY (referral_lead_id) REFERENCES public.leads(id)
);
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  visitor_id uuid,
  agent_id uuid,
  user_id uuid,
  lead_id uuid,
  content text NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text, 'function'::text, 'tool'::text, 'data'::text, 'team_member'::text])),
  read_at timestamp with time zone,
  custom_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  command_id uuid,
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT fk_lead FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT fk_conversation FOREIGN KEY (conversation_id) REFERENCES public.conversations(id),
  CONSTRAINT fk_command_messages FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT fk_visitor FOREIGN KEY (visitor_id) REFERENCES public.visitors(id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'error'::text])),
  is_read boolean DEFAULT false,
  action_url text,
  related_entity_type text,
  related_entity_id uuid,
  site_id uuid,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  event_type text CHECK (event_type = ANY (ARRAY['lead_created'::text, 'kpi_alert'::text, 'experiment_result'::text])),
  severity integer,
  command_id uuid,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT notifications_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_notifications FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.payments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  site_id uuid NOT NULL,
  transaction_id character varying DEFAULT ('tx_'::text || substr(md5(((random())::text || (clock_timestamp())::text)), 1, 16)),
  transaction_type character varying NOT NULL,
  amount numeric NOT NULL,
  currency character varying DEFAULT 'USD'::character varying,
  status character varying NOT NULL,
  payment_method character varying,
  details jsonb DEFAULT '{}'::jsonb,
  credits integer DEFAULT 0,
  invoice_url character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  command_id uuid,
  CONSTRAINT payments_pkey PRIMARY KEY (id),
  CONSTRAINT payments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_payments FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  email text NOT NULL,
  name text,
  avatar_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  bio text,
  role text CHECK (role = ANY (ARRAY['Product Manager'::text, 'Designer'::text, 'Developer'::text, 'Marketing'::text, 'Sales'::text, 'CEO'::text, 'Other'::text])),
  language text DEFAULT 'es'::text CHECK (language = ANY (ARRAY['es'::text, 'en'::text, 'fr'::text, 'de'::text])),
  timezone text DEFAULT 'America/Mexico_City'::text,
  notifications jsonb DEFAULT '{"push": true, "email": true}'::jsonb CHECK (validate_notifications(notifications)),
  settings jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id),
  CONSTRAINT fk_command_profiles FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.referral_code_uses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_code_id uuid NOT NULL,
  user_id uuid NOT NULL,
  used_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT referral_code_uses_pkey PRIMARY KEY (id),
  CONSTRAINT referral_code_uses_referral_code_id_fkey FOREIGN KEY (referral_code_id) REFERENCES public.referral_codes(id),
  CONSTRAINT referral_code_uses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.referral_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  description text,
  is_active boolean DEFAULT true,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  current_uses integer DEFAULT 0 CHECK (current_uses >= 0),
  expires_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT referral_codes_pkey PRIMARY KEY (id),
  CONSTRAINT referral_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id)
);
CREATE TABLE public.requirement_segments (
  requirement_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  command_id uuid,
  CONSTRAINT requirement_segments_pkey PRIMARY KEY (requirement_id, segment_id),
  CONSTRAINT fk_command_requirement_segments FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT requirement_segments_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.requirements(id),
  CONSTRAINT requirement_segments_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id)
);
CREATE TABLE public.requirements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  priority text NOT NULL CHECK (priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
  status text NOT NULL CHECK (status = ANY (ARRAY['validated'::text, 'in-progress'::text, 'on-review'::text, 'done'::text, 'backlog'::text, 'canceled'::text])),
  completion_status text NOT NULL CHECK (completion_status = ANY (ARRAY['pending'::text, 'completed'::text, 'rejected'::text])),
  source text,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  budget numeric,
  instructions text,
  command_id uuid,
  type USER-DEFINED DEFAULT 'task'::requirement_type,
  CONSTRAINT requirements_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_requirements FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT requirements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT requirements_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.sale_orders (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  sale_id uuid NOT NULL,
  order_number text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_total numeric NOT NULL DEFAULT 0,
  discount_total numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL DEFAULT 'completed'::text,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT sale_orders_pkey PRIMARY KEY (id),
  CONSTRAINT sale_orders_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id),
  CONSTRAINT sale_orders_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.sales (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid,
  campaign_id uuid,
  segment_id uuid,
  amount numeric NOT NULL,
  currency text DEFAULT 'USD'::text,
  status text NOT NULL CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text])),
  title text NOT NULL,
  description text,
  sale_date date NOT NULL,
  payment_method text,
  payment_details jsonb DEFAULT '{}'::jsonb,
  invoice_number text,
  product_name text,
  product_type text,
  product_details jsonb DEFAULT '{}'::jsonb,
  reference_code text,
  external_id text,
  notes text,
  tags ARRAY,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  channel text DEFAULT 'online'::text,
  source text DEFAULT 'online'::text CHECK (source = ANY (ARRAY['retail'::text, 'online'::text])),
  amount_due numeric DEFAULT '0'::numeric,
  payments jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT sales_pkey PRIMARY KEY (id),
  CONSTRAINT sales_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT sales_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT sales_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT sales_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT sales_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT fk_command_sales FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.secure_tokens (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  site_id uuid,
  token_type text NOT NULL,
  encrypted_value text NOT NULL,
  identifier text NOT NULL,
  last_used timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT secure_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT secure_tokens_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.segments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  audience USER-DEFINED CHECK (audience = ANY (ARRAY['enterprise'::segment_audience, 'smb'::segment_audience, 'startup'::segment_audience, 'b2b_saas'::segment_audience, 'e_commerce'::segment_audience, 'tech'::segment_audience, 'finance'::segment_audience, 'healthcare'::segment_audience, 'education'::segment_audience, 'manufacturing'::segment_audience, 'retail'::segment_audience, 'real_estate'::segment_audience, 'hospitality'::segment_audience, 'automotive'::segment_audience, 'media'::segment_audience, 'telecom'::segment_audience, 'energy'::segment_audience, 'agriculture'::segment_audience, 'construction'::segment_audience, 'logistics'::segment_audience, 'professional'::segment_audience, 'government'::segment_audience, 'nonprofit'::segment_audience, 'legal'::segment_audience, 'pharma'::segment_audience, 'insurance'::segment_audience, 'consulting'::segment_audience, 'research'::segment_audience, 'aerospace'::segment_audience, 'gaming'::segment_audience])),
  size numeric,
  engagement integer,
  is_active boolean DEFAULT true,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  language USER-DEFINED NOT NULL DEFAULT 'en'::segment_language CHECK (language = ANY (ARRAY['en'::segment_language, 'zh'::segment_language, 'hi'::segment_language, 'es'::segment_language, 'ar'::segment_language, 'bn'::segment_language, 'pt'::segment_language, 'ru'::segment_language, 'ja'::segment_language, 'de'::segment_language, 'fr'::segment_language, 'ur'::segment_language, 'id'::segment_language, 'tr'::segment_language, 'it'::segment_language, 'th'::segment_language, 'vi'::segment_language, 'ko'::segment_language, 'fa'::segment_language, 'pl'::segment_language, 'uk'::segment_language, 'ro'::segment_language, 'nl'::segment_language, 'el'::segment_language, 'cs'::segment_language, 'sv'::segment_language, 'hu'::segment_language, 'da'::segment_language, 'fi'::segment_language, 'no'::segment_language])),
  url text,
  analysis jsonb,
  topics jsonb,
  icp jsonb,
  estimated_value numeric,
  command_id uuid,
  rules jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT segments_pkey PRIMARY KEY (id),
  CONSTRAINT segments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT segments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_command_segments FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.session_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  url text,
  timestamp bigint NOT NULL,
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  site_id text NOT NULL,
  visitor_id uuid,
  referrer text,
  user_agent text,
  ip text,
  event_name text,
  properties jsonb DEFAULT '{}'::jsonb,
  session_id uuid,
  activity jsonb,
  command_id uuid,
  segment_id uuid,
  CONSTRAINT session_events_pkey PRIMARY KEY (id),
  CONSTRAINT fk_visitor_session FOREIGN KEY (session_id) REFERENCES public.visitor_sessions(id),
  CONSTRAINT session_events_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES public.visitors(id),
  CONSTRAINT session_events_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id),
  CONSTRAINT fk_command_session_events FOREIGN KEY (command_id) REFERENCES public.commands(id)
);
CREATE TABLE public.settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL UNIQUE,
  about text,
  company_size text,
  industry text,
  products jsonb DEFAULT '[]'::jsonb,
  services jsonb DEFAULT '[]'::jsonb,
  swot jsonb DEFAULT '{"threats": "", "strengths": "", "weaknesses": "", "opportunities": ""}'::jsonb,
  locations jsonb DEFAULT '[]'::jsonb,
  marketing_budget jsonb DEFAULT '{"total": 0, "available": 0}'::jsonb,
  marketing_channels jsonb DEFAULT '[]'::jsonb,
  social_media jsonb DEFAULT '[]'::jsonb,
  analytics_provider text,
  analytics_id text,
  team_members jsonb DEFAULT '[]'::jsonb,
  team_roles jsonb DEFAULT '[]'::jsonb,
  org_structure jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  competitors jsonb DEFAULT '[]'::jsonb,
  focus_mode integer DEFAULT 50,
  goals jsonb DEFAULT '[]'::jsonb,
  channels jsonb DEFAULT '[]'::jsonb,
  business_hours jsonb DEFAULT '[]'::jsonb,
  branding jsonb DEFAULT NULL,
  customer_journey jsonb DEFAULT '{"awareness": {"metrics": [], "actions": [], "tactics": []}, "consideration": {"metrics": [], "actions": [], "tactics": []}, "decision": {"metrics": [], "actions": [], "tactics": []}, "purchase": {"metrics": [], "actions": [], "tactics": []}, "retention": {"metrics": [], "actions": [], "tactics": []}, "referral": {"metrics": [], "actions": [], "tactics": []}}'::jsonb,
  activities jsonb DEFAULT '{"daily_resume_and_stand_up": {"status": "default"}, "local_lead_generation": {"status": "default"}, "icp_lead_generation": {"status": "default"}, "leads_initial_cold_outreach": {"status": "default"}, "leads_follow_up": {"status": "default"}, "email_sync": {"status": "default"}, "assign_leads_to_team": {"status": "inactive"}, "notify_team_on_inbound_conversations": {"status": "default"}, "supervise_conversations": {"status": "inactive"}}'::jsonb,
  CONSTRAINT settings_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_settings FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT settings_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);

-- Comments on columns
COMMENT ON COLUMN public.settings.branding IS 'Brand identity information including: brand pyramid (essence, personality, benefits, attributes, values, promise), color palette, typography, voice/tone, communication style, brand assets, and guidelines';
COMMENT ON COLUMN public.settings.customer_journey IS 'Customer journey configuration with metrics, actions, and tactics for each stage: awareness, interest, consideration, purchase, retention, and advocacy';

-- Lead Analysis Collection for ROI Calculator
CREATE TABLE public.lead_analysis (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  
  -- Company Information
  company_name text NOT NULL,
  industry text CHECK (industry = ANY (ARRAY['technology'::text, 'finance'::text, 'healthcare'::text, 'education'::text, 'retail'::text, 'manufacturing'::text, 'services'::text, 'hospitality'::text, 'media'::text, 'real_estate'::text, 'logistics'::text, 'nonprofit'::text, 'other'::text])),
  company_size text CHECK (company_size = ANY (ARRAY['1-10'::text, '11-50'::text, '51-200'::text, '201-500'::text, '501-1000'::text, '1000+'::text])),
  annual_revenue text CHECK (annual_revenue = ANY (ARRAY['<1M'::text, '1M-5M'::text, '5M-10M'::text, '10M-50M'::text, '50M-100M'::text, '100M+'::text])),
  
  -- Current KPIs (stored as JSONB for flexibility)
  current_kpis jsonb DEFAULT '{
    "monthlyRevenue": 0,
    "customerAcquisitionCost": 0,
    "customerLifetimeValue": 0,
    "conversionRate": 0,
    "averageOrderValue": 0,
    "monthlyLeads": 0,
    "salesCycleLength": 0,
    "convertedCustomers": 0,
    "customerLifetimeSpan": 0,
    "churnRate": 0,
    "marketingQualifiedLeads": 0,
    "salesQualifiedLeads": 0
  }'::jsonb,
  
  -- Current Costs
  current_costs jsonb DEFAULT '{
    "marketingBudget": 0,
    "salesTeamCost": 0,
    "salesCommission": 0,
    "technologyCosts": 0,
    "operationalCosts": 0,
    "cogs": 0,
    "otherCosts": 0,
    "totalMonthlyCosts": 0
  }'::jsonb,
  
  -- Sales Process Information
          sales_process jsonb DEFAULT '{
          "leadSources": [],
          "qualificationProcess": {
            "deepResearch": false,
            "manualResearch": false,
            "interviews": false,
            "icpTargeting": false,
            "behaviorAnalysis": false,
            "leadScoring": false,
            "demographicFiltering": false,
            "companySize": false,
            "budgetQualification": false,
            "decisionMakerID": false,
            "painPointAssessment": false,
            "competitorAnalysis": false
          },
          "followUpFrequency": "",
          "closingTechniques": [],
          "painPoints": [],
          "salesTeamSize": 0,
          "averageDealSize": 0,
          "winRate": 0,
          "salesActivities": {
            "coldCalls": false,
            "personalizedFollowUp": false,
            "videoCalls": false,
            "transactionalEmails": false,
            "socialSelling": false,
            "contentMarketing": false,
            "referralProgram": false,
            "webinarsEvents": false,
            "paidAds": false,
            "seoContent": false,
            "partnerships": false,
            "directMail": false,
            "tradeShows": false,
            "influencerMarketing": false,
            "retargeting": false,
            "activations": false,
            "physicalVisits": false,
            "personalBrand": false
          }
        }'::jsonb,
  
  -- Goals and Objectives
  goals jsonb DEFAULT '{
    "revenueTarget": 0,
    "timeframe": "",
    "primaryObjectives": [],
    "growthChallenges": [],
    "marketingGoals": [],
    "salesGoals": []
  }'::jsonb,
  
  -- Analysis Results (calculated and stored)
  analysis_results jsonb DEFAULT '{
    "currentROI": 0,
    "projectedROI": 0,
    "potentialIncrease": 0,
    "projectedRevenue": 0,
    "projectedCosts": 0,
    "opportunityCosts": 0,
    "recommendations": [],
    "riskFactors": [],
    "implementationPlan": {},
    "expectedTimeline": ""
  }'::jsonb,
  
  -- ROI Projections
  roi_projections jsonb DEFAULT '{
    "threeMonth": {"revenue": 0, "costs": 0, "roi": 0},
    "sixMonth": {"revenue": 0, "costs": 0, "roi": 0},
    "twelveMonth": {"revenue": 0, "costs": 0, "roi": 0},
    "twentyFourMonth": {"revenue": 0, "costs": 0, "roi": 0}
  }'::jsonb,
  
  -- Strategies and Opportunities
  strategies jsonb DEFAULT '{
    "leadOptimization": [],
    "conversionImprovement": [],
    "costReduction": [],
    "revenueGrowth": [],
    "processAutomation": [],
    "technologyUpgrades": []
  }'::jsonb,
  
  -- Contact Information (for follow-up)
  contact_info jsonb DEFAULT '{
    "email": "",
    "phone": "",
    "name": "",
    "title": "",
    "preferredContactMethod": "",
    "bestTimeToCall": ""
  }'::jsonb,
  
  -- Analysis Status and Metadata
  status text DEFAULT 'draft' CHECK (status = ANY (ARRAY['draft'::text, 'completed'::text, 'reviewed'::text, 'contacted'::text, 'converted'::text])),
  completion_percentage integer DEFAULT 0 CHECK (completion_percentage >= 0 AND completion_percentage <= 100),
  
  -- Tracking and Attribution
  source text DEFAULT 'roi-calculator',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  ip_address inet,
  user_agent text,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  
  -- Optional user association (if they sign up)
  user_id uuid,
  site_id uuid,
  
  CONSTRAINT lead_analysis_pkey PRIMARY KEY (id),
  CONSTRAINT lead_analysis_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT lead_analysis_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);

-- Comments on lead_analysis table
COMMENT ON TABLE public.lead_analysis IS 'ROI Calculator lead analysis data - stores comprehensive business analysis for prospects';
COMMENT ON COLUMN public.lead_analysis.current_kpis IS 'Current business KPIs and metrics including revenue, CAC, LTV, conversion rates, etc.';
COMMENT ON COLUMN public.lead_analysis.current_costs IS 'Current business costs breakdown including marketing, sales, technology, and operational expenses';
COMMENT ON COLUMN public.lead_analysis.sales_process IS 'Information about current sales process, lead sources, qualification methods, and challenges';
COMMENT ON COLUMN public.lead_analysis.goals IS 'Business goals, targets, objectives, and growth challenges';
COMMENT ON COLUMN public.lead_analysis.analysis_results IS 'Calculated ROI analysis results, recommendations, and projections';
COMMENT ON COLUMN public.lead_analysis.roi_projections IS 'ROI projections for different timeframes (3, 6, 12, 24 months)';
COMMENT ON COLUMN public.lead_analysis.strategies IS 'Recommended strategies and opportunities for growth and optimization';
COMMENT ON COLUMN public.lead_analysis.contact_info IS 'Contact information for follow-up and sales outreach';

-- Indexes for performance
CREATE INDEX idx_lead_analysis_created_at ON public.lead_analysis(created_at DESC);
CREATE INDEX idx_lead_analysis_status ON public.lead_analysis(status);
CREATE INDEX idx_lead_analysis_company_size ON public.lead_analysis(company_size);
CREATE INDEX idx_lead_analysis_industry ON public.lead_analysis(industry);
CREATE INDEX idx_lead_analysis_source ON public.lead_analysis(source);
CREATE INDEX idx_lead_analysis_completion ON public.lead_analysis(completion_percentage);

-- RLS (Row Level Security) policies
ALTER TABLE public.lead_analysis ENABLE ROW LEVEL SECURITY;

-- Policy for public access (ROI calculator is public)
CREATE POLICY "Allow public insert for ROI calculator" ON public.lead_analysis
  FOR INSERT WITH CHECK (true);

-- Policy for users to view their own analyses
CREATE POLICY "Users can view own analyses" ON public.lead_analysis
  FOR SELECT USING (auth.uid() = user_id);

-- Policy for users to update their own analyses
CREATE POLICY "Users can update own analyses" ON public.lead_analysis
  FOR UPDATE USING (auth.uid() = user_id);

-- Policy for admin access (if needed)
CREATE POLICY "Admin full access" ON public.lead_analysis
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users 
      WHERE auth.users.id = auth.uid() 
      AND auth.users.raw_user_meta_data->>'role' = 'admin'
    )
  );
CREATE TABLE public.site_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  user_id uuid,
  role text NOT NULL CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'marketing'::text, 'collaborator'::text])),
  added_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  email text NOT NULL,
  name text,
  position text,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'rejected'::text])),
  CONSTRAINT site_members_pkey PRIMARY KEY (id),
  CONSTRAINT site_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id),
  CONSTRAINT site_members_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT site_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.site_ownership (
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT site_ownership_pkey PRIMARY KEY (site_id),
  CONSTRAINT site_ownership_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT site_ownership_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);
CREATE TABLE public.sites (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text,
  description text,
  logo_url text,
  resource_urls jsonb DEFAULT '[]'::jsonb,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  tracking jsonb DEFAULT '{"record_screen": false, "track_actions": false, "track_visitors": false}'::jsonb,
  command_id uuid,
  CONSTRAINT sites_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_sites FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT sites_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.synced_objects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  site_id uuid NOT NULL,
  object_type text NOT NULL DEFAULT 'email'::text,
  status text NOT NULL DEFAULT 'pending'::text,
  provider text,
  first_seen_at timestamp with time zone DEFAULT now(),
  last_processed_at timestamp with time zone,
  process_count integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT synced_objects_pkey PRIMARY KEY (id)
);
CREATE TABLE public.task_categories (
  task_id uuid NOT NULL,
  category_id uuid NOT NULL,
  CONSTRAINT task_categories_pkey PRIMARY KEY (task_id, category_id),
  CONSTRAINT task_categories_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id),
  CONSTRAINT task_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id)
);
CREATE TABLE public.task_comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  user_id uuid NOT NULL,
  content text NOT NULL,
  attachments jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_private boolean NOT NULL DEFAULT false,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  cta jsonb DEFAULT NULL,
  CONSTRAINT task_comments_pkey PRIMARY KEY (id),
  CONSTRAINT task_comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id),
  CONSTRAINT task_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);

-- Comments on columns
COMMENT ON COLUMN public.task_comments.cta IS 'Call to Action button data in JSONB format with structure: {"primary_action": {"title": "string", "url": "string"}}';

CREATE TABLE public.tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  type text NOT NULL,
  stage text NOT NULL CHECK (stage = ANY (ARRAY['awareness'::text, 'consideration'::text, 'decision'::text, 'purchase'::text, 'retention'::text, 'referral'::text])),
  status text NOT NULL CHECK (status = ANY (ARRAY['completed'::text, 'in_progress'::text, 'pending'::text, 'failed'::text])),
  scheduled_date timestamp with time zone NOT NULL,
  completed_date timestamp with time zone,
  amount numeric,
  assignee uuid,
  notes text,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  serial_id text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  address jsonb,
  conversation_id uuid,
  CONSTRAINT tasks_pkey PRIMARY KEY (id),
  CONSTRAINT tasks_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT tasks_assignee_fkey FOREIGN KEY (assignee) REFERENCES auth.users(id),
  CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT fk_command_tasks FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT tasks_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT fk_conversation_tasks FOREIGN KEY (conversation_id) REFERENCES public.conversations(id)
);
CREATE TABLE public.transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  campaign_id uuid,
  type text NOT NULL CHECK (type = ANY (ARRAY['fixed'::text, 'variable'::text])),
  amount numeric NOT NULL,
  description text,
  date date NOT NULL,
  currency text DEFAULT 'USD'::text,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  command_id uuid,
  category text,
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_transactions FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT transactions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
  CONSTRAINT transactions_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id),
  CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.visitor_sessions (
  id uuid NOT NULL,
  visitor_id uuid NOT NULL,
  site_id uuid NOT NULL,
  landing_url text,
  current_url text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  started_at bigint NOT NULL,
  last_activity_at bigint NOT NULL,
  page_views integer DEFAULT 1,
  device jsonb,
  browser jsonb,
  location jsonb,
  previous_session_id uuid,
  performance jsonb,
  consent jsonb,
  is_active boolean DEFAULT true,
  duration bigint,
  active_time bigint,
  idle_time bigint,
  lead_id uuid,
  exit_url text,
  exit_type text,
  custom_data jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone,
  command_id uuid,
  identified_at bigint,
  lead_data jsonb,
  CONSTRAINT visitor_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_visitor_sessions FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT visitor_sessions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT visitor_sessions_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES public.visitors(id)
);
CREATE TABLE public.visitors (
  id uuid NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  total_sessions integer DEFAULT 1,
  total_page_views integer DEFAULT 0,
  total_time_spent bigint DEFAULT 0,
  first_url text,
  first_referrer text,
  first_utm_source text,
  first_utm_medium text,
  first_utm_campaign text,
  first_utm_term text,
  first_utm_content text,
  -- device, browser, location campos removidos - ahora solo en visitor_sessions
  custom_data jsonb,
  lead_id uuid,
  is_identified boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone,
  fingerprint text,
  command_id uuid,
  segment_id uuid,
  CONSTRAINT visitors_pkey PRIMARY KEY (id),
  CONSTRAINT fk_command_visitors FOREIGN KEY (command_id) REFERENCES public.commands(id),
  CONSTRAINT visitors_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id)
);
CREATE TABLE public.waitlist (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  referral_code_attempted text,
  source text DEFAULT 'signup'::text,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'converted'::text])),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_pkey PRIMARY KEY (id)
);
CREATE TABLE public.whatsapp_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_sid text NOT NULL,
  template_name text NOT NULL,
  content text NOT NULL,
  original_message text,
  site_id uuid NOT NULL,
  account_sid text NOT NULL,
  status text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'pending'::text, 'failed'::text])),
  language text DEFAULT 'es'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_used timestamp with time zone,
  usage_count integer DEFAULT 0,
  CONSTRAINT whatsapp_templates_pkey PRIMARY KEY (id),
  CONSTRAINT whatsapp_templates_unique_sid UNIQUE (template_sid),
  CONSTRAINT whatsapp_templates_unique_name_site UNIQUE (template_name, site_id),
  CONSTRAINT whatsapp_templates_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id)
);

-- ============================================================================
-- REMOTE AUTOMATION TABLES
-- Provider-agnostic infrastructure for remote desktop instance management
-- ============================================================================

-- Remote desktop instances (Ubuntu, Browser, Windows) for AI agent automation
CREATE TABLE public.remote_instances (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  instance_type text NOT NULL CHECK (instance_type = ANY (ARRAY['ubuntu'::text, 'browser'::text, 'windows'::text])),
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending'::text, 'starting'::text, 'running'::text, 'paused'::text, 'stopping'::text, 'stopped'::text, 'error'::text])),
  provider_instance_id text,
  cdp_url text,
  timeout_hours integer DEFAULT 1,
  configuration jsonb DEFAULT '{}'::jsonb,
  environment_variables jsonb DEFAULT '{}'::jsonb,
  tools_enabled jsonb DEFAULT '["bash", "computer", "edit"]'::jsonb,
  last_screenshot_at timestamp with time zone,
  last_activity_at timestamp with time zone,
  total_commands_executed integer DEFAULT 0,
  estimated_cost numeric(10,4) DEFAULT 0.0000,
  actual_cost numeric(10,4) DEFAULT 0.0000,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent_id uuid,
  command_id uuid,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  stopped_at timestamp with time zone,
  CONSTRAINT remote_instances_pkey PRIMARY KEY (id),
  CONSTRAINT remote_instances_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT remote_instances_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT remote_instances_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL,
  CONSTRAINT fk_command_remote_instances FOREIGN KEY (command_id) REFERENCES public.commands(id) ON DELETE SET NULL,
  CONSTRAINT remote_instances_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE
);
-- Browser authentication sessions for reuse across automation instances
CREATE TABLE public.automation_auth_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  provider_auth_state_id text,
  domain text NOT NULL,
  auth_type text NOT NULL CHECK (auth_type = ANY (ARRAY['cookies'::text, 'localStorage'::text, 'sessionStorage'::text, 'credentials'::text, 'oauth'::text])),
  auth_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  browser_type text DEFAULT 'chrome',
  user_agent text,
  viewport jsonb DEFAULT '{"width": 1920, "height": 1080}'::jsonb,
  last_used_at timestamp with time zone,
  usage_count integer DEFAULT 0,
  is_valid boolean DEFAULT true,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  instance_id uuid,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone,
  CONSTRAINT automation_auth_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT automation_auth_sessions_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT automation_auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT automation_auth_sessions_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.remote_instances(id) ON DELETE SET NULL,
  CONSTRAINT automation_auth_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT automation_auth_sessions_site_domain_name_unique UNIQUE (site_id, domain, name)
);
-- Detailed logs of all actions, tool calls, and results within instances
CREATE TABLE public.instance_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  log_type text NOT NULL CHECK (log_type = ANY (ARRAY['system'::text, 'user_action'::text, 'agent_action'::text, 'tool_call'::text, 'tool_result'::text, 'error'::text, 'performance'::text])),
  level text NOT NULL DEFAULT 'info' CHECK (level = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text, 'critical'::text])),
  message text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  step_id text,
  tool_name text,
  tool_call_id text,
  tool_args jsonb DEFAULT '{}'::jsonb,
  tool_result jsonb DEFAULT '{}'::jsonb,
  is_error boolean DEFAULT false,
  duration_ms integer,
  tokens_used jsonb DEFAULT '{}'::jsonb,
  screenshot_base64 text,
  artifacts jsonb DEFAULT '[]'::jsonb,
  instance_id uuid NOT NULL,
  site_id uuid NOT NULL,
  user_id uuid,
  agent_id uuid,
  command_id uuid,
  parent_log_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT instance_logs_pkey PRIMARY KEY (id),
  CONSTRAINT instance_logs_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  CONSTRAINT instance_logs_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT instance_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT instance_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL,
  CONSTRAINT fk_command_instance_logs FOREIGN KEY (command_id) REFERENCES public.commands(id) ON DELETE SET NULL,
  CONSTRAINT instance_logs_parent_log_id_fkey FOREIGN KEY (parent_log_id) REFERENCES public.instance_logs(id) ON DELETE SET NULL
);
-- Objectives, tasks, and verification steps for instance execution
CREATE TABLE public.instance_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  plan_type text NOT NULL CHECK (plan_type = ANY (ARRAY['objective'::text, 'task'::text, 'verification'::text, 'milestone'::text])),
  priority integer DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'blocked'::text])),
  instructions text,
  expected_output text,
  success_criteria jsonb DEFAULT '[]'::jsonb,
  validation_rules jsonb DEFAULT '[]'::jsonb,
  tools_required jsonb DEFAULT '[]'::jsonb,
  estimated_duration_minutes integer,
  actual_duration_minutes integer,
  retry_count integer DEFAULT 0,
  max_retries integer DEFAULT 3,
  steps jsonb DEFAULT '[]'::jsonb, -- Array of step objects with id, title, description, status
  artifacts jsonb DEFAULT '[]'::jsonb,
  error_message text,
  progress_percentage integer DEFAULT 0 CHECK (progress_percentage >= 0 AND progress_percentage <= 100),
  steps_completed integer DEFAULT 0,
  steps_total integer DEFAULT 1,
  instance_id uuid NOT NULL,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent_id uuid,
  command_id uuid,
  parent_plan_id uuid,
  depends_on jsonb DEFAULT '[]'::jsonb,
  blocks jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  due_at timestamp with time zone,
  CONSTRAINT instance_plans_pkey PRIMARY KEY (id),
  CONSTRAINT instance_plans_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  CONSTRAINT instance_plans_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT instance_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT instance_plans_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL,
  CONSTRAINT fk_command_instance_plans FOREIGN KEY (command_id) REFERENCES public.commands(id) ON DELETE SET NULL,
  CONSTRAINT instance_plans_parent_plan_id_fkey FOREIGN KEY (parent_plan_id) REFERENCES public.instance_plans(id) ON DELETE CASCADE
);

| object_type | object_name                                      | table_name            |
| ----------- | ------------------------------------------------ | --------------------- |
| FUNCTION    | activate_pending_site_memberships                | PLPGSQL               |
| FUNCTION    | add_to_waitlist                                  | PLPGSQL               |
| FUNCTION    | calculate_kpis_from_events                       | PLPGSQL               |
| FUNCTION    | check_referral_system_status                     | PLPGSQL               |
| FUNCTION    | decrypt_token                                    | PLPGSQL               |
| FUNCTION    | delete_command_cascade                           | PLPGSQL               |
| FUNCTION    | delete_command_simple                            | PLPGSQL               |
| FUNCTION    | delete_secure_token                              | PLPGSQL               |
| FUNCTION    | delete_site_safely                               | PLPGSQL               |
| FUNCTION    | encrypt_token                                    | PLPGSQL               |
| FUNCTION    | expire_old_api_keys                              | PLPGSQL               |
| FUNCTION    | generate_task_serial_id                          | PLPGSQL               |
| FUNCTION    | get_auth_user_id                                 | PLPGSQL               |
| FUNCTION    | get_performance_status                           | PLPGSQL               |
| FUNCTION    | get_secure_token                                 | PLPGSQL               |
| FUNCTION    | get_user_profile_complete                        | PLPGSQL               |
| FUNCTION    | gin_extract_query_trgm                           | C                     |
| FUNCTION    | gin_extract_value_trgm                           | C                     |
| FUNCTION    | gin_trgm_consistent                              | C                     |
| FUNCTION    | gin_trgm_triconsistent                           | C                     |
| FUNCTION    | gtrgm_compress                                   | C                     |
| FUNCTION    | gtrgm_consistent                                 | C                     |
| FUNCTION    | gtrgm_decompress                                 | C                     |
| FUNCTION    | gtrgm_distance                                   | C                     |
| FUNCTION    | gtrgm_in                                         | C                     |
| FUNCTION    | gtrgm_options                                    | C                     |
| FUNCTION    | gtrgm_out                                        | C                     |
| FUNCTION    | gtrgm_penalty                                    | C                     |
| FUNCTION    | gtrgm_picksplit                                  | C                     |
| FUNCTION    | gtrgm_same                                       | C                     |
| FUNCTION    | gtrgm_union                                      | C                     |
| FUNCTION    | handle_command_insert                            | PLPGSQL               |
| FUNCTION    | handle_command_update                            | PLPGSQL               |
| FUNCTION    | handle_event_insert                              | PLPGSQL               |
| FUNCTION    | handle_new_user                                  | PLPGSQL               |
| FUNCTION    | handle_new_user_debug                            | PLPGSQL               |
| FUNCTION    | handle_new_user_simple                           | PLPGSQL               |
| FUNCTION    | handle_session_active_state                      | PLPGSQL               |
| FUNCTION    | handle_session_events_updated_at                 | PLPGSQL               |
| FUNCTION    | handle_updated_at                                | PLPGSQL               |
| FUNCTION    | increment_agent_conversations                    | PLPGSQL               |
| FUNCTION    | increment_template_usage                         | PLPGSQL               |
| FUNCTION    | increment_referral_code_usage                    | PLPGSQL               |
| FUNCTION    | is_superadmin                                    | PLPGSQL               |
| FUNCTION    | log_asset_insert                                 | PLPGSQL               |
| FUNCTION    | log_debug                                        | PLPGSQL               |
| FUNCTION    | manually_activate_user_memberships               | PLPGSQL               |
| FUNCTION    | migrate_team_members_to_site_members             | PLPGSQL               |
| FUNCTION    | prevent_last_admin_deletion                      | PLPGSQL               |
| FUNCTION    | prevent_last_admin_role_change                   | PLPGSQL               |
| FUNCTION    | process_referral_code_use                        | PLPGSQL               |
| FUNCTION    | record_payment                                   | PLPGSQL               |
| FUNCTION    | register_referral_code_use                       | PLPGSQL               |
| FUNCTION    | reorder_task_priorities                          | PLPGSQL               |
| FUNCTION    | set_current_timestamp_updated_at                 | PLPGSQL               |
| FUNCTION    | set_dislike                                      | PLPGSQL               |
| FUNCTION    | set_like                                         | PLPGSQL               |
| FUNCTION    | set_limit                                        | C                     |
| FUNCTION    | set_task_priority_from_serial                    | PLPGSQL               |
| FUNCTION    | set_task_serial_id                               | PLPGSQL               |
| FUNCTION    | show_limit                                       | C                     |
| FUNCTION    | show_trgm                                        | C                     |
| FUNCTION    | similarity                                       | C                     |
| FUNCTION    | similarity_dist                                  | C                     |
| FUNCTION    | similarity_op                                    | C                     |
| FUNCTION    | simulate_user_creation                           | PLPGSQL               |
| FUNCTION    | store_secure_token                               | PLPGSQL               |
| FUNCTION    | strict_word_similarity                           | C                     |
| FUNCTION    | strict_word_similarity_commutator_op             | C                     |
| FUNCTION    | strict_word_similarity_dist_commutator_op        | C                     |
| FUNCTION    | strict_word_similarity_dist_op                   | C                     |
| FUNCTION    | strict_word_similarity_op                        | C                     |
| FUNCTION    | sync_auth0_user                                  | PLPGSQL               |
| FUNCTION    | sync_site_members_to_settings                    | PLPGSQL               |
| FUNCTION    | sync_site_members_to_team_members                | PLPGSQL               |
| FUNCTION    | sync_site_ownership                              | PLPGSQL               |
| FUNCTION    | toggle_flag                                      | PLPGSQL               |
| FUNCTION    | update_api_key_last_used                         | PLPGSQL               |
| FUNCTION    | update_conversation_last_message_time            | PLPGSQL               |
| FUNCTION    | update_cron_status_updated_at                    | PLPGSQL               |
| FUNCTION    | update_sale_orders_updated_at                    | PLPGSQL               |
| FUNCTION    | update_timestamp                                 | PLPGSQL               |
| FUNCTION    | update_updated_at_column                         | PLPGSQL               |
| FUNCTION    | update_whatsapp_templates_updated_at             | PLPGSQL               |
| FUNCTION    | user_has_access_to_site                          | PLPGSQL               |
| FUNCTION    | validate_notifications                           | PLPGSQL               |
| FUNCTION    | validate_performance_bitmask                     | PLPGSQL               |
| FUNCTION    | validate_referral_code                           | PLPGSQL               |
| FUNCTION    | word_similarity                                  | C                     |
| FUNCTION    | word_similarity_commutator_op                    | C                     |
| FUNCTION    | word_similarity_dist_commutator_op               | C                     |
| FUNCTION    | word_similarity_dist_op                          | C                     |
| FUNCTION    | word_similarity_op                               | C                     |
| INDEX       | agent_assets_pkey                                | agent_assets          |
| INDEX       | agent_memories_agent_id_user_id_key_key          | agent_memories        |
| INDEX       | agent_memories_pkey                              | agent_memories        |
| INDEX       | agents_pkey                                      | agents                |
| INDEX       | allowed_domains_pkey                             | allowed_domains       |
| INDEX       | analysis_created_at_idx                          | analysis              |
| INDEX       | analysis_pkey                                    | analysis              |
| INDEX       | analysis_site_id_idx                             | analysis              |
| INDEX       | analysis_url_path_idx                            | analysis              |
| INDEX       | analysis_user_id_idx                             | analysis              |
| INDEX       | api_keys_pkey                                    | api_keys              |
| INDEX       | assets_pkey                                      | assets                |
| INDEX       | billing_pkey                                     | billing               |
| INDEX       | campaign_requirements_pkey                       | campaign_requirements |
| INDEX       | campaign_segments_pkey                           | campaign_segments     |
| INDEX       | campaign_subtasks_pkey                           | campaign_subtasks     |
| INDEX       | campaigns_pkey                                   | campaigns             |
| INDEX       | categories_pkey                                  | categories            |
| INDEX       | commands_pkey                                    | commands              |
| INDEX       | companies_pkey                                   | companies             |
| INDEX       | content_pkey                                     | content               |
| INDEX       | conversations_pkey                               | conversations         |
| INDEX       | cron_status_pkey                                 | cron_status           |
| INDEX       | debug_logs_pkey                                  | debug_logs            |
| INDEX       | experiment_segments_experiment_id_segment_id_key | experiment_segments   |
| INDEX       | experiment_segments_pkey                         | experiment_segments   |
| INDEX       | experiments_pkey                                 | experiments           |
| INDEX       | external_resources_pkey                          | external_resources    |
| INDEX       | idx_agent_assets_agent_id                        | agent_assets          |
| INDEX       | idx_agent_assets_asset_id                        | agent_assets          |
| INDEX       | idx_agent_assets_command_id                      | agent_assets          |
| INDEX       | idx_agent_memories_command_id                    | agent_memories        |
| INDEX       | idx_agents_command_id                            | agents                |
| INDEX       | idx_agents_site_id                               | agents                |
| INDEX       | idx_agents_status                                | agents                |
| INDEX       | idx_agents_type                                  | agents                |
| INDEX       | idx_analysis_command_id                          | analysis              |
| INDEX       | idx_api_keys_key_hash                            | api_keys              |
| INDEX       | idx_api_keys_prefix                              | api_keys              |
| INDEX       | idx_api_keys_site_id                             | api_keys              |
| INDEX       | idx_api_keys_status                              | api_keys              |
| INDEX       | idx_api_keys_user_id                             | api_keys              |
| INDEX       | idx_assets_command_id                            | assets                |
| INDEX       | idx_assets_file_type                             | assets                |
| INDEX       | idx_assets_name                                  | assets                |
| INDEX       | idx_assets_site_id                               | assets                |
| INDEX       | idx_assets_user_id                               | assets                |
| INDEX       | idx_billing_command_id                           | billing               |
| INDEX       | idx_billing_site_id                              | billing               |
| INDEX       | idx_campaign_requirements_campaign_id            | campaign_requirements |
| INDEX       | idx_campaign_requirements_command_id             | campaign_requirements |
| INDEX       | idx_campaign_requirements_requirement_id         | campaign_requirements |
| INDEX       | idx_campaign_segments_command_id                 | campaign_segments     |
| INDEX       | idx_campaign_subtasks_campaign_id                | campaign_subtasks     |
| INDEX       | idx_campaign_subtasks_command_id                 | campaign_subtasks     |
| INDEX       | idx_campaign_subtasks_status                     | campaign_subtasks     |
| INDEX       | idx_campaigns_command_id                         | campaigns             |
| INDEX       | idx_campaigns_priority                           | campaigns             |
| INDEX       | idx_campaigns_site_id                            | campaigns             |
| INDEX       | idx_campaigns_status                             | campaigns             |
| INDEX       | idx_campaigns_type                               | campaigns             |
| INDEX       | idx_categories_is_active                         | categories            |
| INDEX       | idx_categories_name                              | categories            |
| INDEX       | idx_categories_site_id                           | categories            |
| INDEX       | idx_categories_user_id                           | categories            |
| INDEX       | idx_commands_agent_id                            | commands              |
| INDEX       | idx_commands_created_at                          | commands              |
| INDEX       | idx_commands_performance                         | commands              |
| INDEX       | idx_commands_status                              | commands              |
| INDEX       | idx_commands_user_id                             | commands              |
| INDEX       | idx_companies_acquired_by_id                     | companies             |
| INDEX       | idx_companies_business_model                     | companies             |
| INDEX       | idx_companies_employees_count                    | companies             |
| INDEX       | idx_companies_industry                           | companies             |
| INDEX       | idx_companies_ipo_date                           | companies             |
| INDEX       | idx_companies_is_public                          | companies             |
| INDEX       | idx_companies_last_funding_date                  | companies             |
| INDEX       | idx_companies_legal_structure                    | companies             |
| INDEX       | idx_companies_name                               | companies             |
| INDEX       | idx_companies_parent_company_id                  | companies             |
| INDEX       | idx_companies_registration_number                | companies             |
| INDEX       | idx_companies_remote_policy                      | companies             |
| INDEX       | idx_companies_size                               | companies             |
| INDEX       | idx_companies_tax_country                        | companies             |
| INDEX       | idx_companies_tax_id                             | companies             |
| INDEX       | idx_companies_vat_number                         | companies             |
| INDEX       | idx_content_campaign_id                          | content               |
| INDEX       | idx_content_command_id                           | content               |
| INDEX       | idx_conversations_agent_id                       | conversations         |
| INDEX       | idx_conversations_command_id                     | conversations         |
| INDEX       | idx_conversations_last_message_at                | conversations         |
| INDEX       | idx_conversations_lead_id                        | conversations         |
| INDEX       | idx_conversations_site_id                        | conversations         |
| INDEX       | idx_conversations_status                         | conversations         |
| INDEX       | idx_conversations_user_id                        | conversations         |
| INDEX       | idx_conversations_visitor_id                     | conversations         |
| INDEX       | idx_cron_status_next_run                         | cron_status           |
| INDEX       | idx_cron_status_schedule_id                      | cron_status           |
| INDEX       | idx_cron_status_site_id                          | cron_status           |
| INDEX       | idx_cron_status_status                           | cron_status           |
| INDEX       | idx_cron_status_workflow_id                      | cron_status           |
| INDEX       | idx_debug_logs_command_id                        | debug_logs            |
| INDEX       | idx_experiment_segments_command_id               | experiment_segments   |
| INDEX       | idx_experiments_campaign_id                      | experiments           |
| INDEX       | idx_experiments_command_id                       | experiments           |
| INDEX       | idx_experiments_site_id                          | experiments           |
| INDEX       | idx_experiments_status                           | experiments           |
| INDEX       | idx_external_resources_command_id                | external_resources    |
| INDEX       | idx_external_resources_key                       | external_resources    |
| INDEX       | idx_external_resources_site_id                   | external_resources    |
| INDEX       | idx_external_resources_user_id                   | external_resources    |
| INDEX       | idx_kpis_command_id                              | kpis                  |
| INDEX       | idx_kpis_is_highlighted                          | kpis                  |
| INDEX       | idx_kpis_name                                    | kpis                  |
| INDEX       | idx_kpis_period_end                              | kpis                  |
| INDEX       | idx_kpis_site_id                                 | kpis                  |
| INDEX       | idx_kpis_type                                    | kpis                  |
| INDEX       | idx_leads_address                                | leads                 |
| INDEX       | idx_leads_command_id                             | leads                 |
| INDEX       | idx_leads_company                                | leads                 |
| INDEX       | idx_leads_company_id                             | leads                 |
| INDEX       | idx_leads_email                                  | leads                 |
| INDEX       | idx_leads_name                                   | leads                 |
| INDEX       | idx_leads_segment_id                             | leads                 |
| INDEX       | idx_leads_site_id                                | leads                 |
| INDEX       | idx_leads_social_networks                        | leads                 |
| INDEX       | idx_leads_status                                 | leads                 |
| INDEX       | idx_leads_subscription                           | leads                 |
| INDEX       | idx_memories_agent_id                            | agent_memories        |
| INDEX       | idx_memories_key                                 | agent_memories        |
| INDEX       | idx_memories_last_accessed                       | agent_memories        |
| INDEX       | idx_memories_raw_data                            | agent_memories        |
| INDEX       | idx_memories_type                                | agent_memories        |
| INDEX       | idx_memories_user_id                             | agent_memories        |
| INDEX       | idx_messages_agent_id                            | messages              |
| INDEX       | idx_messages_command_id                          | messages              |
| INDEX       | idx_messages_conversation_id                     | messages              |
| INDEX       | idx_messages_created_at                          | messages              |
| INDEX       | idx_messages_lead_id                             | messages              |
| INDEX       | idx_messages_role                                | messages              |
| INDEX       | idx_messages_user_id                             | messages              |
| INDEX       | idx_messages_visitor_id                          | messages              |
| INDEX       | idx_notifications_command_id                     | notifications         |
| INDEX       | idx_notifications_created_at                     | notifications         |
| INDEX       | idx_notifications_is_read                        | notifications         |
| INDEX       | idx_notifications_type                           | notifications         |
| INDEX       | idx_notifications_user_id                        | notifications         |
| INDEX       | idx_payments_command_id                          | payments              |
| INDEX       | idx_payments_created_at                          | payments              |
| INDEX       | idx_payments_site_id                             | payments              |
| INDEX       | idx_profiles_command_id                          | profiles              |
| INDEX       | idx_profiles_language                            | profiles              |
| INDEX       | idx_profiles_notifications                       | profiles              |
| INDEX       | idx_profiles_role                                | profiles              |
| INDEX       | idx_profiles_settings                            | profiles              |
| INDEX       | idx_profiles_timezone                            | profiles              |
| INDEX       | idx_referral_code_uses_code_id                   | referral_code_uses    |
| INDEX       | idx_referral_code_uses_user_id                   | referral_code_uses    |
| INDEX       | idx_referral_codes_code                          | referral_codes        |
| INDEX       | idx_referral_codes_expires_at                    | referral_codes        |
| INDEX       | idx_referral_codes_is_active                     | referral_codes        |
| INDEX       | idx_requirement_segments_command_id              | requirement_segments  |
| INDEX       | idx_requirements_command_id                      | requirements          |
| INDEX       | idx_requirements_priority                        | requirements          |
| INDEX       | idx_requirements_site_id                         | requirements          |
| INDEX       | idx_requirements_status                          | requirements          |
| INDEX       | idx_requirements_title                           | requirements          |
| INDEX       | idx_requirements_type                            | requirements          |
| INDEX       | idx_sale_orders_sale_id                          | sale_orders           |
| INDEX       | idx_sale_orders_site_id                          | sale_orders           |
| INDEX       | idx_sales_campaign_id                            | sales                 |
| INDEX       | idx_sales_command_id                             | sales                 |
| INDEX       | idx_sales_lead_id                                | sales                 |
| INDEX       | idx_sales_sale_date                              | sales                 |
| INDEX       | idx_sales_segment_id                             | sales                 |
| INDEX       | idx_sales_site_id                                | sales                 |
| INDEX       | idx_sales_status                                 | sales                 |
| INDEX       | idx_segments_command_id                          | segments              |
| INDEX       | idx_segments_name                                | segments              |
| INDEX       | idx_segments_site_id                             | segments              |
| INDEX       | idx_session_events_command_id                    | session_events        |
| INDEX       | idx_session_events_event_type                    | session_events        |
| INDEX       | idx_session_events_session_id                    | session_events        |
| INDEX       | idx_session_events_site_id                       | session_events        |
| INDEX       | idx_session_events_timestamp                     | session_events        |
| INDEX       | idx_session_events_visitor_id                    | session_events        |
| INDEX       | idx_settings_branding                            | settings              |
| INDEX       | idx_settings_command_id                          | settings              |
| INDEX       | idx_site_members_email                           | site_members          |
| INDEX       | idx_site_members_role                            | site_members          |
| INDEX       | idx_site_members_site_id                         | site_members          |
| INDEX       | idx_site_members_user_id                         | site_members          |
| INDEX       | idx_sites_command_id                             | sites                 |
| INDEX       | idx_synced_objects_external_id                   | synced_objects        |
| INDEX       | idx_synced_objects_site_id                       | synced_objects        |
| INDEX       | idx_synced_objects_object_type                   | synced_objects        |
| INDEX       | idx_synced_objects_status                        | synced_objects        |
| INDEX       | idx_synced_objects_provider                      | synced_objects        |
| INDEX       | idx_synced_objects_site_object_type              | synced_objects        |
| INDEX       | idx_synced_objects_site_status                   | synced_objects        |
| INDEX       | idx_synced_objects_external_site_type            | synced_objects        |
| INDEX       | idx_synced_objects_unique_external_site_type     | synced_objects        |
| INDEX       | synced_objects_pkey                              | synced_objects        |
| INDEX       | idx_task_categories_category_id                  | task_categories       |
| INDEX       | idx_task_categories_task_id                      | task_categories       |
| INDEX       | idx_task_comments_created_at                     | task_comments         |
| INDEX       | idx_task_comments_task_id                        | task_comments         |
| INDEX       | idx_task_comments_user_id                        | task_comments         |
| INDEX       | idx_tasks_address                                | tasks                 |
| INDEX       | idx_tasks_command_id                             | tasks                 |
| INDEX       | idx_tasks_conversation_id                        | tasks                 |
| INDEX       | idx_tasks_lead_id                                | tasks                 |
| INDEX       | idx_tasks_priority                               | tasks                 |
| INDEX       | idx_tasks_serial_id                              | tasks                 |
| INDEX       | idx_tasks_serial_id_site                         | tasks                 |
| INDEX       | idx_tasks_site_id                                | tasks                 |
| INDEX       | idx_tasks_site_status_priority                   | tasks                 |
| INDEX       | idx_tasks_stage                                  | tasks                 |
| INDEX       | idx_tasks_status                                 | tasks                 |
| INDEX       | idx_transactions_campaign_id                     | transactions          |
| INDEX       | idx_transactions_command_id                      | transactions          |
| INDEX       | idx_transactions_site_id                         | transactions          |
| INDEX       | idx_transactions_type                            | transactions          |
| INDEX       | idx_visitor_sessions_command_id                  | visitor_sessions      |
| INDEX       | idx_visitor_sessions_identified_at               | visitor_sessions      |
| INDEX       | idx_visitor_sessions_is_active                   | visitor_sessions      |
| INDEX       | idx_visitor_sessions_lead_id                     | visitor_sessions      |
| INDEX       | idx_visitor_sessions_site_id                     | visitor_sessions      |
| INDEX       | idx_visitor_sessions_visitor_id                  | visitor_sessions      |
| INDEX       | idx_visitors_command_id                          | visitors              |
| INDEX       | idx_visitors_device_id                           | visitors              |
| INDEX       | idx_visitors_is_identified                       | visitors              |
| INDEX       | idx_visitors_lead_id                             | visitors              |
| INDEX       | idx_waitlist_created_at                          | waitlist              |
| INDEX       | idx_waitlist_email                               | waitlist              |
| INDEX       | idx_waitlist_status                              | waitlist              |
| INDEX       | kpis_pkey                                        | kpis                  |
| INDEX       | leads_pkey                                       | leads                 |
| INDEX       | messages_pkey                                    | messages              |
| INDEX       | notifications_pkey                               | notifications         |
| INDEX       | payments_pkey                                    | payments              |
| INDEX       | profiles_pkey                                    | profiles              |
| INDEX       | referral_code_uses_pkey                          | referral_code_uses    |
| INDEX       | referral_code_uses_referral_code_id_user_id_key  | referral_code_uses    |
| INDEX       | referral_codes_code_key                          | referral_codes        |
| INDEX       | referral_codes_pkey                              | referral_codes        |
| INDEX       | requirement_segments_pkey                        | requirement_segments  |
| INDEX       | requirements_pkey                                | requirements          |
| INDEX       | sale_orders_pkey                                 | sale_orders           |
| INDEX       | sales_pkey                                       | sales                 |
| INDEX       | secure_tokens_pkey                               | secure_tokens         |
| INDEX       | secure_tokens_site_id_token_type_identifier_key  | secure_tokens         |
| INDEX       | segments_pkey                                    | segments              |
| INDEX       | segments_url_idx                                 | segments              |
| INDEX       | session_events_pkey                              | session_events        |
| INDEX       | settings_pkey                                    | settings              |
| INDEX       | settings_site_id_idx                             | settings              |
| INDEX       | settings_site_id_key                             | settings              |
| INDEX       | site_members_pkey                                | site_members          |
| INDEX       | site_members_site_id_email_key                   | site_members          |
| INDEX       | site_members_site_id_user_id_key                 | site_members          |
| INDEX       | site_ownership_pkey                              | site_ownership        |
| INDEX       | sites_pkey                                       | sites                 |
| INDEX       | task_categories_pkey                             | task_categories       |
| INDEX       | task_comments_pkey                               | task_comments         |
| INDEX       | tasks_pkey                                       | tasks                 |
| INDEX       | transactions_pkey                                | transactions          |
| INDEX       | unique_domain_per_site                           | allowed_domains       |
| INDEX       | visitor_sessions_pkey                            | visitor_sessions      |
| INDEX       | visitors_pkey                                    | visitors              |
| INDEX       | waitlist_email_key                               | waitlist              |
| INDEX       | waitlist_pkey                                    | waitlist              |
| INDEX       | idx_whatsapp_templates_account_sid               | whatsapp_templates    |
| INDEX       | idx_whatsapp_templates_created_at                | whatsapp_templates    |
| INDEX       | idx_whatsapp_templates_last_used                 | whatsapp_templates    |
| INDEX       | idx_whatsapp_templates_site_id                   | whatsapp_templates    |
| INDEX       | idx_whatsapp_templates_status                    | whatsapp_templates    |
| INDEX       | whatsapp_templates_pkey                          | whatsapp_templates    |
| INDEX       | whatsapp_templates_unique_name_site              | whatsapp_templates    |
| INDEX       | whatsapp_templates_unique_sid                    | whatsapp_templates    |
| TRIGGER     | activate_pending_memberships_trigger             | profiles              |
| TRIGGER     | billing_timestamp_trigger                        | billing               |
| TRIGGER     | campaign_cascade_delete_trigger                  | campaigns             |
| TRIGGER     | check_expired_api_keys                           | api_keys              |
| TRIGGER     | check_expired_api_keys                           | api_keys              |
| TRIGGER     | log_asset_insert_trigger                         | assets                |
| TRIGGER     | on_command_insert                                | commands              |
| TRIGGER     | on_command_update                                | commands              |
| TRIGGER     | on_event_insert                                  | session_events        |
| TRIGGER     | on_message_insert                                | messages              |
| TRIGGER     | payments_timestamp_trigger                       | payments              |
| TRIGGER     | prevent_last_admin_deletion_trigger              | site_members          |
| TRIGGER     | prevent_last_admin_role_change_trigger           | site_members          |
| TRIGGER     | session_events_updated_at_trigger                | session_events        |
| TRIGGER     | set_tasks_updated_at                             | tasks                 |
| TRIGGER     | set_updated_at                                   | analysis              |
| TRIGGER     | settings_updated_at                              | settings              |
| TRIGGER     | sync_members_to_settings                         | site_members          |
| TRIGGER     | sync_members_to_settings                         | site_members          |
| TRIGGER     | sync_members_to_settings                         | site_members          |
| TRIGGER     | sync_ownership_on_site_change                    | sites                 |
| TRIGGER     | sync_ownership_on_site_change                    | sites                 |
| TRIGGER     | sync_ownership_on_site_change                    | sites                 |
| TRIGGER     | sync_site_members_trigger                        | site_members          |
| TRIGGER     | sync_site_members_trigger                        | site_members          |
| TRIGGER     | sync_site_members_trigger                        | site_members          |
| TRIGGER     | trigger_set_task_priority                        | tasks                 |
| TRIGGER     | trigger_set_task_serial_id                       | tasks                 |
| TRIGGER     | trigger_update_cron_status_updated_at            | cron_status           |
| TRIGGER     | trigger_update_sale_orders_updated_at            | sale_orders           |
| TRIGGER     | trigger_update_synced_objects_updated_at         | synced_objects        |
| TRIGGER     | trigger_update_whatsapp_templates_updated_at     | whatsapp_templates    |
| TRIGGER     | update_api_key_usage                             | api_keys              |
| TRIGGER     | update_api_keys_updated_at                       | api_keys              |
| TRIGGER     | update_companies_updated_at                      | companies             |
| TRIGGER     | update_referral_codes_updated_at                 | referral_codes        |
| TRIGGER     | update_waitlist_updated_at                       | waitlist              |
| TRIGGER     | validate_performance_bitmask_trigger             | commands              |
| TRIGGER     | validate_performance_bitmask_trigger             | commands              |

## Webhooks

Market Fit supports site-scoped outbound webhooks so external services can receive real-time events.

### Tables

- webhooks_endpoints
  - id (uuid, pk)
  - site_id (uuid → sites.id)
  - created_by (uuid → profiles.id)
  - name (text, unique per site)
  - description (text)
  - target_url (text)
  - secret (text)
  - is_active (boolean)
  - handshake_status (text: pending | verified | failed | none)
  - handshake_token (text)
  - handshake_verified_at (timestamptz)
  - last_handshake_error (text)
  - created_at / updated_at

- webhooks_subscriptions
  - id (uuid, pk)
  - site_id (uuid → sites.id)
  - endpoint_id (uuid → webhooks_endpoints.id)
  - event_type (text)
  - is_active (boolean)
  - filters (jsonb)
  - created_at / updated_at
  - Unique: (endpoint_id, event_type)

- webhooks_deliveries
  - id (uuid, pk)
  - site_id (uuid → sites.id)
  - endpoint_id (uuid → webhooks_endpoints.id)
  - subscription_id (uuid → webhooks_subscriptions.id, nullable)
  - event_type (text)
  - payload (jsonb)
  - status (text: pending | delivered | failed | retrying)
  - attempt_count (int)
  - last_attempt_at (timestamptz)
  - response_status (int)
  - response_body (text)
  - last_error (text)
  - delivered_at (timestamptz)
  - created_at / updated_at

### Indexes

- Endpoints: site_id, (site_id, is_active)
- Subscriptions: site_id, endpoint_id, event_type
- Deliveries: site_id, endpoint_id, status, event_type, created_at

### RLS

Unified RLS per table using site-scoped access:

- A user can access rows if they are:
  - a site owner via `site_ownership`, or
  - an active member via `site_members` (status = 'active').
- Policies use `(select auth.uid())` to avoid initplan overhead.

### Event Types (initial)

- task.created
- task.updated
- message.created

You can subscribe an endpoint to any of these. Deliveries are recorded in `webhooks_deliveries` and should be sent by a background worker or scheduled job.

## System: Finder Queries and Persons

### Tables

- role_queries (system)
  - id (uuid, pk)
  - query (jsonb, required)
  - query_hash (text, generated: sha256 of query::text, unique)
  - synced_pages (int, default 0)
  - total_persons (int, nullable)
  - total_organizations (int, nullable)
  - total_search_results (int, nullable)
  - status (text: pending | running | completed | failed, default pending)
  - last_run_at (timestamptz, nullable)
  - created_at / updated_at
  - Unique: (query_hash)
  - Indexes: created_at, status, GIN(query)

- role_query_segments (bridge)
  - id (uuid, pk)
  - role_query_id (uuid → role_queries.id on delete cascade)
  - segment_id (uuid → segments.id on delete cascade)
  - created_at
  - Unique: (role_query_id, segment_id)
  - Indexes: role_query_id, segment_id

- persons (system)
  - id (uuid, pk)
  - role_query_id (uuid → role_queries.id on delete set null)
  - external_person_id (bigint, nullable)
  - external_role_id (bigint, nullable)
  - external_organization_id (bigint, nullable)
  - full_name (text)
  - role_title (text)
  - company_name (text)
  - start_date (date)
  - end_date (date)
  - is_current (boolean)
  - location (text)
  - emails (jsonb)
  - phones (jsonb)
  - personal_emails (jsonb, array)
  - linkedin_profile (text, URL)
  - raw_result (jsonb, required)
  - created_at / updated_at
  - Unique: (external_person_id, external_role_id)
  - Indexes: role_query_id, full_name, company_name, role_title, is_current, GIN(raw_result)

### Notes

- query_hash permite upserts/dedupe rápidos: `on conflict (query_hash)`.
- role_query_segments permite asociar el mismo query a múltiples `segments` (1→N).
- persons almacena el snapshot crudo del API en `raw_result` y campos denormalizados para listados.

## System: ICP Mining

### Tables

- icp_mining (system)
  - id (uuid, pk)
  - name (text)
  - role_query_id (uuid → role_queries.id on delete cascade)
  - icp_criteria (jsonb, required)
  - icp_hash (text, generated: sha256 of icp_criteria::text)
  - status (text: pending | running | completed | failed, default pending)
  - total_targets (int, default 0)
  - processed_targets (int, default 0)
  - found_matches (int, default 0)
  - progress_percent (numeric(5,2), generated)
  - started_at / last_progress_at / finished_at (timestamptz)
  - last_error (text)
  - errors (jsonb, default [])
  - created_at / updated_at
  - Indexes: role_query_id, status, created_at, last_progress_at, GIN(icp_criteria)
  - Partial Unique: (role_query_id, icp_hash) where status in ('pending','running')

### SQL

```sql
-- Dependencies
create extension if not exists pgcrypto;

-- Helper for updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Table: icp_mining
create table if not exists public.icp_mining (
  id uuid primary key default gen_random_uuid(),

  name text,

  role_query_id uuid not null
    references public.role_queries(id)
    on delete cascade,

  icp_criteria jsonb not null,

  icp_hash text
    generated always as (encode(digest(icp_criteria::text, 'sha256'), 'hex')) stored,

  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),

  total_targets integer default 0 check (total_targets >= 0),
  processed_targets integer default 0 check (processed_targets >= 0),
  found_matches integer default 0 check (found_matches >= 0),

  progress_percent numeric(5,2)
    generated always as (
      case
        when total_targets > 0
          then round(100.0 * processed_targets::numeric / total_targets::numeric, 2)
        when status = 'completed'
          then 100.00
        else 0.00
      end
    ) stored,

  started_at timestamptz,
  last_progress_at timestamptz,
  finished_at timestamptz,

  last_error text,
  errors jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trigger for updated_at
drop trigger if exists trg_icp_mining_set_updated_at on public.icp_mining;
create trigger trg_icp_mining_set_updated_at
before update on public.icp_mining
for each row execute function public.set_updated_at();

-- Indexes
create index if not exists idx_icp_mining_role_query_id on public.icp_mining (role_query_id);
create index if not exists idx_icp_mining_status on public.icp_mining (status);
create index if not exists idx_icp_mining_created_at on public.icp_mining (created_at);
create index if not exists idx_icp_mining_last_progress_at on public.icp_mining (last_progress_at);
create index if not exists idx_icp_mining_icp_criteria_gin on public.icp_mining using gin (icp_criteria);

-- Enforce no duplicate active runs per role_query + ICP
drop index if exists uq_icp_mining_active_unique;
create unique index uq_icp_mining_active_unique
  on public.icp_mining (role_query_id, icp_hash)
  where status in ('pending','running');

-- RLS
alter table public.icp_mining enable row level security;

-- Clean up if re-running
drop policy if exists "icp_mining - anon can read completed" on public.icp_mining;
drop policy if exists "icp_mining - service_role can do anything" on public.icp_mining;

-- Public read access for completed runs
create policy "icp_mining - anon can read completed"
on public.icp_mining
as permissive
for select
to anon
using (status = 'completed');

-- Full access for service_role
create policy "icp_mining - service_role can do anything"
on public.icp_mining
as permissive
for all
to service_role
using (true)
with check (true);
```

### Notes

- `icp_hash` evita minados simultáneos duplicados por `role_query_id` + ICP.
- `progress_percent` refleja avance con base en `processed_targets / total_targets`.
- `anon` puede leer únicamente corridas completadas; `service_role` tiene acceso total.