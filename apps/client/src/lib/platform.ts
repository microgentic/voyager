// Platform detection + the small set of native affordances the web layer needs.
// Anything deeper (secure storage, the MLS core) lands as Tauri commands and is
// reached from here so the rest of the app stays platform-agnostic.

export function isTauri(): boolean {
	return (
		typeof window !== 'undefined' &&
		(Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__))
	);
}

export function platformKind(): 'desktop' | 'mobile' | 'web' {
	if (!isTauri()) return 'web';
	return mobileOs() ? 'mobile' : 'desktop';
}

/** Coarse value for the backend `device.platform` field. */
export function devicePlatform(): string {
	if (!isTauri()) return 'web';
	return mobileOs() ?? 'desktop';
}

/** A friendly device label like "Chrome · macOS" for the devices list. */
export function deviceLabel(): string {
	const os = detectedOs();
	const shell = isTauri() ? (mobileOs() ? 'Mobile app' : 'Desktop app') : 'Web';
	if (typeof navigator === 'undefined') return shell;
	const ua = navigator.userAgent;
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Chrome\//.test(ua)
			? 'Chrome'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Safari\//.test(ua)
					? 'Safari'
					: 'Browser';
	return isTauri() ? `${shell} · ${os}` : `${browser} · ${os}`;
}

export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		try {
			const { openUrl } = await import('@tauri-apps/plugin-opener');
			await openUrl(url);
			return;
		} catch {
			// fall through to web behavior
		}
	}
	if (typeof window !== 'undefined') {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
}

function mobileOs(): 'ios' | 'android' | null {
	if (typeof navigator === 'undefined') return null;
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
	if (/Android/.test(ua)) return 'android';
	return null;
}

function detectedOs(): string {
	if (typeof navigator === 'undefined') return 'Unknown OS';
	const ua = navigator.userAgent;
	return /iPhone|iPad|iPod/.test(ua)
		? 'iOS'
		: /Android/.test(ua)
			? 'Android'
			: /Mac OS X|Macintosh/.test(ua)
				? 'macOS'
				: /Windows/.test(ua)
					? 'Windows'
					: /Linux/.test(ua)
						? 'Linux'
						: 'Unknown OS';
}
