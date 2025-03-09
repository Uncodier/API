# Relaciones entre Tablas

```mermaid
erDiagram
    auth_audit_log_entries {
        uuid instance_id 
        uuid id PK
        json payload 
        timestamp with time zone created_at 
        character varying(64) ip_address 
    }
    auth_flow_state {
        uuid id PK
        uuid user_id 
        text auth_code 
        auth.code_challenge_method code_challenge_method 
        text code_challenge 
        text provider_type 
        text provider_access_token 
        text provider_refresh_token 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text authentication_method 
        timestamp with time zone auth_code_issued_at 
    }
    auth_identities {
        text provider_id 
        uuid user_id 
        jsonb identity_data 
        text provider 
        timestamp with time zone last_sign_in_at 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text email 
        uuid id PK
    }
    auth_instances {
        uuid id PK
        uuid uuid 
        text raw_base_config 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    auth_mfa_amr_claims {
        uuid session_id 
        uuid session_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text authentication_method 
        uuid id PK
    }
    auth_mfa_challenges {
        uuid id PK
        uuid factor_id 
        timestamp with time zone created_at 
        timestamp with time zone verified_at 
        inet ip_address 
        text otp_code 
        jsonb web_authn_session_data 
    }
    auth_mfa_factors {
        uuid id PK
        uuid user_id 
        text friendly_name 
        auth.factor_type factor_type 
        auth.factor_status status 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text secret 
        text phone 
        timestamp with time zone last_challenged_at 
        jsonb web_authn_credential 
        uuid web_authn_aaguid 
    }
    auth_one_time_tokens {
        uuid id PK
        uuid user_id 
        auth.one_time_token_type token_type 
        text token_hash 
        text relates_to 
        timestamp without time zone created_at 
        timestamp without time zone updated_at 
    }
    auth_refresh_tokens {
        uuid instance_id 
        bigint id PK
        character varying(255) token 
        character varying(255) user_id 
        boolean revoked 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        character varying(255) parent 
        uuid session_id 
    }
    auth_saml_providers {
        uuid id PK
        uuid sso_provider_id 
        text entity_id 
        text entity_id 
        text metadata_xml 
        text metadata_url 
        jsonb attribute_mapping 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text name_id_format 
    }
    auth_saml_relay_states {
        uuid id PK
        uuid sso_provider_id 
        text request_id 
        text for_email 
        text redirect_to 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        uuid flow_state_id 
    }
    auth_schema_migrations {
        character varying(255) version PK
    }
    auth_sessions {
        uuid id PK
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        uuid factor_id 
        auth.aal_level aal 
        timestamp with time zone not_after 
        timestamp without time zone refreshed_at 
        text user_agent 
        inet ip 
        text tag 
    }
    auth_sso_domains {
        uuid id PK
        uuid sso_provider_id 
        text domain 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    auth_sso_providers {
        uuid id PK
        text resource_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    auth_users {
        uuid instance_id 
        uuid id PK
        character varying(255) aud 
        character varying(255) role 
        character varying(255) email 
        character varying(255) encrypted_password 
        timestamp with time zone email_confirmed_at 
        timestamp with time zone invited_at 
        character varying(255) confirmation_token 
        timestamp with time zone confirmation_sent_at 
        character varying(255) recovery_token 
        timestamp with time zone recovery_sent_at 
        character varying(255) email_change_token_new 
        character varying(255) email_change 
        timestamp with time zone email_change_sent_at 
        timestamp with time zone last_sign_in_at 
        jsonb raw_app_meta_data 
        jsonb raw_user_meta_data 
        boolean is_super_admin 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text phone 
        timestamp with time zone phone_confirmed_at 
        text phone_change 
        character varying(255) phone_change_token 
        timestamp with time zone phone_change_sent_at 
        timestamp with time zone confirmed_at 
        character varying(255) email_change_token_current 
        smallint email_change_confirm_status 
        timestamp with time zone banned_until 
        character varying(255) reauthentication_token 
        timestamp with time zone reauthentication_sent_at 
        boolean is_sso_user 
        timestamp with time zone deleted_at 
        boolean is_anonymous 
    }
    pgsodium_key {
        uuid id PK
        pgsodium.key_status status 
        timestamp with time zone created 
        timestamp with time zone expires 
        pgsodium.key_type key_type 
        bigint key_id 
        bytea key_context 
        bytea key_context 
        text name 
        text associated_data 
        bytea raw_key 
        bytea raw_key_nonce 
        uuid parent_key 
        uuid parent_key 
        text comment 
        text user_data 
    }
    public_agents {
        uuid id PK
        text name 
        text description 
        text type 
        text status 
        text prompt 
        integer conversations 
        integer success_rate 
        jsonb configuration 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        timestamp with time zone last_active 
    }
    public_assets {
        uuid id PK
        text name 
        text description 
        text file_path 
        text file_type 
        integer file_size 
        jsonb metadata 
        boolean is_public 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    public_debug_logs {
        uuid id PK
        text operation 
        uuid user_id 
        uuid site_id 
        jsonb details 
        timestamp with time zone created_at 
    }
    public_experiment_segments {
        uuid id PK
        uuid experiment_id 
        uuid experiment_id 
        uuid segment_id 
        uuid segment_id 
        integer participants 
    }
    public_experiments {
        uuid id PK
        text name 
        text description 
        text status 
        timestamp with time zone start_date 
        timestamp with time zone end_date 
        numeric conversion 
        numeric roi 
        text preview_url 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text hypothesis 
    }
    public_external_resources {
        uuid id PK
        text key 
        text url 
        text description 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    public_kpis {
        uuid id PK
        text name 
        text description 
        numeric value 
        numeric previous_value 
        text unit 
        text type 
        timestamp with time zone period_start 
        timestamp with time zone period_end 
        uuid segment_id 
        boolean is_highlighted 
        numeric target_value 
        jsonb metadata 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        numeric trend 
        numeric benchmark 
    }
    public_leads {
        uuid id PK
        text name 
        text email 
        text company 
        text position 
        uuid segment_id 
        text status 
        text notes 
        timestamp with time zone last_contact 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text phone 
        text origin 
    }
    public_notifications {
        uuid id PK
        text title 
        text message 
        text type 
        boolean is_read 
        text action_url 
        text related_entity_type 
        uuid related_entity_id 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        text event_type 
        integer severity 
    }
    public_profiles {
        uuid id PK
        uuid id PK
        text email 
        text name 
        text avatar_url 
        text auth0_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    public_requirement_segments {
        uuid requirement_id 
        uuid requirement_id 
        uuid segment_id PK
        uuid segment_id PK
    }
    public_requirements {
        uuid id PK
        text title 
        text description 
        text priority 
        text status 
        text completion_status 
        text source 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    public_segments {
        uuid id PK
        text name 
        text description 
        segment_audience audience 
        integer size 
        integer engagement 
        boolean is_active 
        jsonb keywords 
        jsonb hot_topics 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        segment_language language 
        text url 
    }
    public_sites {
        uuid id PK
        text name 
        text url 
        text description 
        text logo_url 
        jsonb resource_urls 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        jsonb competitors 
        integer focus_mode 
    }
    public_visitor_events {
        uuid id PK
        text event_type 
        text page_url 
        text referrer_url 
        text visitor_id 
        text session_id 
        text ip_address 
        text user_agent 
        text device_type 
        text country 
        text region 
        text city 
        integer duration_seconds 
        jsonb custom_data 
        uuid lead_id 
        uuid segment_id 
        uuid experiment_id 
        uuid site_id 
        uuid user_id 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        jsonb location 
        uuid campaign_id 
    }
    realtime_messages_2025_03_04 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_05 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_06 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_07 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_08 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_09 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_10 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_messages_2025_03_11 {
        text topic 
        text extension 
        jsonb payload 
        text event 
        boolean private 
        timestamp without time zone updated_at 
        timestamp without time zone inserted_at 
        uuid id PK
    }
    realtime_schema_migrations {
        bigint version PK
        timestamp(0) without time zone inserted_at 
    }
    realtime_subscription {
        bigint id PK
        uuid subscription_id 
        regclass entity 
        realtime.user_defined_filter[] filters 
        jsonb claims 
        regrole claims_role 
        timestamp without time zone created_at 
    }
    storage_buckets {
        text id PK
        text name 
        uuid owner 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        boolean public 
        boolean avif_autodetection 
        bigint file_size_limit 
        text[] allowed_mime_types 
        text owner_id 
    }
    storage_migrations {
        integer id PK
        character varying(100) name 
        character varying(40) hash 
        timestamp without time zone executed_at 
    }
    storage_objects {
        uuid id PK
        text bucket_id 
        text name 
        uuid owner 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
        timestamp with time zone last_accessed_at 
        jsonb metadata 
        text[] path_tokens 
        text version 
        text owner_id 
        jsonb user_metadata 
    }
    storage_s3_multipart_uploads {
        text id PK
        bigint in_progress_size 
        text upload_signature 
        text bucket_id 
        text key 
        text version 
        text owner_id 
        timestamp with time zone created_at 
        jsonb user_metadata 
    }
    storage_s3_multipart_uploads_parts {
        uuid id PK
        text upload_id 
        bigint size 
        integer part_number 
        text bucket_id 
        text key 
        text etag 
        text owner_id 
        text version 
        timestamp with time zone created_at 
    }
    vault_secrets {
        uuid id PK
        text name 
        text description 
        text secret 
        uuid key_id 
        bytea nonce 
        timestamp with time zone created_at 
        timestamp with time zone updated_at 
    }
    auth_identities ||--o{ auth_users : "user_id"
    auth_mfa_amr_claims ||--o{ auth_sessions : "session_id"
    auth_mfa_challenges ||--o{ auth_mfa_factors : "factor_id"
    auth_mfa_factors ||--o{ auth_users : "user_id"
    auth_one_time_tokens ||--o{ auth_users : "user_id"
    auth_refresh_tokens ||--o{ auth_sessions : "session_id"
    auth_saml_providers ||--o{ auth_sso_providers : "sso_provider_id"
    auth_saml_relay_states ||--o{ auth_sso_providers : "sso_provider_id"
    auth_saml_relay_states ||--o{ auth_flow_state : "flow_state_id"
    auth_sessions ||--o{ auth_users : "user_id"
    auth_sso_domains ||--o{ auth_sso_providers : "sso_provider_id"
    pgsodium_key ||--o{ pgsodium_key : "parent_key"
    public_agents ||--o{ public_sites : "site_id"
    public_agents ||--o{ auth_users : "user_id"
    public_assets ||--o{ public_sites : "site_id"
    public_assets ||--o{ auth_users : "user_id"
    public_experiment_segments ||--o{ public_experiments : "experiment_id"
    public_experiment_segments ||--o{ public_segments : "segment_id"
    public_experiments ||--o{ public_sites : "site_id"
    public_experiments ||--o{ auth_users : "user_id"
    public_external_resources ||--o{ public_sites : "site_id"
    public_external_resources ||--o{ auth_users : "user_id"
    public_kpis ||--o{ public_segments : "segment_id"
    public_kpis ||--o{ public_sites : "site_id"
    public_kpis ||--o{ auth_users : "user_id"
    public_leads ||--o{ public_segments : "segment_id"
    public_leads ||--o{ public_sites : "site_id"
    public_leads ||--o{ auth_users : "user_id"
    public_notifications ||--o{ public_sites : "site_id"
    public_notifications ||--o{ auth_users : "user_id"
    public_profiles ||--o{ auth_users : "id"
    public_requirement_segments ||--o{ public_requirements : "requirement_id"
    public_requirement_segments ||--o{ public_segments : "segment_id"
    public_requirements ||--o{ public_sites : "site_id"
    public_requirements ||--o{ auth_users : "user_id"
    public_segments ||--o{ public_sites : "site_id"
    public_segments ||--o{ auth_users : "user_id"
    public_sites ||--o{ auth_users : "user_id"
    public_visitor_events ||--o{ public_leads : "lead_id"
    public_visitor_events ||--o{ public_segments : "segment_id"
    public_visitor_events ||--o{ public_experiments : "experiment_id"
    public_visitor_events ||--o{ public_sites : "site_id"
    public_visitor_events ||--o{ auth_users : "user_id"
    public_visitor_events ||--o{ public_experiments : "campaign_id"
    storage_objects ||--o{ storage_buckets : "bucket_id"
    storage_s3_multipart_uploads ||--o{ storage_buckets : "bucket_id"
    storage_s3_multipart_uploads_parts ||--o{ storage_s3_multipart_uploads : "upload_id"
    storage_s3_multipart_uploads_parts ||--o{ storage_buckets : "bucket_id"
    vault_secrets ||--o{ pgsodium_key : "key_id"
```
