// Normalized backend error. The Worker returns
// `{ ok: false, error, message, requestId, details? }` with an HTTP status.

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly requestId?: string,
		public readonly details?: unknown
	) {
		super(message);
		this.name = 'ApiError';
	}

	get isUnauthorized(): boolean {
		return this.status === 401;
	}

	get isForbidden(): boolean {
		return this.status === 403;
	}

	get isNetwork(): boolean {
		return this.status === 0;
	}

	/** A short, human-friendly line suitable for a toast. */
	get display(): string {
		if (this.isNetwork) return 'Network error — check your connection and the API address.';
		return this.message || this.code || 'Something went wrong.';
	}
}

export function isApiError(value: unknown): value is ApiError {
	return value instanceof ApiError;
}
