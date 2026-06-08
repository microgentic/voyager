export type ClassValue =
	| string
	| number
	| false
	| null
	| undefined
	| ClassValue[]
	| Record<string, boolean | null | undefined>;

/** Tiny clsx — joins truthy class values. */
export function cn(...inputs: ClassValue[]): string {
	const out: string[] = [];
	const walk = (value: ClassValue): void => {
		if (!value) return;
		if (typeof value === 'string' || typeof value === 'number') {
			out.push(String(value));
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item);
		} else if (typeof value === 'object') {
			for (const [key, enabled] of Object.entries(value)) if (enabled) out.push(key);
		}
	};
	for (const input of inputs) walk(input);
	return out.join(' ');
}
