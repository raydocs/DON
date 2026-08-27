-- Cloudflare D1 Schema for DON Sync & Selective Sync Management

-- 1. Users table (for team / multi-device auth)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- 'admin', 'member'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. Cloud-hosted Profiles Catalog (Metadata for selective sync)
CREATE TABLE IF NOT EXISTS cloud_profiles (
  id TEXT PRIMARY KEY, -- Profile UUID
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  browser TEXT NOT NULL DEFAULT 'wayfern',
  version TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array of tags
  note TEXT,
  proxy_summary TEXT, -- e.g. "socks5://127.0.0.1:1080" or label
  wayfern_config_summary TEXT, -- Screen, OS, fingerprint summary
  size_bytes INTEGER NOT NULL DEFAULT 0,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 3. Profile Permissions / Assignments for Selective Sync
-- Specifies which users/devices can see and sync which profiles
CREATE TABLE IF NOT EXISTS profile_assignments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES cloud_profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  can_write INTEGER NOT NULL DEFAULT 1, -- 1: read/write sync, 0: read-only
  is_pinned INTEGER NOT NULL DEFAULT 0, -- Auto-sync flag if preferred
  assigned_at INTEGER NOT NULL,
  UNIQUE(profile_id, user_id)
);

-- 4. Device Leases (Session isolation: prevents 2 devices running the same profile at once)
CREATE TABLE IF NOT EXISTS profile_leases (
  profile_id TEXT PRIMARY KEY REFERENCES cloud_profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  leased_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 5. Sync Event Logs (for audits and client change detection)
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'upload', 'delete', 'download', 'acquire_lease'
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_profiles_owner ON cloud_profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_profile_assignments_user ON profile_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_profile ON sync_events(profile_id);
