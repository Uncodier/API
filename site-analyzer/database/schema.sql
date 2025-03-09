[
  {
    "schema": "auth",
    "table": "audit_log_entries",
    "column": "instance_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "audit_log_entries",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "audit_log_entries",
    "column": "payload",
    "data_type": "json",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "audit_log_entries",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "audit_log_entries",
    "column": "ip_address",
    "data_type": "character varying(64)",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "auth_code",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "code_challenge_method",
    "data_type": "auth.code_challenge_method",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "code_challenge",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "provider_type",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "provider_access_token",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "provider_refresh_token",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "authentication_method",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "flow_state",
    "column": "auth_code_issued_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "provider_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "identity_data",
    "data_type": "jsonb",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "provider",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "last_sign_in_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "email",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "identities",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "instances",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "instances",
    "column": "uuid",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "instances",
    "column": "raw_base_config",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "instances",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "instances",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_amr_claims",
    "column": "session_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_amr_claims",
    "column": "session_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.sessions"
  },
  {
    "schema": "auth",
    "table": "mfa_amr_claims",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_amr_claims",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_amr_claims",
    "column": "authentication_method",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_amr_claims",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "factor_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.mfa_factors"
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "verified_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "ip_address",
    "data_type": "inet",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "otp_code",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_challenges",
    "column": "web_authn_session_data",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "friendly_name",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "factor_type",
    "data_type": "auth.factor_type",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "status",
    "data_type": "auth.factor_status",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "secret",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "phone",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "last_challenged_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "web_authn_credential",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "mfa_factors",
    "column": "web_authn_aaguid",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "token_type",
    "data_type": "auth.one_time_token_type",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "token_hash",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "relates_to",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "created_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "one_time_tokens",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "instance_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "id",
    "data_type": "bigint",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "token",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "user_id",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "revoked",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "parent",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "refresh_tokens",
    "column": "session_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.sessions"
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "sso_provider_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.sso_providers"
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "entity_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "entity_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "metadata_xml",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "metadata_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "attribute_mapping",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_providers",
    "column": "name_id_format",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "sso_provider_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.sso_providers"
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "request_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "for_email",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "redirect_to",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "saml_relay_states",
    "column": "flow_state_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.flow_state"
  },
  {
    "schema": "auth",
    "table": "schema_migrations",
    "column": "version",
    "data_type": "character varying(255)",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "factor_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "aal",
    "data_type": "auth.aal_level",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "not_after",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "refreshed_at",
    "data_type": "timestamp without time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "user_agent",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "ip",
    "data_type": "inet",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sessions",
    "column": "tag",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_domains",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_domains",
    "column": "sso_provider_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.sso_providers"
  },
  {
    "schema": "auth",
    "table": "sso_domains",
    "column": "domain",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_domains",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_domains",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_providers",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_providers",
    "column": "resource_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_providers",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "sso_providers",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "instance_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "aud",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "role",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "encrypted_password",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email_confirmed_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "invited_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "confirmation_token",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "confirmation_sent_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "recovery_token",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "recovery_sent_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email_change_token_new",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email_change",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email_change_sent_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "last_sign_in_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "raw_app_meta_data",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "raw_user_meta_data",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "is_super_admin",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "phone",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "phone_confirmed_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "phone_change",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "phone_change_token",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "phone_change_sent_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "confirmed_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email_change_token_current",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "email_change_confirm_status",
    "data_type": "smallint",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "banned_until",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "reauthentication_token",
    "data_type": "character varying(255)",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "reauthentication_sent_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "is_sso_user",
    "data_type": "boolean",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "deleted_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "auth",
    "table": "users",
    "column": "is_anonymous",
    "data_type": "boolean",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "status",
    "data_type": "pgsodium.key_status",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "created",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "expires",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "key_type",
    "data_type": "pgsodium.key_type",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "key_id",
    "data_type": "bigint",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "key_context",
    "data_type": "bytea",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "key_context",
    "data_type": "bytea",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "name",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "associated_data",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "raw_key",
    "data_type": "bytea",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "raw_key_nonce",
    "data_type": "bytea",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "parent_key",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "pgsodium.key"
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "parent_key",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "comment",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "pgsodium",
    "table": "key",
    "column": "user_data",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "type",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "status",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "prompt",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "conversations",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "success_rate",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "configuration",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "agents",
    "column": "last_active",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "file_path",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "file_type",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "file_size",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "metadata",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "is_public",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "assets",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "debug_logs",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "debug_logs",
    "column": "operation",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "debug_logs",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "debug_logs",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "debug_logs",
    "column": "details",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "debug_logs",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiment_segments",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiment_segments",
    "column": "experiment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.experiments"
  },
  {
    "schema": "public",
    "table": "experiment_segments",
    "column": "experiment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiment_segments",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.segments"
  },
  {
    "schema": "public",
    "table": "experiment_segments",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiment_segments",
    "column": "participants",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "status",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "start_date",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "end_date",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "conversion",
    "data_type": "numeric",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "roi",
    "data_type": "numeric",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "preview_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "experiments",
    "column": "hypothesis",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "key",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "url",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "external_resources",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "value",
    "data_type": "numeric",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "previous_value",
    "data_type": "numeric",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "unit",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "type",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "period_start",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "period_end",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.segments"
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "is_highlighted",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "target_value",
    "data_type": "numeric",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "metadata",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "trend",
    "data_type": "numeric",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "kpis",
    "column": "benchmark",
    "data_type": "numeric",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "email",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "company",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "position",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.segments"
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "status",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "notes",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "last_contact",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "phone",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "leads",
    "column": "origin",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "title",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "message",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "type",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "is_read",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "action_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "related_entity_type",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "related_entity_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "event_type",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "notifications",
    "column": "severity",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "email",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "name",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "avatar_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "auth0_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "profiles",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirement_segments",
    "column": "requirement_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.requirements"
  },
  {
    "schema": "public",
    "table": "requirement_segments",
    "column": "requirement_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirement_segments",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.segments"
  },
  {
    "schema": "public",
    "table": "requirement_segments",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "title",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "priority",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "status",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "completion_status",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "source",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "requirements",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "audience",
    "data_type": "segment_audience",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "size",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "engagement",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "is_active",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "keywords",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "hot_topics",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "language",
    "data_type": "segment_language",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "segments",
    "column": "url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "description",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "logo_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "resource_urls",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "competitors",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "sites",
    "column": "focus_mode",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "event_type",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "page_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "referrer_url",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "visitor_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "session_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "ip_address",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "user_agent",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "device_type",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "country",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "region",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "city",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "duration_seconds",
    "data_type": "integer",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "custom_data",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "lead_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.leads"
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "segment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.segments"
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "experiment_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.experiments"
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "site_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.sites"
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "user_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "auth.users"
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "location",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "public",
    "table": "visitor_events",
    "column": "campaign_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "public.experiments"
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_04",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_05",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_06",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_07",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_08",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_09",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_10",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "topic",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "extension",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "payload",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "event",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "private",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "updated_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "inserted_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "messages_2025_03_11",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "schema_migrations",
    "column": "version",
    "data_type": "bigint",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "schema_migrations",
    "column": "inserted_at",
    "data_type": "timestamp(0) without time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "id",
    "data_type": "bigint",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "subscription_id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "entity",
    "data_type": "regclass",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "filters",
    "data_type": "realtime.user_defined_filter[]",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "claims",
    "data_type": "jsonb",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "claims_role",
    "data_type": "regrole",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "realtime",
    "table": "subscription",
    "column": "created_at",
    "data_type": "timestamp without time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "name",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "owner",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "public",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "avif_autodetection",
    "data_type": "boolean",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "file_size_limit",
    "data_type": "bigint",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "allowed_mime_types",
    "data_type": "text[]",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "buckets",
    "column": "owner_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "migrations",
    "column": "id",
    "data_type": "integer",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "migrations",
    "column": "name",
    "data_type": "character varying(100)",
    "nullable": "NOT NULL",
    "constraint_type": "UNIQUE",
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "migrations",
    "column": "hash",
    "data_type": "character varying(40)",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "migrations",
    "column": "executed_at",
    "data_type": "timestamp without time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "bucket_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "storage.buckets"
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "name",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "owner",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "last_accessed_at",
    "data_type": "timestamp with time zone",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "metadata",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "path_tokens",
    "data_type": "text[]",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "version",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "owner_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "objects",
    "column": "user_metadata",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "in_progress_size",
    "data_type": "bigint",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "upload_signature",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "bucket_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "storage.buckets"
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "key",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "version",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "owner_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads",
    "column": "user_metadata",
    "data_type": "jsonb",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "upload_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "storage.s3_multipart_uploads"
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "size",
    "data_type": "bigint",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "part_number",
    "data_type": "integer",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "bucket_id",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "storage.buckets"
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "key",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "etag",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "owner_id",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "version",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "storage",
    "table": "s3_multipart_uploads_parts",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "id",
    "data_type": "uuid",
    "nullable": "NOT NULL",
    "constraint_type": "PRIMARY KEY",
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "name",
    "data_type": "text",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "description",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "secret",
    "data_type": "text",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "key_id",
    "data_type": "uuid",
    "nullable": "NULL",
    "constraint_type": "FOREIGN KEY",
    "references_table": "pgsodium.key"
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "nonce",
    "data_type": "bytea",
    "nullable": "NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "created_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  },
  {
    "schema": "vault",
    "table": "secrets",
    "column": "updated_at",
    "data_type": "timestamp with time zone",
    "nullable": "NOT NULL",
    "constraint_type": null,
    "references_table": null
  }
]