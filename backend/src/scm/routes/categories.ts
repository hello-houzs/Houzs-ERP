import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

// TODO(Task 18): add categories.test.ts when R2 mocking is set up.

export const categoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

categoriesApi.use('*', supabaseAuth);

const ADMIN_ROLES = new Set(['admin', 'coordinator']);

categoriesApi.post('/:id/hero-image', async (c) => {
  const userId = c.get('user').id;
  const supabase = c.get('supabase');

  const staffRes = await supabase.from('staff').select('role').eq('id', userId).maybeSingle();
  if (!staffRes.data || !ADMIN_ROLES.has(staffRes.data.role)) {
    return c.json({ error: 'forbidden' }, 403);
  }

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
  const userId = c.get('user').id;
  const supabase = c.get('supabase');

  const staffRes = await supabase.from('staff').select('role').eq('id', userId).maybeSingle();
  if (!staffRes.data || !ADMIN_ROLES.has(staffRes.data.role)) {
    return c.json({ error: 'forbidden' }, 403);
  }

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
  const userId = c.get('user').id;
  const supabase = c.get('supabase');

  const staffRes = await supabase.from('staff').select('role').eq('id', userId).maybeSingle();
  if (!staffRes.data || !ADMIN_ROLES.has(staffRes.data.role)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = c.req.param('id');
  const row = await supabase.from('categories').select('hero_image_key').eq('id', id).maybeSingle();
  if (row.data?.hero_image_key) {
    await c.env.PUBLIC_ASSETS.delete(row.data.hero_image_key);
  }
  await supabase.from('categories').update({ hero_image_key: null }).eq('id', id);

  return c.json({ ok: true });
});
