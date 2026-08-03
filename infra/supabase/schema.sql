-- T3 Connect relay schema for a fresh PostgreSQL database.
--
-- Authoritative definitions:
--   infra/relay/src/persistence/schema.ts
--   infra/relay/migrations/postgres/*/migration.sql
--
-- This file represents the current schema after all checked-in migrations. In particular,
-- idx_relay_live_activities_user and idx_relay_mobile_devices_user are intentionally absent because
-- infra/relay/migrations/postgres/20260727144838_migration/migration.sql drops them.

BEGIN;

CREATE TABLE public.relay_mobile_devices (
  user_id varchar(255) NOT NULL,
  device_id varchar(255) NOT NULL,
  label text DEFAULT 'iOS device' NOT NULL,
  platform varchar(16) NOT NULL,
  ios_major_version integer NOT NULL,
  app_version varchar(64),
  bundle_id varchar(255),
  aps_environment varchar(16),
  push_token text,
  push_to_start_token text,
  preferences_json jsonb NOT NULL,
  created_at varchar(64) NOT NULL,
  updated_at varchar(64) NOT NULL,
  CONSTRAINT relay_mobile_devices_pkey PRIMARY KEY (user_id, device_id)
);

CREATE UNIQUE INDEX idx_relay_mobile_devices_push_token
  ON public.relay_mobile_devices (push_token);

CREATE UNIQUE INDEX idx_relay_mobile_devices_push_to_start_token
  ON public.relay_mobile_devices (push_to_start_token);

CREATE TABLE public.relay_live_activities (
  user_id varchar(255) NOT NULL,
  device_id varchar(255) NOT NULL,
  activity_push_token text,
  remote_start_queued_at varchar(64),
  remote_started_at varchar(64),
  ended_at varchar(64),
  last_aggregate_json jsonb,
  last_live_activity_delivery_at varchar(64),
  created_at varchar(64) NOT NULL,
  updated_at varchar(64) NOT NULL,
  CONSTRAINT relay_live_activities_pkey PRIMARY KEY (user_id, device_id)
);

CREATE UNIQUE INDEX idx_relay_live_activities_activity_push_token
  ON public.relay_live_activities (activity_push_token);

CREATE TABLE public.relay_environment_links (
  user_id varchar(191) NOT NULL,
  environment_id varchar(191) NOT NULL,
  environment_label text DEFAULT 'T3 Environment' NOT NULL,
  environment_public_key text NOT NULL,
  endpoint_http_base_url text NOT NULL,
  endpoint_ws_base_url text NOT NULL,
  endpoint_provider_kind varchar(32) NOT NULL,
  notifications_enabled boolean DEFAULT true NOT NULL,
  live_activities_enabled boolean DEFAULT true NOT NULL,
  managed_tunnels_enabled boolean DEFAULT false NOT NULL,
  created_by_device_id varchar(191),
  revoked_at varchar(64),
  created_at varchar(64) NOT NULL,
  updated_at varchar(64) NOT NULL,
  CONSTRAINT relay_environment_links_pkey PRIMARY KEY (user_id, environment_id)
);

CREATE INDEX idx_relay_environment_links_environment
  ON public.relay_environment_links (environment_id, revoked_at);

CREATE TABLE public.relay_managed_endpoint_allocations (
  user_id varchar(191) NOT NULL,
  environment_id varchar(191) NOT NULL,
  hostname text NOT NULL,
  tunnel_id varchar(191),
  tunnel_name text NOT NULL,
  dns_record_id varchar(191),
  ready_at varchar(64),
  created_at varchar(64) NOT NULL,
  updated_at varchar(64) NOT NULL,
  CONSTRAINT relay_managed_endpoint_allocations_pkey PRIMARY KEY (user_id, environment_id)
);

CREATE UNIQUE INDEX idx_relay_managed_endpoint_allocations_hostname
  ON public.relay_managed_endpoint_allocations (hostname);

CREATE UNIQUE INDEX idx_relay_managed_endpoint_allocations_tunnel_name
  ON public.relay_managed_endpoint_allocations (tunnel_name);

CREATE TABLE public.relay_managed_tunnel_limits (
  user_id varchar(191) PRIMARY KEY,
  max_tunnels integer NOT NULL,
  created_at varchar(64) NOT NULL,
  updated_at varchar(64) NOT NULL
);

CREATE TABLE public.relay_environment_credentials (
  credential_id varchar(64) PRIMARY KEY,
  environment_id varchar(191) NOT NULL,
  environment_public_key text NOT NULL,
  credential_hash varchar(191) NOT NULL,
  revoked_at varchar(64),
  created_at varchar(64) NOT NULL,
  updated_at varchar(64) NOT NULL
);

CREATE UNIQUE INDEX idx_relay_environment_credentials_hash
  ON public.relay_environment_credentials (credential_hash);

CREATE INDEX idx_relay_environment_credentials_environment
  ON public.relay_environment_credentials (environment_id, revoked_at);

CREATE INDEX idx_relay_environment_credentials_environment_key
  ON public.relay_environment_credentials (
    environment_id,
    environment_public_key,
    revoked_at
  );

CREATE TABLE public.relay_agent_activity_rows (
  environment_id varchar(191) NOT NULL,
  environment_public_key text NOT NULL,
  thread_id varchar(191) NOT NULL,
  state_json jsonb NOT NULL,
  updated_at varchar(64) NOT NULL,
  created_at varchar(64) NOT NULL,
  CONSTRAINT relay_agent_activity_rows_pkey PRIMARY KEY (
    environment_id,
    environment_public_key,
    thread_id
  )
);

CREATE INDEX idx_relay_agent_activity_rows_updated
  ON public.relay_agent_activity_rows (updated_at);

CREATE TABLE public.relay_delivery_attempts (
  id varchar(36) PRIMARY KEY,
  created_at varchar(64) NOT NULL,
  user_id varchar(255),
  environment_id varchar(191),
  thread_id varchar(191),
  device_id varchar(255),
  kind varchar(64) NOT NULL,
  source_job_id varchar(64),
  token_suffix varchar(16),
  apns_status integer,
  apns_reason text,
  apns_id varchar(128),
  transport_error text
);

CREATE INDEX idx_relay_delivery_attempts_environment
  ON public.relay_delivery_attempts (environment_id, thread_id, created_at);

CREATE UNIQUE INDEX idx_relay_delivery_attempts_source_job
  ON public.relay_delivery_attempts (source_job_id);

CREATE TABLE public.relay_dpop_proofs (
  thumbprint varchar(128) NOT NULL,
  jti varchar(255) NOT NULL,
  iat integer NOT NULL,
  expires_at varchar(64) NOT NULL,
  created_at varchar(64) NOT NULL,
  CONSTRAINT relay_dpop_proofs_pkey PRIMARY KEY (thumbprint, jti)
);

CREATE INDEX idx_relay_dpop_proofs_expires_at
  ON public.relay_dpop_proofs (expires_at);

COMMIT;
