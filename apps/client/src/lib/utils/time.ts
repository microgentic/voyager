// Date helpers.
//
// The Worker emits SQLite timestamps ("YYYY-MM-DD HH:MM:SS", UTC, no zone),
// while client timestamps are ISO with a Z. parseServerDate normalizes both to
// a correct Date so message ordering and dividers don't drift by the local UTC
// offset.

const SQLITE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function parseServerDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const normalized = SQLITE_RE.test(value) ? `${value.replace(' ', 'T')}Z` : value;
	const date = new Date(normalized);
	return Number.isNaN(date.getTime()) ? null : date;
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** "14:32" */
export function formatClock(value: string | Date | null | undefined): string {
	const date = value instanceof Date ? value : parseServerDate(value);
	if (!date) return '';
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Compact stamp for conversation lists: now / 5m / 3h / Tue / 12 Jun / 12/06/24 */
export function formatRelativeShort(value: string | Date | null | undefined): string {
	const date = value instanceof Date ? value : parseServerDate(value);
	if (!date) return '';
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMin = Math.floor(diffMs / 60000);

	if (diffMin < 1) return 'now';
	if (diffMin < 60) return `${diffMin}m`;

	const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
	if (dayDiff === 0) return formatClock(date);
	if (dayDiff === 1) return 'Yesterday';
	if (dayDiff < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
	if (date.getFullYear() === now.getFullYear()) {
		return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	}
	return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** "Today" / "Yesterday" / "Monday" / "12 June 2026" for in-timeline dividers. */
export function formatDayDivider(value: string | Date | null | undefined): string {
	const date = value instanceof Date ? value : parseServerDate(value);
	if (!date) return '';
	const now = new Date();
	const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
	if (dayDiff === 0) return 'Today';
	if (dayDiff === 1) return 'Yesterday';
	if (dayDiff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
	return date.toLocaleDateString(undefined, {
		day: 'numeric',
		month: 'long',
		year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric'
	});
}

export function sameDay(a: Date | null, b: Date | null): boolean {
	if (!a || !b) return false;
	return startOfDay(a) === startOfDay(b);
}

/** Long form for tooltips / detail rows. */
export function formatFull(value: string | Date | null | undefined): string {
	const date = value instanceof Date ? value : parseServerDate(value);
	if (!date) return '';
	return date.toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
}
