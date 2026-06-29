import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { hasHouzsPerm } from '../lib/houzs-perms';
import type { Env, Variables } from '../env';

// TODO(Task 18): add categories.test.ts when R2 mocking is set up.

export const categoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

categoriesApi.use('*', supabaseAuth);

// Houzs-flavoured: gate on the flat permission key `scm.config.write` against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row, so the original gate
// trivially passed for everyone).

categoriesApi.post('/:id/hero-image', async (c) => {
  if (!hasHouzsPerm(c, 'scm.config.write')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');

  const id = c.req.param('id');
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.startsWith('image/jpeg') && !contentType.startsWith('image/png')) {
    return c.json({ error: 'unsupported_type', expected: 'image/jpeg or image/png' }, 400);
  }

  const blob = await c.req.arrayBuffer();
  if (blob.byteLength > 4 * 1024 * 1024) {
    return c.json({ error: 'too_large', max: '4MB' }, 413);
  }

  const ext = contentType.endsWith('jpeg') ? 'jpg' : 'png';
  const key = `category-heroes/${id}.${ext}`;

  // TODO(Task 18): PUBLIC_ASSETS R2 binding requires the 2990s-public bucket
  // to be provisioned in Cloudflare dashboard + bound in wrangler.toml +
  // VITE_R2_PUBLIC_URL set in .env. Until then this endpoint will error at
  // runtime with "env.PUBLIC_ASSETS is undefined" — that's expected.
  await c.env.PUBLIC_ASSETS.put(key, blob, { httpMetadata: { contentType } });
  await supabase.from('categories').update({ hero_image_key: key }).eq('id', id);

  return c.json({ ok: true, key });
});

// Proxy GET — streams the stored hero image from the PUBLIC_ASSETS R2 bucket.
// Mirrors the SO/consignment per-line photo proxy: auth-gated (the whole
// /api/scm tree is owner-gated; this also requires an admin/coordinator staff
// role like the put/delete here), Content-Type set from the stored object,
// 404 when the category has no hero or the object is missing.
categoriesApi.get('/:id/hero-image', async (c) => {
  if (!hasHouzsPerm(c, 'scm.config.write')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');

  if (!c.env.PUBLIC_ASSETS) {
    return c.json({ error: 'public_assets_not_configured' }, 500);
  }

  const id = c.req.param('id');
  const row = await supabase.from('categories').select('hero_image_key').eq('id', id).maybeSingle();
  const heroKey = (row.data as { hero_image_key?: string | null } | null)?.hero_image_key ?? null;
  if (!heroKey) return c.json({ error: 'hero_not_set' }, 404);

  const obj = await c.env.PUBLIC_ASSETS.get(heroKey);
  if (!obj) return c.json({ error: 'hero_not_found_in_r2' }, 404);

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'private, max-age=3600',
    },
  });
});

categoriesApi.delete('/:id/hero-image', async (c) => {
  if (!hasHouzsPerm(c, 'scm.config.write')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');

  const id = c.req.param('id');
  const row = await supabase.from('categories').select('hero_image_key').eq('id', id).maybeSingle();
  if (row.data?.hero_image_key) {
    await c.env.PUBLIC_ASSETS.delete(row.data.hero_image_key);
  }
  await supabase.from('categories').update({
    hero_image_key: null,
    hero_focal_x: null,
    hero_focal_y: null,
    hero_alt: null,
  }).eq('id', id);

  return c.json({ ok: true });
});

// ============================================================================
// publicCategoriesApi — mounted at /api/scm/categories (NO /admin prefix).
// Read-side surface for the 4a Categories page and HeroImageEditor:
//   GET  /                  → { categories: [...] }
//   GET  /:id/hero-meta     → { url, focal_x, focal_y, alt }
//   PATCH /:id/hero-meta    → updates focal + alt (admin gated)
//   GET  /:id/hero-blob     → PUBLIC proxy that streams the R2 hero image
//                             (no auth — needed for <img src> tags). Key is
//                             validated against the stored hero_image_key so
//                             a guessed url can't leak unrelated R2 objects.
// ============================================================================

export const publicCategoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

// PUBLIC proxy registered BEFORE the auth middleware (same pattern as the
// product-models photo proxy). Browser <img> tags don't send Bearer headers.
publicCategoriesApi.get('/:id/hero-blob', async (c) => {
  if (!c.env.PUBLIC_ASSETS) {
    return c.json({ error: 'public_assets_not_configured' }, 500);
  }
  const id = c.req.param('id');
  // Use a service-role client since no JWT is on the request.
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await sb
    .schema('scm')
    .from('categories')
    .select('hero_image_key')
    .eq('id', id)
    .maybeSingle();
  const heroKey = (data as { hero_image_key?: string | null } | null)?.hero_image_key ?? null;
  if (!heroKey) return c.json({ error: 'hero_not_set' }, 404);

  // Defensive: the stored key must live under the category-heroes/ prefix
  // we minted in POST. Stops a tampered DB row from streaming an arbitrary
  // R2 object (the bucket is shared with SO photos under a different prefix).
  if (!heroKey.startsWith('category-heroes/')) {
    return c.json({ error: 'hero_key_invalid' }, 400);
  }

  const obj = await c.env.PUBLIC_ASSETS.get(heroKey);
  if (!obj) return c.json({ error: 'hero_not_found_in_r2' }, 404);

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      // Public, cacheable. Reload after upload is handled client-side by
      // invalidating the meta query (the URL is the same; cache will refresh
      // on next request — operators rarely need sub-second re-fetch).
      'cache-control': 'public, max-age=3600',
    },
  });
});

