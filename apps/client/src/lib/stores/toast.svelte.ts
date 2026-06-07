import { localId } from '$lib/utils/id';

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
	id: string;
	tone: ToastTone;
	title?: string;
	message: string;
}

class ToastStore {
	toasts = $state<Toast[]>([]);

	push(message: string, opts: { tone?: ToastTone; title?: string; duration?: number } = {}): string {
		const id = localId('toast');
		const tone = opts.tone ?? 'info';
		this.toasts.push({ id, tone, title: opts.title, message });
		const duration = opts.duration ?? (tone === 'error' ? 6000 : 3800);
		if (duration > 0 && typeof window !== 'undefined') {
			window.setTimeout(() => this.dismiss(id), duration);
		}
		return id;
	}

	success(message: string, title?: string): string {
		return this.push(message, { tone: 'success', title });
	}

	error(message: string, title?: string): string {
		return this.push(message, { tone: 'error', title });
	}

	info(message: string, title?: string): string {
		return this.push(message, { tone: 'info', title });
	}

	dismiss(id: string): void {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}
}

export const toasts = new ToastStore();
