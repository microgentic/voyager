# Cloudflare Pages Web Deployment

This project deploys the Voyager web client to Cloudflare Pages through GitHub Actions.

## Pages Project

- Project name: `voyager-web`
- Production branch: `main`
- Production URL after the first successful deployment: `https://voyager-web.pages.dev/`
- API target baked into the web build: `https://voyager-api-dev.microgentic-voyager.workers.dev`

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

## Required GitHub Secrets

The workflow expects these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The token must include Cloudflare Pages edit access for the account. The existing Worker/D1 token may need to be updated if it was created before Pages deployment was added.
