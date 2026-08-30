CREATE SCHEMA IF NOT EXISTS collab;

CREATE TABLE IF NOT EXISTS collab.schema_migrations (
  version varchar(128) PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collab.documents (
  id uuid PRIMARY KEY,
  company_id varchar(128) NOT NULL,
  organization_id varchar(128),
  owner_user_id varchar(128) NOT NULL,
  name varchar(200) NOT NULL,
  engine varchar(32) NOT NULL CHECK (engine IN ('onlyoffice', 'custom')),
  access_mode varchar(32) NOT NULL CHECK (access_mode IN ('members', 'company_public')),
  status varchar(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  access_version bigint NOT NULL DEFAULT 1 CHECK (access_version > 0),
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  current_version_id uuid,
  source_object_key text,
  allow_download boolean NOT NULL DEFAULT false,
  storage_limit_bytes bigint CHECK (storage_limit_bytes IS NULL OR storage_limit_bytes >= 1024),
  created_by varchar(128) NOT NULL,
  updated_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS collab_documents_company_status_idx
  ON collab.documents (company_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS collab_documents_owner_idx
  ON collab.documents (company_id, owner_user_id, status);

CREATE TABLE IF NOT EXISTS collab.document_members (
  document_id uuid NOT NULL REFERENCES collab.documents(id) ON DELETE CASCADE,
  user_id varchar(128) NOT NULL,
  role varchar(32) NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  status varchar(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  can_download boolean NOT NULL DEFAULT false,
  granted_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS collab_document_members_user_idx
  ON collab.document_members (user_id, status);

CREATE TABLE IF NOT EXISTS collab.document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES collab.documents(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  revision bigint NOT NULL CHECK (revision >= 0),
  object_key text NOT NULL,
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  label varchar(100) NOT NULL,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_from_version_id uuid,
  UNIQUE (document_id, version_no)
);

CREATE INDEX IF NOT EXISTS collab_document_versions_document_idx
  ON collab.document_versions (document_id, version_no DESC);

CREATE TABLE IF NOT EXISTS collab.document_operations (
  document_id uuid NOT NULL REFERENCES collab.documents(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  client_id varchar(128) NOT NULL,
  client_sequence bigint NOT NULL CHECK (client_sequence > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  operation_type varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  actor_user_id varchar(128) NOT NULL,
  actor_session_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision),
  UNIQUE (document_id, client_id, client_sequence)
);

CREATE INDEX IF NOT EXISTS collab_document_operations_created_idx
  ON collab.document_operations (document_id, created_at);

CREATE TABLE IF NOT EXISTS collab.document_audit_events (
  id bigserial PRIMARY KEY,
  document_id uuid,
  company_id varchar(128) NOT NULL,
  actor_user_id varchar(128),
  action varchar(64) NOT NULL,
  request_id varchar(128),
  revision bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_document_audit_document_idx
  ON collab.document_audit_events (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_document_audit_company_idx
  ON collab.document_audit_events (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collab.document_share_links (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES collab.documents(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  permission varchar(32) NOT NULL CHECK (permission IN ('viewer')),
  expires_at timestamptz,
  revoked_at timestamptz,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  allow_download boolean NOT NULL DEFAULT false,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_document_share_links_document_idx
  ON collab.document_share_links (document_id, revoked_at, expires_at);
