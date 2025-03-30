# Resumen del Esquema de Base de Datos

## Esquema: auth

Contiene 16 tabla(s):

### Tabla: audit_log_entries

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| instance_id | uuid | Sí |  |
| id | uuid | No | PRIMARY KEY |
| payload | json | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| ip_address | character varying(64) | No |  |

### Tabla: flow_state

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| user_id | uuid | Sí |  |
| auth_code | text | No |  |
| code_challenge_method | auth.code_challenge_method | No |  |
| code_challenge | text | No |  |
| provider_type | text | No |  |
| provider_access_token | text | Sí |  |
| provider_refresh_token | text | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| authentication_method | text | No |  |
| auth_code_issued_at | timestamp with time zone | Sí |  |

### Tabla: identities

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| provider_id | text | No | UNIQUE |
| user_id | uuid | No | FK → auth.users |
| identity_data | jsonb | No |  |
| provider | text | No | UNIQUE |
| last_sign_in_at | timestamp with time zone | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| email | text | Sí |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: instances

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| uuid | uuid | Sí |  |
| raw_base_config | text | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |

### Tabla: mfa_amr_claims

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| session_id | uuid | No | UNIQUE, FK → auth.sessions |
| session_id | uuid | No | UNIQUE, FK → auth.sessions |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| authentication_method | text | No | UNIQUE |
| id | uuid | No | PRIMARY KEY |

### Tabla: mfa_challenges

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| factor_id | uuid | No | FK → auth.mfa_factors |
| created_at | timestamp with time zone | No |  |
| verified_at | timestamp with time zone | Sí |  |
| ip_address | inet | No |  |
| otp_code | text | Sí |  |
| web_authn_session_data | jsonb | Sí |  |

### Tabla: mfa_factors

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| user_id | uuid | No | FK → auth.users |
| friendly_name | text | Sí |  |
| factor_type | auth.factor_type | No |  |
| status | auth.factor_status | No |  |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| secret | text | Sí |  |
| phone | text | Sí |  |
| last_challenged_at | timestamp with time zone | Sí | UNIQUE |
| web_authn_credential | jsonb | Sí |  |
| web_authn_aaguid | uuid | Sí |  |

### Tabla: one_time_tokens

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| user_id | uuid | No | FK → auth.users |
| token_type | auth.one_time_token_type | No |  |
| token_hash | text | No |  |
| relates_to | text | No |  |
| created_at | timestamp without time zone | No |  |
| updated_at | timestamp without time zone | No |  |

### Tabla: refresh_tokens

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| instance_id | uuid | Sí |  |
| id | bigint | No | PRIMARY KEY |
| token | character varying(255) | Sí | UNIQUE |
| user_id | character varying(255) | Sí |  |
| revoked | boolean | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| parent | character varying(255) | Sí |  |
| session_id | uuid | Sí | FK → auth.sessions |

### Tabla: saml_providers

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| sso_provider_id | uuid | No | FK → auth.sso_providers |
| entity_id | text | No | UNIQUE |
| entity_id | text | No | UNIQUE |
| metadata_xml | text | No |  |
| metadata_url | text | Sí |  |
| attribute_mapping | jsonb | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| name_id_format | text | Sí |  |

### Tabla: saml_relay_states

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| sso_provider_id | uuid | No | FK → auth.sso_providers |
| request_id | text | No |  |
| for_email | text | Sí |  |
| redirect_to | text | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| flow_state_id | uuid | Sí | FK → auth.flow_state |

### Tabla: schema_migrations

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| version | character varying(255) | No | PRIMARY KEY |

### Tabla: sessions

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| factor_id | uuid | Sí |  |
| aal | auth.aal_level | Sí |  |
| not_after | timestamp with time zone | Sí |  |
| refreshed_at | timestamp without time zone | Sí |  |
| user_agent | text | Sí |  |
| ip | inet | Sí |  |
| tag | text | Sí |  |

### Tabla: sso_domains

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| sso_provider_id | uuid | No | FK → auth.sso_providers |
| domain | text | No |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |

### Tabla: sso_providers

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| resource_id | text | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |

### Tabla: users

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| instance_id | uuid | Sí |  |
| id | uuid | No | PRIMARY KEY |
| aud | character varying(255) | Sí |  |
| role | character varying(255) | Sí |  |
| email | character varying(255) | Sí |  |
| encrypted_password | character varying(255) | Sí |  |
| email_confirmed_at | timestamp with time zone | Sí |  |
| invited_at | timestamp with time zone | Sí |  |
| confirmation_token | character varying(255) | Sí |  |
| confirmation_sent_at | timestamp with time zone | Sí |  |
| recovery_token | character varying(255) | Sí |  |
| recovery_sent_at | timestamp with time zone | Sí |  |
| email_change_token_new | character varying(255) | Sí |  |
| email_change | character varying(255) | Sí |  |
| email_change_sent_at | timestamp with time zone | Sí |  |
| last_sign_in_at | timestamp with time zone | Sí |  |
| raw_app_meta_data | jsonb | Sí |  |
| raw_user_meta_data | jsonb | Sí |  |
| is_super_admin | boolean | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| phone | text | Sí | UNIQUE |
| phone_confirmed_at | timestamp with time zone | Sí |  |
| phone_change | text | Sí |  |
| phone_change_token | character varying(255) | Sí |  |
| phone_change_sent_at | timestamp with time zone | Sí |  |
| confirmed_at | timestamp with time zone | Sí |  |
| email_change_token_current | character varying(255) | Sí |  |
| email_change_confirm_status | smallint | Sí |  |
| banned_until | timestamp with time zone | Sí |  |
| reauthentication_token | character varying(255) | Sí |  |
| reauthentication_sent_at | timestamp with time zone | Sí |  |
| is_sso_user | boolean | No |  |
| deleted_at | timestamp with time zone | Sí |  |
| is_anonymous | boolean | No |  |


