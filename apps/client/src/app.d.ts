// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	// Injected by Tauri when running inside the desktop/mobile WebView.
	interface Window {
		__TAURI__?: unknown;
		__TAURI_INTERNALS__?: unknown;
	}
}

export {};
