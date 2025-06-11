Latesst consolidated version and scheme of the database

[
  {
    "diagram": "┌─ agent_assets (4 columns) ─┐",
    "column_details": "│ Columns: agent_id (uuid), asset_id (uuid), created_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: asset_id -> assets.id, agent_id -> agents.id, command_id -> commands.id",
    "bottom_border": "└────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ agent_memories (14 columns) ─┐",
    "column_details": "│ Columns: id (uuid), agent_id (uuid), user_id (uuid), type (text), key (text), data (jsonb), raw_data (text), metadata (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), access_count (integer), last_accessed (timestamp with time zone), command_id (uuid), chain_of_thoughts (text)",
    "relationships": "│ Relations: command_id -> commands.id",
    "bottom_border": "└──────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ agents (21 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), description (text), type (text), status (text), prompt (text), conversations (integer), success_rate (integer), configuration (jsonb), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), last_active (timestamp with time zone), role (text), tools (jsonb), activities (jsonb), integrations (jsonb), supervisor (uuid), backstory (text), command_id (uuid)",
    "relationships": "│ Relations: supervisor -> agents.id, command_id -> commands.id, user_id -> users.id, site_id -> sites.id",
    "bottom_border": "└──────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ allowed_domains (5 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), domain (text), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: site_id -> sites.id",
    "bottom_border": "└───────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ analysis (12 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), url_path (text), structure (jsonb), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), status (text), request_time (integer), provider (text), model_id (text), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, user_id -> users.id, site_id -> sites.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ api_keys (13 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (character varying), key_hash (text), prefix (character varying), user_id (uuid), site_id (uuid), status (USER-DEFINED), scopes (ARRAY), last_used_at (timestamp with time zone), expires_at (timestamp with time zone), created_at (timestamp with time zone), updated_at (timestamp with time zone), metadata (jsonb)",
    "relationships": "│ Relations: user_id -> users.id, site_id -> sites.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ assets (13 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), description (text), file_path (text), file_type (text), file_size (integer), metadata (jsonb), is_public (boolean), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: site_id -> sites.id, command_id -> commands.id, user_id -> users.id",
    "bottom_border": "└──────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ billing (26 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), plan (character varying), card_name (character varying), masked_card_number (character varying), card_expiry (character varying), stripe_customer_id (character varying), stripe_payment_method_id (character varying), card_address (character varying), card_city (character varying), card_postal_code (character varying), card_country (character varying), tax_id (character varying), billing_address (character varying), billing_city (character varying), billing_postal_code (character varying), billing_country (character varying), auto_renew (boolean), credits_available (integer), credits_used (integer), subscription_start_date (timestamp with time zone), subscription_end_date (timestamp with time zone), status (character varying), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, site_id -> sites.id",
    "bottom_border": "└───────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ campaign_requirements (3 columns) ─┐",
    "column_details": "│ Columns: campaign_id (uuid), requirement_id (uuid), command_id (uuid)",
    "relationships": "│ Relations: requirement_id -> requirements.id, command_id -> commands.id, campaign_id -> campaigns.id",
    "bottom_border": "└─────────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ campaign_segments (3 columns) ─┐",
    "column_details": "│ Columns: campaign_id (uuid), segment_id (uuid), command_id (uuid)",
    "relationships": "│ Relations: segment_id -> segments.id, campaign_id -> campaigns.id, command_id -> commands.id",
    "bottom_border": "└─────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ campaign_subtasks (7 columns) ─┐",
    "column_details": "│ Columns: id (uuid), campaign_id (uuid), title (text), status (text), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, campaign_id -> campaigns.id",
    "bottom_border": "└─────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ campaigns (16 columns) ─┐",
    "column_details": "│ Columns: id (uuid), title (text), description (text), priority (USER-DEFINED), status (USER-DEFINED), due_date (date), assignees (integer), issues (integer), revenue (jsonb), budget (jsonb), type (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, site_id -> sites.id, user_id -> users.id",
    "bottom_border": "└─────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ categories (10 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), description (text), icon (text), color (text), is_active (boolean), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: user_id -> users.id, site_id -> sites.id",
    "bottom_border": "└──────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ commands (22 columns) ─┐",
    "column_details": "│ Columns: id (uuid), task (text), status (USER-DEFINED), description (text), results (jsonb), targets (jsonb), tools (jsonb), context (text), supervisor (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), completion_date (timestamp with time zone), duration (integer), model (text), agent_id (uuid), user_id (uuid), output_tokens (numeric), input_tokens (numeric), site_id (uuid), agent_background (text), functions (jsonb), performance (integer)",
    "relationships": "│ Relations: agent_id -> agents.id, site_id -> sites.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ content (21 columns) ─┐",
    "column_details": "│ Columns: id (uuid), title (text), description (text), type (text), status (text), segment_id (uuid), site_id (uuid), author_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), published_at (timestamp with time zone), tags (ARRAY), estimated_reading_time (integer), word_count (integer), seo_score (integer), user_id (uuid), text (text), campaign_id (uuid), performance_rating (smallint), metadata (jsonb), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, segment_id -> segments.id, author_id -> users.id, site_id -> sites.id, campaign_id -> campaigns.id, user_id -> users.id",
    "bottom_border": "└───────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ conversations (16 columns) ─┐",
    "column_details": "│ Columns: id (uuid), visitor_id (uuid), agent_id (uuid), user_id (uuid), lead_id (uuid), site_id (uuid), status (text), title (text), custom_data (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), last_message_at (timestamp with time zone), is_archived (boolean), command_id (uuid), flag (integer), delegate_id (uuid)",
    "relationships": "│ Relations: lead_id -> leads.id, site_id -> sites.id, agent_id -> agents.id, delegate_id -> agents.id, visitor_id -> visitors.id, visitor_id -> visitors.id, lead_id -> leads.id, lead_id -> leads.id, visitor_id -> visitors.id, visitor_id -> visitors.id, command_id -> commands.id, lead_id -> leads.id",
    "bottom_border": "└─────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ cron_status (12 columns) ─┐",
    "column_details": "│ Columns: id (uuid), workflow_id (text), schedule_id (text), activity_name (text), status (text), last_run (timestamp with time zone), next_run (timestamp with time zone), error_message (text), retry_count (integer), site_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: site_id -> sites.id",
    "bottom_border": "└─────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ debug_logs (7 columns) ─┐",
    "column_details": "│ Columns: id (uuid), operation (text), user_id (uuid), site_id (uuid), details (jsonb), created_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id",
    "bottom_border": "└──────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ experiment_segments (5 columns) ─┐",
    "column_details": "│ Columns: id (uuid), experiment_id (uuid), segment_id (uuid), participants (integer), command_id (uuid)",
    "relationships": "│ Relations: segment_id -> segments.id, command_id -> commands.id, experiment_id -> experiments.id",
    "bottom_border": "└───────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ experiments (18 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), description (text), status (text), start_date (timestamp with time zone), end_date (timestamp with time zone), conversion (numeric), roi (numeric), preview_url (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), hypothesis (text), campaign_id (uuid), command_id (uuid), instructions (text), validations (text)",
    "relationships": "│ Relations: site_id -> sites.id, campaign_id -> campaigns.id, command_id -> commands.id, user_id -> users.id",
    "bottom_border": "└───────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ external_resources (9 columns) ─┐",
    "column_details": "│ Columns: id (uuid), key (text), url (text), description (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: user_id -> users.id, site_id -> sites.id, command_id -> commands.id",
    "bottom_border": "└──────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ kpis (20 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), description (text), value (numeric), previous_value (numeric), unit (text), type (text), period_start (timestamp with time zone), period_end (timestamp with time zone), segment_id (uuid), is_highlighted (boolean), target_value (numeric), metadata (jsonb), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), trend (numeric), benchmark (numeric), command_id (uuid)",
    "relationships": "│ Relations: site_id -> sites.id, command_id -> commands.id, segment_id -> segments.id, user_id -> users.id",
    "bottom_border": "└────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ leads (22 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), email (text), position (text), segment_id (uuid), status (text), notes (text), last_contact (timestamp with time zone), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), phone (text), origin (text), social_networks (jsonb), address (jsonb), company (jsonb), subscription (jsonb), birthday (text), campaign_id (uuid), command_id (uuid), language (text)",
    "relationships": "│ Relations: command_id -> commands.id, user_id -> users.id, campaign_id -> campaigns.id, segment_id -> segments.id, site_id -> sites.id",
    "bottom_border": "└─────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ messages (21 columns) ─┐",
    "column_details": "│ Columns: id (uuid), conversation_id (uuid), visitor_id (uuid), topic (text), extension (text), agent_id (uuid), user_id (uuid), payload (jsonb), event (text), lead_id (uuid), content (text), private (boolean), updated_at (timestamp without time zone), role (text), inserted_at (timestamp without time zone), read_at (timestamp with time zone), custom_data (jsonb), id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: visitor_id -> visitors.id, visitor_id -> visitors.id, lead_id -> leads.id, lead_id -> leads.id, visitor_id -> visitors.id, conversation_id -> conversations.id, lead_id -> leads.id, command_id -> commands.id, lead_id -> leads.id, visitor_id -> visitors.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ notifications (15 columns) ─┐",
    "column_details": "│ Columns: id (uuid), title (text), message (text), type (text), is_read (boolean), action_url (text), related_entity_type (text), related_entity_id (uuid), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), event_type (text), severity (integer), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, site_id -> sites.id, user_id -> users.id",
    "bottom_border": "└─────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ payments (14 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), transaction_id (character varying), transaction_type (character varying), amount (numeric), currency (character varying), status (character varying), payment_method (character varying), details (jsonb), credits (integer), invoice_url (character varying), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid)",
    "relationships": "│ Relations: site_id -> sites.id, command_id -> commands.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ profiles (13 columns) ─┐",
    "column_details": "│ Columns: id (uuid), email (text), name (text), avatar_url (text), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid), bio (text), role (text), language (text), timezone (text), notifications (jsonb), settings (jsonb)",
    "relationships": "│ Relations: command_id -> commands.id, id -> users.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ referral_code_uses (4 columns) ─┐",
    "column_details": "│ Columns: id (uuid), referral_code_id (uuid), user_id (uuid), used_at (timestamp with time zone)",
    "relationships": "│ Relations: user_id -> users.id, referral_code_id -> referral_codes.id",
    "bottom_border": "└──────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ referral_codes (10 columns) ─┐",
    "column_details": "│ Columns: id (uuid), code (text), description (text), is_active (boolean), max_uses (integer), current_uses (integer), expires_at (timestamp with time zone), created_by (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: created_by -> users.id",
    "bottom_border": "└──────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ requirement_segments (3 columns) ─┐",
    "column_details": "│ Columns: requirement_id (uuid), segment_id (uuid), command_id (uuid)",
    "relationships": "│ Relations: segment_id -> segments.id, requirement_id -> requirements.id, command_id -> commands.id",
    "bottom_border": "└────────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ requirements (14 columns) ─┐",
    "column_details": "│ Columns: id (uuid), title (text), description (text), priority (text), status (text), completion_status (text), source (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), budget (numeric), instructions (text), command_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, site_id -> sites.id, user_id -> users.id",
    "bottom_border": "└────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ sale_orders (14 columns) ─┐",
    "column_details": "│ Columns: id (uuid), sale_id (uuid), order_number (text), items (jsonb), subtotal (numeric), tax_total (numeric), discount_total (numeric), total (numeric), notes (text), status (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: sale_id -> sales.id, site_id -> sites.id",
    "bottom_border": "└───────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ sales (29 columns) ─┐",
    "column_details": "│ Columns: id (uuid), lead_id (uuid), campaign_id (uuid), segment_id (uuid), amount (numeric), currency (text), status (text), title (text), description (text), sale_date (date), payment_method (text), payment_details (jsonb), invoice_number (text), product_name (text), product_type (text), product_details (jsonb), reference_code (text), external_id (text), notes (text), tags (ARRAY), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid), channel (text), source (text), amount_due (numeric), payments (jsonb)",
    "relationships": "│ Relations: lead_id -> leads.id, command_id -> commands.id, user_id -> users.id, site_id -> sites.id, segment_id -> segments.id, campaign_id -> campaigns.id",
    "bottom_border": "└─────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ secure_tokens (8 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), token_type (text), encrypted_value (text), identifier (text), last_used (timestamp with time zone), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: site_id -> sites.id",
    "bottom_border": "└─────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ segments (19 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), description (text), audience (USER-DEFINED), size (numeric), engagement (integer), is_active (boolean), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), language (USER-DEFINED), url (text), analysis (jsonb), topics (jsonb), icp (jsonb), estimated_value (numeric), command_id (uuid), rules (jsonb)",
    "relationships": "│ Relations: site_id -> sites.id, command_id -> commands.id, user_id -> users.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ session_events (18 columns) ─┐",
    "column_details": "│ Columns: id (uuid), event_type (text), url (text), timestamp (bigint), data (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), site_id (text), visitor_id (uuid), referrer (text), user_agent (text), ip (text), event_name (text), properties (jsonb), session_id (uuid), activity (jsonb), command_id (uuid), segment_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, visitor_id -> visitors.id, session_id -> visitor_sessions.id, segment_id -> segments.id",
    "bottom_border": "└──────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ settings (25 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), about (text), company_size (text), industry (text), products (jsonb), services (jsonb), swot (jsonb), locations (jsonb), marketing_budget (jsonb), marketing_channels (jsonb), social_media (jsonb), analytics_provider (text), analytics_id (text), team_members (jsonb), team_roles (jsonb), org_structure (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid), competitors (jsonb), focus_mode (integer), goals (jsonb), channels (jsonb), business_hours (jsonb)",
    "relationships": "│ Relations: command_id -> commands.id, site_id -> sites.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ site_members (11 columns) ─┐",
    "column_details": "│ Columns: id (uuid), site_id (uuid), user_id (uuid), role (text), added_by (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), email (text), name (text), position (text), status (text)",
    "relationships": "│ Relations: site_id -> sites.id, user_id -> users.id, added_by -> users.id",
    "bottom_border": "└────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ site_ownership (3 columns) ─┐",
    "column_details": "│ Columns: site_id (uuid), user_id (uuid), created_at (timestamp with time zone)",
    "relationships": "│ Relations: site_id -> sites.id, user_id -> users.id",
    "bottom_border": "└──────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ sites (11 columns) ─┐",
    "column_details": "│ Columns: id (uuid), name (text), url (text), description (text), logo_url (text), resource_urls (jsonb), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), tracking (jsonb), command_id (uuid)",
    "relationships": "│ Relations: user_id -> users.id, command_id -> commands.id",
    "bottom_border": "└─────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ task_categories (2 columns) ─┐",
    "column_details": "│ Columns: task_id (uuid), category_id (uuid)",
    "relationships": "│ Relations: task_id -> tasks.id, category_id -> categories.id",
    "bottom_border": "└───────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ task_comments (9 columns) ─┐",
    "column_details": "│ Columns: id (uuid), task_id (uuid), user_id (uuid), content (text), attachments (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), is_private (boolean), files (jsonb)",
    "relationships": "│ Relations: task_id -> tasks.id, user_id -> users.id",
    "bottom_border": "└─────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ tasks (20 columns) ─┐",
    "column_details": "│ Columns: id (uuid), lead_id (uuid), title (text), description (text), type (text), stage (text), status (text), scheduled_date (timestamp with time zone), completed_date (timestamp with time zone), amount (numeric), assignee (uuid), notes (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid), serial_id (text), priority (integer), address (jsonb)",
    "relationships": "│ Relations: user_id -> users.id, command_id -> commands.id, site_id -> sites.id, assignee -> users.id, lead_id -> leads.id",
    "bottom_border": "└─────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ transactions (13 columns) ─┐",
    "column_details": "│ Columns: id (uuid), campaign_id (uuid), type (text), amount (numeric), description (text), date (date), currency (text), site_id (uuid), user_id (uuid), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid), category (text)",
    "relationships": "│ Relations: command_id -> commands.id, campaign_id -> campaigns.id, site_id -> sites.id, user_id -> users.id",
    "bottom_border": "└────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ visitor_sessions (33 columns) ─┐",
    "column_details": "│ Columns: id (uuid), visitor_id (uuid), site_id (uuid), landing_url (text), current_url (text), referrer (text), utm_source (text), utm_medium (text), utm_campaign (text), utm_term (text), utm_content (text), started_at (bigint), last_activity_at (bigint), page_views (integer), device (jsonb), browser (jsonb), location (jsonb), previous_session_id (uuid), performance (jsonb), consent (jsonb), is_active (boolean), duration (bigint), active_time (bigint), idle_time (bigint), lead_id (uuid), exit_url (text), exit_type (text), custom_data (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone), command_id (uuid), identified_at (bigint), lead_data (jsonb)",
    "relationships": "│ Relations: lead_id -> leads.id, visitor_id -> visitors.id, command_id -> commands.id",
    "bottom_border": "└────────────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ visitors (24 columns) ─┐",
    "column_details": "│ Columns: id (uuid), first_seen_at (bigint), last_seen_at (bigint), total_sessions (integer), total_page_views (integer), total_time_spent (bigint), first_url (text), first_referrer (text), first_utm_source (text), first_utm_medium (text), first_utm_campaign (text), first_utm_term (text), first_utm_content (text), device (jsonb), browser (jsonb), location (jsonb), custom_data (jsonb), lead_id (uuid), is_identified (boolean), created_at (timestamp with time zone), updated_at (timestamp with time zone), fingerprint (text), command_id (uuid), segment_id (uuid)",
    "relationships": "│ Relations: command_id -> commands.id, segment_id -> segments.id",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  },
  {
    "diagram": "┌─ waitlist (9 columns) ─┐",
    "column_details": "│ Columns: id (uuid), email (text), name (text), referral_code_attempted (text), source (text), status (text), metadata (jsonb), created_at (timestamp with time zone), updated_at (timestamp with time zone)",
    "relationships": "│ Relations: None",
    "bottom_border": "└────────────────────────────┘",
    "spacer": ""
  }
]