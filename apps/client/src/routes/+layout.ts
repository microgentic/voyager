// Voyager is a single-page application: no SSR, no prerendering. Everything
// renders client-side so the same bundle runs on the web and inside Tauri.
export const ssr = false;
export const prerender = false;
export const csr = true;
export const trailingSlash = 'ignore';
