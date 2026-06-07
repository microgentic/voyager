export type Theme = 'dark' | 'light';

const THEME_KEY = 'voyager.theme';
// Multi-pane (desktop) vs single-pane (mobile) shell threshold.
const WIDE_QUERY = '(min-width: 900px)';

class UiStore {
	theme = $state<Theme>('dark');
	/** True on desktop-width viewports: show the conversation list + thread together. */
	isWide = $state(true);

	constructor() {
		if (typeof window === 'undefined') return;
		const stored = localStorage.getItem(THEME_KEY);
		this.theme =
			stored === 'light' || stored === 'dark'
				? stored
				: window.matchMedia('(prefers-color-scheme: light)').matches
					? 'light'
					: 'dark';

		const mq = window.matchMedia(WIDE_QUERY);
		this.isWide = mq.matches;
		mq.addEventListener('change', (e) => (this.isWide = e.matches));
		this.applyTheme();
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		try {
			localStorage.setItem(THEME_KEY, theme);
		} catch {
			/* ignore */
		}
		this.applyTheme();
	}

	toggleTheme(): void {
		this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
	}

	private applyTheme(): void {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		root.classList.toggle('dark', this.theme === 'dark');
		root.dataset.theme = this.theme;
	}
}

export const ui = new UiStore();
