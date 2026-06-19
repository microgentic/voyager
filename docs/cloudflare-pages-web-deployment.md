# Cloudflare Pages Web Deployment

This project deploys the Voyager web client to Cloudflare Pages through GitHub Actions.

## Pages Project

- Project name: `voyager-web`
- Production branch: `main`
- Production URL after the first successful deployment: `https://voyager-web.pages.dev/`
- API target baked into the web build: `https://voyager-api-dev.microgentic-voyager.workers.dev`
- Required API CORS origin: `https://voyager-web.pages.dev`

## CI/CD Flow

The `.github/workflows/deploy-pages.yml` workflow:

- installs root dependencies for Wrangler;
- installs the client dependencies;
- runs the Svelte client type check;
- builds the static SvelteKit SPA from `apps/client`;
- deploys pull requests as Cloudflare Pages preview deployments;
- deploys `main` pushes as the production Pages deployment.

## Static Hosting Notes

- `apps/client/static/_redirects` routes all browser paths to `index.html` so SvelteKit client-side routing works on refresh and direct links.
- `apps/client/static/_headers` adds baseline browser hardening headers.
- `wrangler.jsonc` includes the Pages origin in `CORS_ALLOWED_ORIGINS` so browser requests from Pages can call the Worker API.

## Required GitHub Secrets

The workflow expects these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_ACCOUNT_ID` should be `673a41a654ed01f9bf90d253ae426a18` for the current Voyager Cloudflare account.

`CLOUDFLARE_API_TOKEN` must include account-level Cloudflare Pages edit access for that account. The existing Worker/D1 token may need to be updated or replaced if it was created before Pages deployment was added. A Pages permission failure appears in CI as a successful build followed by a `wrangler pages deploy` authentication error.
