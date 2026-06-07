<script lang="ts">
	import { Download, File, ImageOff } from '@lucide/svelte';
	import type { AttachmentRef } from '$lib/protocol/codec';
	import { api } from '$lib/api';
	import { openExternal } from '$lib/platform';
	import { formatBytes } from '$lib/utils/format';
	import { cn } from '$lib/utils/cn';

	let { attachment, mine }: { attachment: AttachmentRef; mine: boolean } = $props();

	let url = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state(false);

	const isImage = $derived(!!attachment.mediaType?.startsWith('image/'));

	async function ensureBlob(): Promise<string | null> {
		if (url) return url;
		if (loading) return null;
		loading = true;
		try {
			const buffer = await api.downloadAttachmentBlob(attachment.attachmentId);
			url = URL.createObjectURL(
				new Blob([buffer], { type: attachment.mediaType || 'application/octet-stream' })
			);
			return url;
		} catch {
			failed = true;
			return null;
		} finally {
			loading = false;
		}
	}

	// Auto-load image previews; clean up the object URL on teardown.
	$effect(() => {
		if (isImage) void ensureBlob();
		return () => {
			if (url) URL.revokeObjectURL(url);
		};
	});

	async function download() {
		const ready = await ensureBlob();
		if (!ready) return;
		const a = document.createElement('a');
		a.href = ready;
		a.download = attachment.name || 'attachment';
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	async function openImage() {
		const ready = await ensureBlob();
		if (ready) await openExternal(ready);
	}
</script>

{#if isImage}
	<button
		onclick={openImage}
		class="group relative block max-w-full overflow-hidden rounded-xl border border-black/5"
		aria-label="Open {attachment.name}"
	>
		{#if url}
			<img src={url} alt={attachment.name} class="max-h-72 w-auto max-w-full object-cover drag-none" />
		{:else if failed}
			<span class="flex h-32 w-48 items-center justify-center gap-2 bg-surface-2 text-sm text-muted">
				<ImageOff class="h-5 w-5" /> Unavailable
			</span>
		{:else}
			<span class="flex h-32 w-48 animate-pulse items-center justify-center bg-surface-2"></span>
		{/if}
	</button>
{:else}
	<button
		onclick={download}
		class={cn(
			'flex items-center gap-3 rounded-xl border p-2.5 text-left transition',
			mine
				? 'border-white/20 bg-white/10 hover:bg-white/15'
				: 'border-border bg-surface-2 hover:bg-surface-3'
		)}
	>
		<span
			class={cn(
				'grid h-10 w-10 shrink-0 place-items-center rounded-lg',
				mine ? 'bg-white/15 text-white' : 'bg-primary-soft text-primary'
			)}
		>
			<File class="h-5 w-5" />
		</span>
		<span class="min-w-0">
			<span class="block max-w-[12rem] truncate text-sm font-medium">{attachment.name}</span>
			<span class={cn('block text-xs', mine ? 'text-white/70' : 'text-faint')}>
				{formatBytes(attachment.bytes)}{loading ? ' · downloading…' : failed ? ' · unavailable' : ''}
			</span>
		</span>
		<Download class={cn('ml-1 h-4 w-4 shrink-0', mine ? 'text-white/80' : 'text-muted')} />
	</button>
{/if}