// Everything below requires auth.
publicCategoriesApi.use('*', supabaseAuth);

// GET / — list categories with the hero meta fields the page needs.
// Surfaces a relative-url hero_url that points at the public hero-blob proxy
// above, so the Categories grid + drawer don't need to know about R2 keys.
publicCategoriesApi.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, icon, sort_order, hero_image_key, hero_focal_x, hero_focal_y, hero_alt')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const categories = (data ?? []).map((r) => {
    const row = r as {
      id: string;
      label: string;
      icon: string;
      sort_order: number;
      hero_image_key: string | null;
      hero_focal_x: number | null;
      hero_focal_y: number | null;
      hero_alt: string | null;
    };
    return {
      id: row.id,
      name: row.label,           // align with the frontend's CategoryRow.name
      slug: row.icon,            // icon doubles as the slug-ish identifier
      hero_image_key: row.hero_image_key,
      // /api/scm prefix is added by the worker's mount; this relative path
      // round-trips through authedFetch + <img src> (the latter via public
      // hero-blob — no auth needed). Null when no cover set.
      hero_url: row.hero_image_key
        ? `/api/scm/categories/${row.id}/hero-blob`
        : null,
    };
  });
  return c.json({ categories });
});

// GET /:id/hero-meta — what the HeroImageEditor reads on open.
publicCategoriesApi.get('/:id/hero-meta', async (c) => {
  const supabase = c.get('supabase');
  const id = c.req.param('id');
  const { data, error } = await supabase
    .from('categories')
    .select('hero_image_key, hero_focal_x, hero_focal_y, hero_alt')
    .eq('id', id)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as {
    hero_image_key: string | null;
    hero_focal_x: number | null;
    hero_focal_y: number | null;
    hero_alt: string | null;
  };
  return c.json({
    url: row.hero_image_key
      ? `/api/scm/categories/${id}/hero-blob`
      : null,
    // Default centred when null — the editor needs concrete numbers to
    // position the crosshair.
    focal_x: row.hero_focal_x ?? 0.5,
    focal_y: row.hero_focal_y ?? 0.5,
    alt: row.hero_alt ?? '',
  });
});

// PATCH /:id/hero-meta — focal + alt update. Admin-only.
publicCategoriesApi.patch('/:id/hero-meta', async (c) => {
  if (!hasHouzsPerm(c, 'scm.config.write')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  const supabase = c.get('supabase');
  const id = c.req.param('id');

  const patch: Record<string, unknown> = {};
  if (body.focal_x !== undefined) {
    const n = Number(body.focal_x);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return c.json({ error: 'focal_x_out_of_range', expected: '0..1' }, 400);
    }
    patch.hero_focal_x = n;
  }
  if (body.focal_y !== undefined) {
    const n = Number(body.focal_y);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return c.json({ error: 'focal_y_out_of_range', expected: '0..1' }, 400);
    }
    patch.hero_focal_y = n;
  }
  if (body.alt !== undefined) {
    const s = String(body.alt ?? '').trim();
    if (s.length > 200) {
      return c.json({ error: 'alt_too_long', max: 200 }, 400);
    }
    patch.hero_alt = s || null;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'nothing_to_patch' }, 400);
  }

  const { error } = await supabase.from('categories').update(patch).eq('id', id);
  if (error) return c.json({ error: 'patch_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
