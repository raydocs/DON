export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  SYNC_TOKEN?: string;
  SIGNING_SECRET?: string;
  JWT_PUBLIC_KEY?: string;
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
