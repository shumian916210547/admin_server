-- IPC 私有领域表，不暴露给通用 Parse CRUD；company_id 始终取服务端会话。
CREATE SCHEMA IF NOT EXISTS camera;
CREATE TABLE IF NOT EXISTS camera.devices (
  id uuid PRIMARY KEY,
  company_id varchar(128) NOT NULL,
  name varchar(100) NOT NULL,
  brand varchar(32) NOT NULL,
  host inet NOT NULL,
  onvif_port integer NOT NULL CHECK (onvif_port BETWEEN 1 AND 65535),
  rtsp_port integer NOT NULL CHECK (rtsp_port BETWEEN 1 AND 65535),
  rtsp_path varchar(1000) NOT NULL,
  credentials text NOT NULL,
  location varchar(200) NOT NULL DEFAULT '',
  cover bytea,
  cover_type varchar(32),
  recording_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, host, rtsp_port, rtsp_path)
);
CREATE INDEX IF NOT EXISTS camera_devices_company ON camera.devices(company_id);
