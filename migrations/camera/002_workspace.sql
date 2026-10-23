-- 视频业务组织独立于平台 Organization，Company 仍是不可绕过的租户边界。
BEGIN;
CREATE TABLE IF NOT EXISTS camera.organizations (
  id uuid PRIMARY KEY,
  company_id varchar(128) NOT NULL,
  name varchar(100) NOT NULL,
  type varchar(20) NOT NULL CHECK (type IN ('company','organization','store')),
  parent_id uuid,
  code varchar(64) NOT NULL DEFAULT '',
  rank integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  remark varchar(500) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,parent_id) REFERENCES camera.organizations(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS camera_org_code ON camera.organizations(company_id,code) WHERE code<>'';
CREATE INDEX IF NOT EXISTS camera_org_parent ON camera.organizations(company_id,parent_id);
ALTER TABLE camera.devices ADD COLUMN IF NOT EXISTS organization_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='camera_device_organization' AND conrelid='camera.devices'::regclass) THEN
    ALTER TABLE camera.devices ADD CONSTRAINT camera_device_organization
      FOREIGN KEY(company_id,organization_id) REFERENCES camera.organizations(company_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS camera_devices_org ON camera.devices(company_id,organization_id);
CREATE TABLE IF NOT EXISTS camera.members (
  id uuid PRIMARY KEY,
  company_id varchar(128) NOT NULL,
  user_id varchar(128) NOT NULL,
  organization_id uuid NOT NULL,
  include_descendants boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  remark varchar(500) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,user_id),
  FOREIGN KEY(company_id,organization_id) REFERENCES camera.organizations(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS camera.views (
  id uuid PRIMARY KEY,
  company_id varchar(128) NOT NULL,
  user_id varchar(128) NOT NULL,
  name varchar(100) NOT NULL,
  screens integer NOT NULL CHECK(screens BETWEEN 1 AND 16),
  devices jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,user_id,name)
);
CREATE TABLE IF NOT EXISTS camera.audit (
  id uuid PRIMARY KEY,
  company_id varchar(128) NOT NULL,
  actor_id varchar(128) NOT NULL,
  action varchar(64) NOT NULL,
  target_id varchar(128) NOT NULL,
  summary varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS camera_audit_tenant_time ON camera.audit(company_id,created_at DESC);
COMMIT;
