export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  SYNC_TOKEN?: string;
  SIGNING_SECRET?: string;
  // Cloudflare Zero Trust Access (optional passwordless admin login).
  // When set, the `cf-access-jwt-assertion` / `CF_Authorization` JWT is
  // cryptographically verified against the team JWKS with iss/aud checks.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  // Comma-separated allow-list of admin emails admitted via verified
  // Cloudflare Access JWTs. No hard-coded default: leave unset to disable
  // Access-based admin login (master-token / D1-admin paths still work).
  ADMIN_EMAILS?: string;
  // DEVELOPMENT ONLY. When exactly "true", a client-supplied
  // `x-admin-email` header is honored as a dev/testing bypass. NEVER enable
  // in production (must not appear in wrangler.toml [vars]).
  ADMIN_DEV_BYPASS?: string;
}

export interface UserContext {
  userId: string;
  username: string;
  role: "admin" | "member" | "self-hosted";
  prefix: string;
}

export interface StatRequest {
  key: string;
}

export interface StatResponse {
  exists: boolean;
  lastModified?: string;
  size?: number;
  metadata?: Record<string, string>;
}

export interface PresignUploadRequest {
  key: string;
  contentType?: string;
  expiresIn?: number;
  metadata?: Record<string, string>;
}

export interface PresignUploadResponse {
  url: string;
  expiresAt: string;
  metadata?: Record<string, string>;
}

export interface PresignDownloadRequest {
  key: string;
  expiresIn?: number;
}

export interface PresignDownloadResponse {
  url: string;
  expiresAt: string;
}

export interface PresignUploadBatchItem {
  key: string;
  contentType?: string;
}

export interface PresignUploadBatchRequest {
  items: PresignUploadBatchItem[];
  expiresIn?: number;
}

export interface PresignUploadBatchItemResponse {
  key: string;
  url: string;
  expiresAt: string;
}

export interface PresignUploadBatchResponse {
  items: PresignUploadBatchItemResponse[];
}

export interface PresignDownloadBatchRequest {
  keys: string[];
  expiresIn?: number;
}

export interface PresignDownloadBatchItemResponse {
  key: string;
  url: string;
  expiresAt: string;
}

export interface PresignDownloadBatchResponse {
  items: PresignDownloadBatchItemResponse[];
}

export interface DeleteRequest {
  key: string;
  tombstoneKey?: string;
  deletedAt?: string;
}

export interface DeleteResponse {
  deleted: boolean;
  tombstoneCreated: boolean;
}

export interface DeletePrefixRequest {
  prefix: string;
  tombstoneKey?: string;
  deletedAt?: string;
}

export interface DeletePrefixResponse {
  deletedCount: number;
  tombstoneCreated: boolean;
}

export interface ListRequest {
  prefix: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListObjectItem {
  key: string;
  lastModified: string;
  size: number;
}

export interface ListResponse {
  objects: ListObjectItem[];
  isTruncated: boolean;
  nextContinuationToken?: string | null;
}

export interface CloudProfileRecord {
  id: string;
  owner_id: string;
  name: string;
  browser: string;
  version: string;
  tags: string;
  note?: string | null;
  proxy_summary?: string | null;
  wayfern_config_summary?: string | null;
  size_bytes: number;
  manifest_version: number;
  is_deleted: number;
  created_at: number;
  updated_at: number;
}

export interface UserRecord {
  id: string;
  username: string;
  token_hash: string;
  role: "admin" | "member";
  note?: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  assigned_profiles_count?: number;
}

export interface ProfileAssignmentRecord {
  id: string;
  profile_id: string;
  user_id: string;
  can_write: number;
  is_pinned: number;
  assigned_at: number;
  username?: string;
}

export interface SyncEventRecord {
  id: number;
  profile_id: string;
  user_id: string;
  username?: string;
  profile_name?: string;
  event_type: string;
  details?: string | null;
  created_at: number;
}
