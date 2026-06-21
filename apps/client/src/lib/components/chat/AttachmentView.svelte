<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Download, File, ImageOff, Loader2, X } from '@lucide/svelte';
	import type { AttachmentRef } from '$lib/protocol/codec';
	import type { AttachmentVariantName } from '$lib/api/types';
	import { api } from '$lib/api';
	import { formatBytes } from '$lib/utils/format';
	import { cn } from '$lib/utils/cn';
	import Button from '$lib/components/ui/Button.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';

	let { attachment, mine }: { attachment: AttachmentRef; mine: boolean } = $props();

	let urls = $state<Partial<Record<AttachmentVariantName, string>>>({});
	let loading = $state<Partial<Record<AttachmentVariantName, boolean>>>({});
	let failed = $state(false);
	let viewerOpen = $state(false);

	const isImage = $derived(
		attachment.mediaKind === 'image' || attachment.mediaType?.startsWith('image/')
	);
	const thumbnailVariant = $derived(selectVariant(['thumbnail', 'preview', 'original']));
	const viewerVariant = $derived(selectVariant(['preview', 'original', 'thumbnail']));
	const originalVariant = $derived(selectVariant(['original', 'preview', 'thumbnail']));
	const displayBytes = $derived(
		originalVariant ? (attachment.variants?.[originalVariant]?.bytes ?? attachment.bytes) : attachment.bytes
	);
	const dimensions = $derived(
		attachment.width && attachment.height ? `${attachment.width}×${attachment.height}` : ''
	);
	const thumbnailUrl = $derived(thumbnailVariant ? urls[thumbnailVariant] : null);
	const viewerUrl = $derived(viewerVariant ? urls[viewerVariant] : null);

	function selectVariant(preference: AttachmentVariantName[]): AttachmentVariantName {
		for (const variant of preference) {
			if (!attachment.variants || attachment.variants[variant]) return variant;
		}
		return 'original';
	}

	async function ensureBlob(variant: AttachmentVariantName): Promise<string | null> {
		if (urls[variant]) return urls[variant]!;
		if (loading[variant]) return null;
		loading = { ...loading, [variant]: true };
		try {
			const buffer = await api.downloadAttachmentBlob(attachment.attachmentId, { variant });
			const blob = new Blob([buffer], {
				type: attachment.variants?.[variant]?.mimeType ?? attachment.mediaType ?? 'application/octet-stream'
			});
			const url = URL.createObjectURL(blob);
			urls = { ...urls, [variant]: url };
			return url;
		} catch {
			if (variant !== 'original') {
				const fallback = await ensureBlob('original');
				if (fallback) urls = { ...urls, [variant]: fallback };
				return fallback;
			}
			failed = true;
			return null;
		} finally {
			loading = { ...loading, [variant]: false };
		}
	}

	$effect(() => {
		if (isImage && thumbnailVariant) void ensureBlob(thumbnailVariant);
	});

	onDestroy(() => {
		for (const url of new Set(Object.values(urls))) {
			if (url) URL.revokeObjectURL(url);
		}
	});

	async function openViewer(): Promise<void> {
		viewerOpen = true;
		if (viewerVariant) await ensureBlob(viewerVariant);
	}

	async function downloadOriginal(): Promise<void> {
		const variant = originalVariant ?? 'original';
		const ready = await ensureBlob(variant);
		if (!ready) return;
		const anchor = document.createElement('a');
		anchor.href = ready;
		anchor.download = attachment.name || 'attachment';
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	}
</script>

{#if isImage}
	<div class="max-w-full">
		<button
			onclick={openViewer}
			class="group relative block max-w-full overflow-hidden rounded-2xl border border-black/5 bg-surface-2"
			aria-label="Open {attachment.name}"
		>
			{#if thumbnailUrl}
				<img
					src={thumbnailUrl}
					alt={attachment.name}
					class="max-h-72 w-auto max-w-full object-cover drag-none"
					draggable="false"
				/>
			{:else if failed}
				<span class="flex h-32 w-48 items-center justify-center gap-2 bg-surface-2 text-sm text-muted">
					<ImageOff class="h-5 w-5" /> Unavailable
				</span>
			{:else}
				<span class="grid h-32 w-48 animate-pulse place-items-center bg-surface-2 text-muted">
					<Loader2 class="h-5 w-5 animate-spin" />
				</span>
			{/if}
			<span
				class={cn(
					'absolute bottom-2 right-2 rounded-full px-2 py-1 text-[11px] font-medium shadow-sm',
					mine ? 'bg-black/35 text-white' : 'bg-black/50 text-white'
				)}
			>
				{formatBytes(displayBytes)}
			</span>
		</button>
	</div>
{:else}
	<button
		onclick={downloadOriginal}
		class={cn(
			'flex max-w-full items-center gap-3 rounded-xl border p-2.5 text-left transition',
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
				{formatBytes(displayBytes)}{loading.original ? ' · downloading…' : failed ? ' · unavailable' : ''}
			</span>
		</span>
		<Download class={cn('ml-1 h-4 w-4 shrink-0', mine ? 'text-white/80' : 'text-muted')} />
	</button>
{/if}

<Modal bind:open={viewerOpen} title={attachment.name || 'Image'} size="lg" class="sm:max-w-5xl">
	<div class="flex min-h-[40dvh] flex-col items-center justify-center gap-4">
		{#if viewerUrl}
			<img
				src={viewerUrl}
				alt={attachment.name}
				class="max-h-[72dvh] max-w-full rounded-xl object-contain"
				draggable="false"
			/>
		{:else if failed}
			<div class="flex min-h-60 items-center justify-center gap-2 text-muted">
				<ImageOff class="h-5 w-5" /> Image unavailable
			</div>
		{:else}
			<div class="grid min-h-60 place-items-center text-muted">
				<Loader2 class="h-7 w-7 animate-spin" />
			</div>
		{/if}
		<div class="flex w-full flex-wrap items-center justify-between gap-3 text-sm text-muted">
			<div class="min-w-0">
				<div class="truncate font-medium text-foreground">{attachment.name}</div>
				<div>
					{formatBytes(displayBytes)}{dimensions ? ` · ${dimensions}` : ''}
				</div>
			</div>
			<div class="flex items-center gap-2">
				<Button variant="secondary" onclick={downloadOriginal}>
					<Download class="h-4 w-4" /> Download
				</Button>
				<Button variant="ghost" onclick={() => (viewerOpen = false)}>
					<X class="h-4 w-4" /> Close
				</Button>
			</div>
		</div>
	</div>
</Modal>
