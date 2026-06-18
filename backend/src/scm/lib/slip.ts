import type { R2Bucket } from '@cloudflare/workers-types';

export interface SlipEnv {
  // Optional so the route's c.env (Houzs Env) is assignable; slipBindings below
  // guards each (throws if unset) for a clear runtime error.
  SLIPS?: R2Bucket;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_BUCKET_NAME?: string;
}

export interface SlipBindings {
  bucket: R2Bucket;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucketName: string;
}

export function slipBindings(env: SlipEnv): SlipBindings {
  if (!env.SLIPS) throw new Error('R2 binding SLIPS not configured');
  if (!env.R2_ACCESS_KEY_ID) throw new Error('R2_ACCESS_KEY_ID not configured');
  if (!env.R2_SECRET_ACCESS_KEY) throw new Error('R2_SECRET_ACCESS_KEY not configured');
  if (!env.R2_ENDPOINT) throw new Error('R2_ENDPOINT not configured');
  if (!env.R2_BUCKET_NAME) throw new Error('R2_BUCKET_NAME not configured');
  return {
    bucket: env.SLIPS,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
    bucketName: env.R2_BUCKET_NAME,
  };
}

export function hashesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isExpired(isoTimestamp: string): boolean {
  return new Date(isoTimestamp).getTime() < Date.now();
}

export function expiresInOneHour(now = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}
