export function bindVisualViewportVars(): () => void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;

	const root = document.documentElement;
	let frame = 0;
	let timers: number[] = [];

	function apply(): void {
		frame = 0;
		const viewport = window.visualViewport;
		const top = Math.max(0, viewport?.offsetTop ?? 0);
		const left = Math.max(0, viewport?.offsetLeft ?? 0);
		const width = viewport?.width ?? window.innerWidth;
		const height = viewport?.height ?? window.innerHeight;

		root.style.setProperty('--vv-top', `${top}px`);
		root.style.setProperty('--vv-left', `${left}px`);
		root.style.setProperty('--vv-width', `${width}px`);
		root.style.setProperty('--vv-height', `${height}px`);
	}

	function schedule(): void {
		if (frame) return;
		frame = window.requestAnimationFrame(apply);
	}

	function scheduleFocusSettle(): void {
		schedule();
		for (const delay of [50, 150, 300]) {
			timers.push(window.setTimeout(schedule, delay));
		}
	}

	apply();
	window.visualViewport?.addEventListener('resize', schedule);
	window.visualViewport?.addEventListener('scroll', schedule);
	window.addEventListener('resize', schedule);
	window.addEventListener('orientationchange', scheduleFocusSettle);
	document.addEventListener('focusin', scheduleFocusSettle);
	document.addEventListener('focusout', scheduleFocusSettle);

	return () => {
		if (frame) window.cancelAnimationFrame(frame);
		for (const timer of timers) window.clearTimeout(timer);
		timers = [];
		window.visualViewport?.removeEventListener('resize', schedule);
		window.visualViewport?.removeEventListener('scroll', schedule);
		window.removeEventListener('resize', schedule);
		window.removeEventListener('orientationchange', scheduleFocusSettle);
		document.removeEventListener('focusin', scheduleFocusSettle);
		document.removeEventListener('focusout', scheduleFocusSettle);
	};
}
