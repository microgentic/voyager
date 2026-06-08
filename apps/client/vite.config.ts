import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and ignores its own source tree for HMR.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// prevent vite from obscuring rust errors
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 1421
				}
			: undefined,
		// Dev-only: proxy API calls to the local Worker so the browser stays
		// same-origin (no CORS needed). Set VITE_API_BASE_URL="" to use this.
		proxy: {
			'/v1': { target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8787', changeOrigin: true },
			'/health': { target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8787', changeOrigin: true }
		},
		watch: {
			// tell vite to ignore watching `src-tauri`
			ignored: ['**/src-tauri/**']
		}
	}
});
