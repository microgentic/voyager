const MAX_CONCURRENT_ATTACHMENT_DOWNLOADS = 3;

interface QueuedDownload {
	task: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

let activeDownloads = 0;
const queuedDownloads: QueuedDownload[] = [];

export function scheduleAttachmentDownload<T>(task: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		queuedDownloads.push({
			task: task as () => Promise<unknown>,
			resolve: resolve as (value: unknown) => void,
			reject,
		});
		drainAttachmentDownloads();
	});
}

function drainAttachmentDownloads(): void {
	while (activeDownloads < MAX_CONCURRENT_ATTACHMENT_DOWNLOADS && queuedDownloads.length > 0) {
		const item = queuedDownloads.shift();
		if (!item) return;
		activeDownloads += 1;
		void item
			.task()
			.then(item.resolve, item.reject)
			.finally(() => {
				activeDownloads -= 1;
				drainAttachmentDownloads();
			});
	}
}