## Esquema: pgsodium

Contiene 1 tabla(s):

### Tabla: key

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| status | pgsodium.key_status | Sí |  |
| created | timestamp with time zone | No |  |
| expires | timestamp with time zone | Sí |  |
| key_type | pgsodium.key_type | Sí |  |
| key_id | bigint | Sí |  |
| key_context | bytea | Sí |  |
| key_context | bytea | Sí |  |
| name | text | Sí | UNIQUE |
| associated_data | text | Sí |  |
| raw_key | bytea | Sí |  |
| raw_key_nonce | bytea | Sí |  |
| parent_key | uuid | Sí | FK → pgsodium.key |
| parent_key | uuid | Sí | FK → pgsodium.key |
| comment | text | Sí |  |
| user_data | text | Sí |  |


## Esquema: public

Contiene 15 tabla(s):

### Tabla: agents

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| description | text | Sí |  |
| type | text | No |  |
| status | text | No |  |
| prompt | text | No |  |
| conversations | integer | Sí |  |
| success_rate | integer | Sí |  |
| configuration | jsonb | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| last_active | timestamp with time zone | Sí |  |

### Tabla: assets

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| description | text | Sí |  |
| file_path | text | No |  |
| file_type | text | No |  |
| file_size | integer | Sí |  |
| metadata | jsonb | Sí |  |
| is_public | boolean | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |

### Tabla: debug_logs

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| operation | text | Sí |  |
| user_id | uuid | Sí |  |
| site_id | uuid | Sí |  |
| details | jsonb | Sí |  |
| created_at | timestamp with time zone | Sí |  |

### Tabla: experiment_segments

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| experiment_id | uuid | Sí | UNIQUE, FK → public.experiments |
| experiment_id | uuid | Sí | UNIQUE, FK → public.experiments |
| segment_id | uuid | Sí | UNIQUE, FK → public.segments |
| segment_id | uuid | Sí | UNIQUE, FK → public.segments |
| participants | integer | Sí |  |

### Tabla: experiments

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| description | text | Sí |  |
| status | text | No |  |
| start_date | timestamp with time zone | Sí |  |
| end_date | timestamp with time zone | Sí |  |
| conversion | numeric | Sí |  |
| roi | numeric | Sí |  |
| preview_url | text | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| hypothesis | text | Sí |  |

### Tabla: external_resources

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| key | text | No |  |
| url | text | No |  |
| description | text | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |

### Tabla: kpis

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| description | text | Sí |  |
| value | numeric | No |  |
| previous_value | numeric | Sí |  |
| unit | text | No |  |
| type | text | No |  |
| period_start | timestamp with time zone | No |  |
| period_end | timestamp with time zone | No |  |
| segment_id | uuid | Sí | FK → public.segments |
| is_highlighted | boolean | Sí |  |
| target_value | numeric | Sí |  |
| metadata | jsonb | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| trend | numeric | Sí |  |
| benchmark | numeric | Sí |  |

### Tabla: leads

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| email | text | No |  |
| company | text | Sí |  |
| position | text | Sí |  |
| segment_id | uuid | Sí | FK → public.segments |
| status | text | No |  |
| notes | text | Sí |  |
| last_contact | timestamp with time zone | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| phone | text | Sí |  |
| origin | text | Sí |  |

### Tabla: notifications

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| title | text | No |  |
| message | text | No |  |
| type | text | No |  |
| is_read | boolean | Sí |  |
| action_url | text | Sí |  |
| related_entity_type | text | Sí |  |
| related_entity_id | uuid | Sí |  |
| site_id | uuid | Sí | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| event_type | text | Sí |  |
| severity | integer | Sí |  |

### Tabla: profiles

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY, FK → auth.users |
| id | uuid | No | PRIMARY KEY, FK → auth.users |
| email | text | No |  |
| name | text | Sí |  |
| avatar_url | text | Sí |  |
| auth0_id | text | Sí | UNIQUE |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |

### Tabla: requirement_segments

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| requirement_id | uuid | No | FK → public.requirements |
| requirement_id | uuid | No | FK → public.requirements |
| segment_id | uuid | No | PRIMARY KEY, FK → public.segments |
| segment_id | uuid | No | PRIMARY KEY, FK → public.segments |

