// Deterministic avatar initials + color from a stable seed (principalId/roomId),
// so the same entity always paints the same gradient.

const GRADIENTS: Array<[string, string]> = [
	['#8b5cf6', '#6366f1'],
	['#ec4899', '#d946ef'],
	['#f97316', '#f43f5e'],
	['#06b6d4', '#3b82f6'],
	['#10b981', '#14b8a6'],
	['#eab308', '#f59e0b'],
	['#6366f1', '#0ea5e9'],
	['#f43f5e', '#fb7185']
];

// A teal pair reserved for agents so they read distinctly everywhere.
const AGENT_GRADIENT: [string, string] = ['#0ea5a3', '#0891b2'];

function hash(seed: string): number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i += 1) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h);
}

export function initials(name: string | null | undefined): string {
	const trimmed = (name ?? '').trim();
	if (!trimmed) return '?';
	const parts = trimmed.split(/\s+/).filter(Boolean);
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function avatarGradient(seed: string, isAgent = false): string {
	const [from, to] = isAgent ? AGENT_GRADIENT : GRADIENTS[hash(seed) % GRADIENTS.length];
	return `linear-gradient(135deg, ${from}, ${to})`;
}

// Readable sender-name colors for group timelines (legible in both themes).
const NAME_COLORS = [
	'oklch(0.62 0.19 280)',
	'oklch(0.6 0.2 0)',
	'oklch(0.6 0.16 200)',
	'oklch(0.6 0.18 145)',
	'oklch(0.62 0.18 30)',
	'oklch(0.6 0.2 320)',
	'oklch(0.6 0.17 250)',
	'oklch(0.62 0.16 95)'
];

export function nameColor(seed: string): string {
	return NAME_COLORS[hash(seed) % NAME_COLORS.length];
}
