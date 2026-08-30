ALTER TABLE collab.documents
  ADD COLUMN IF NOT EXISTS storage_limit_bytes bigint
  CHECK (storage_limit_bytes IS NULL OR storage_limit_bytes >= 1024);
