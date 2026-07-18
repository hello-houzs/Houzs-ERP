/**
 * The one place that answers "what origin do I prefix onto /api/*".
 *
 * This constant was copy-pasted into seven modules, each re-deriving it with
 * the same two-branch expression. Native adds a THIRD branch, and a rule that
 * only lives in a comment does not survive being pasted an eighth time.
 *
 * Web PROD resolves to the empty string: /api/* is same-origin and the Pages
 * Function (functions/api/[[path]].ts) proxies it to the Worker. Calling the
 * Worker's *.workers.dev origin directly is NOT an acceptable fallback --
 * Malaysian mobile carriers intermittently block that domain, which is what
 * stranded field staff at login on 2026-07-09.
 *
 * Native has no same-origin to be relative to (the page is capacitor://
 * localhost), so it needs an absolute origin. It points at the PAGES origin,
 * not the Worker, so native traffic keeps going through the same proxy and
 * inherits the same carrier fix. Worker CORS is already `*` and auth is a
 * bearer header rather than a cookie, so cross-origin from the shell is fine.
 */

import { IS_NATIVE } from './native';

const PAGES_ORIGIN = 'https://erp.houzscentury.com';
const DEV_WORKER_ORIGIN = 'https://autocount-sync-api.houzs-erp.workers.dev';

/* `||` not `??`, load-bearing: CI inlines VITE_API_URL as an EMPTY STRING when
   the repo var is unset, and `'' ?? fallback` keeps the empty string. */
export const API_ORIGIN: string =
  (import.meta.env.VITE_API_URL as string) ||
  (IS_NATIVE ? PAGES_ORIGIN : import.meta.env.PROD ? '' : DEV_WORKER_ORIGIN);
