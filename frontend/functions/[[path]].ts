// SPA fallback Pages Function — defensive belt for `_redirects`.
//
// Why this exists:
//   The Cloudflare Pages git-integration auto-build for this project
//   intermittently omits `_redirects` from the deploy output (see Task #6
//   in the session log). When that file is missing, every non-`/` SPA
//   route (e.g. `/scm/categories`, `/scm/products`, `/system-health`)
//   returns a 404 page instead of the React shell. We've had to
//   re-deploy manually four times today to bring the site back.
//
//   Pages Functions, on the other hand, are read straight out of
//   `frontend/functions/` by Cloudflare every deploy — they don't depend
//   on Vite copying any file out of `public/`. So as long as the
//   functions directory itself reaches the deploy, this handler runs.
//
// What this handler does:
//   For any request that doesn't match a real static asset, serve the
//   pre-built `index.html`. The React Router on the client picks the
//   path up from `window.location` and renders the right page.
//
// Routing precedence (Cloudflare Pages):
//   1. Static assets that exist on disk (CSS, JS, images, the asset
//      pipeline's own /assets/* hashes) — served directly, this Function
//      never runs.
//   2. `_redirects` rules — when the file is present, the `/* /index.html
//      200` rule fires first, and this Function never runs.
//   3. Pages Functions — this `[[path]]` catchall is the final tier; it
//      only sees requests that fell through both of the above.
//
// Edge cases:
//   · A request for a real-looking file path that doesn't exist (e.g.
//     /robots.txt when we haven't shipped one) — we let CF Pages return
//     the 404 instead of serving `index.html`, otherwise broken `<img>`
//     tags would render the React shell.
//
// This file uses self-contained types so we don't have to add
// `@cloudflare/workers-types` to the frontend's devDependencies just
// for one file. Cloudflare types-checks Functions during deploy.

interface PagesContext {
  request: Request;
  env: { ASSETS: { fetch: (request: Request | string | URL) => Promise<Response> } };
  next: () => Promise<Response>;
}

export const onRequest = async ({ request, env, next }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);

  // File-looking paths (anything with a dot in the last segment) are
  // explicit asset requests — let the static-asset 404 reach the browser
  // so that broken <img> / fetch() calls show up as 404s instead of HTML.
  const lastSegment = url.pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) {
    return next();
  }

  // Everything else is a SPA route. Serve the shell.
  return env.ASSETS.fetch(new URL("/index.html", request.url));
};
