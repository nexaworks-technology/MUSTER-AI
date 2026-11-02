import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/config/env";
import type { TenantContext } from "@/lib/db/scoped";

/**
 * S3-compatible object storage (MinIO locally, ARCHITECTURE §7.6). Every object key lives under
 * `ws/<workspaceId>/`, built here from the caller's context — callers never pass a full key, so
 * one workspace cannot name another's files.
 */
export interface StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function workspaceObjectKey(ctx: TenantContext, ...segments: string[]): string {
  if (segments.length === 0) throw new Error("An object key needs at least one segment");
  for (const s of [ctx.workspaceId, ...segments]) {
    if (!SAFE_SEGMENT.test(s) || s === "." || s === "..")
      throw new Error("Unsafe object key segment");
  }
  return ["ws", ctx.workspaceId, ...segments].join("/");
}

export function createStorage(config: StorageConfig) {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint), // MinIO and most S3-compatible stores
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const Bucket = config.bucket;

  return {
    /** Creates the bucket if missing (local development and tests). */
    async ensureBucket(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },
    async put(
      ctx: TenantContext,
      segments: string[],
      body: Uint8Array | string,
      contentType: string,
    ) {
      const Key = workspaceObjectKey(ctx, ...segments);
      await client.send(
        new PutObjectCommand({ Bucket, Key, Body: body, ContentType: contentType }),
      );
      return { key: Key };
    },
    async get(ctx: TenantContext, segments: string[]): Promise<Uint8Array> {
      const Key = workspaceObjectKey(ctx, ...segments);
      const res = await client.send(new GetObjectCommand({ Bucket, Key }));
      return res.Body!.transformToByteArray();
    },
    /** Short-lived download link, always as an attachment (never rendered inline on our origin). */
    signedDownloadUrl(
      ctx: TenantContext,
      segments: string[],
      filename: string,
      expiresInSeconds = 300,
    ) {
      const Key = workspaceObjectKey(ctx, ...segments);
      const safeName = filename.replace(/[^A-Za-z0-9._ -]/g, "_");
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key,
          ResponseContentDisposition: `attachment; filename="${safeName}"`,
        }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;

let storage: Storage | undefined;

export function getStorage(): Storage {
  const e = env();
  storage ??= createStorage({
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
  });
  return storage;
}
