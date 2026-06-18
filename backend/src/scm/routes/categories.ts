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