### Tabla: requirements

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| title | text | No |  |
| description | text | Sí |  |
| priority | text | No |  |
| status | text | No |  |
| completion_status | text | No |  |
| source | text | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |

### Tabla: segments

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| description | text | Sí |  |
| audience | segment_audience | Sí |  |
| size | integer | Sí |  |
| engagement | integer | Sí |  |
| is_active | boolean | Sí |  |
| keywords | jsonb | Sí |  |
| hot_topics | jsonb | Sí |  |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| language | segment_language | No |  |
| url | text | Sí |  |

### Tabla: sites

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | No |  |
| url | text | Sí |  |
| description | text | Sí |  |
| logo_url | text | Sí |  |
| resource_urls | jsonb | Sí |  |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| competitors | jsonb | Sí |  |
| focus_mode | integer | Sí |  |

### Tabla: visitor_events

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| event_type | text | No |  |
| page_url | text | Sí |  |
| referrer_url | text | Sí |  |
| visitor_id | text | Sí |  |
| session_id | text | Sí |  |
| ip_address | text | Sí |  |
| user_agent | text | Sí |  |
| device_type | text | Sí |  |
| country | text | Sí |  |
| region | text | Sí |  |
| city | text | Sí |  |
| duration_seconds | integer | Sí |  |
| custom_data | jsonb | Sí |  |
| lead_id | uuid | Sí | FK → public.leads |
| segment_id | uuid | Sí | FK → public.segments |
| experiment_id | uuid | Sí | FK → public.experiments |
| site_id | uuid | No | FK → public.sites |
| user_id | uuid | No | FK → auth.users |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |
| location | jsonb | Sí |  |
| campaign_id | uuid | Sí | FK → public.experiments |


## Esquema: realtime

Contiene 10 tabla(s):

### Tabla: messages_2025_03_04

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_05

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_06

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_07

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_08

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_09

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_10

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: messages_2025_03_11

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| topic | text | No |  |
| extension | text | No |  |
| payload | jsonb | Sí |  |
| event | text | Sí |  |
| private | boolean | Sí |  |
| updated_at | timestamp without time zone | No |  |
| inserted_at | timestamp without time zone | No |  |
| id | uuid | No | PRIMARY KEY |

### Tabla: schema_migrations

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| version | bigint | No | PRIMARY KEY |
| inserted_at | timestamp(0) without time zone | Sí |  |

### Tabla: subscription

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | bigint | No | PRIMARY KEY |
| subscription_id | uuid | No |  |
| entity | regclass | No |  |
| filters | realtime.user_defined_filter[] | No |  |
| claims | jsonb | No |  |
| claims_role | regrole | No |  |
| created_at | timestamp without time zone | No |  |


## Esquema: storage

Contiene 5 tabla(s):

### Tabla: buckets

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | text | No | PRIMARY KEY |
| name | text | No |  |
| owner | uuid | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| public | boolean | Sí |  |
| avif_autodetection | boolean | Sí |  |
| file_size_limit | bigint | Sí |  |
| allowed_mime_types | text[] | Sí |  |
| owner_id | text | Sí |  |

### Tabla: migrations

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | integer | No | PRIMARY KEY |
| name | character varying(100) | No | UNIQUE |
| hash | character varying(40) | No |  |
| executed_at | timestamp without time zone | Sí |  |

### Tabla: objects

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| bucket_id | text | Sí | FK → storage.buckets |
| name | text | Sí |  |
| owner | uuid | Sí |  |
| created_at | timestamp with time zone | Sí |  |
| updated_at | timestamp with time zone | Sí |  |
| last_accessed_at | timestamp with time zone | Sí |  |
| metadata | jsonb | Sí |  |
| path_tokens | text[] | Sí |  |
| version | text | Sí |  |
| owner_id | text | Sí |  |
| user_metadata | jsonb | Sí |  |

### Tabla: s3_multipart_uploads

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | text | No | PRIMARY KEY |
| in_progress_size | bigint | No |  |
| upload_signature | text | No |  |
| bucket_id | text | No | FK → storage.buckets |
| key | text | No |  |
| version | text | No |  |
| owner_id | text | Sí |  |
| created_at | timestamp with time zone | No |  |
| user_metadata | jsonb | Sí |  |

### Tabla: s3_multipart_uploads_parts

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| upload_id | text | No | FK → storage.s3_multipart_uploads |
| size | bigint | No |  |
| part_number | integer | No |  |
| bucket_id | text | No | FK → storage.buckets |
| key | text | No |  |
| etag | text | No |  |
| owner_id | text | Sí |  |
| version | text | No |  |
| created_at | timestamp with time zone | No |  |


## Esquema: vault

Contiene 1 tabla(s):

### Tabla: secrets

#### Columnas

| Nombre | Tipo | Nullable | Restricciones |
|--------|------|----------|---------------|
| id | uuid | No | PRIMARY KEY |
| name | text | Sí |  |
| description | text | No |  |
| secret | text | No |  |
| key_id | uuid | Sí | FK → pgsodium.key |
| nonce | bytea | Sí |  |
| created_at | timestamp with time zone | No |  |
| updated_at | timestamp with time zone | No |  |


