import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Voyager client is a pure SPA: a single static bundle that runs in the browser
 * (web) and inside the Tauri WebView (desktop/mobile). adapter-static with an
 * index.html fallback lets client-side routing resolve every path.
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		alias: {
			$lib: 'src/lib'
		}
	}
};

export default config;
