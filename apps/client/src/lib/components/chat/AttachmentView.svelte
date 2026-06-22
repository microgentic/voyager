<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		ChevronLeft,
		ChevronRight,
		Download,
		File,
		ImageOff,
		Loader2,
		Music,
		Play,
		Video,
		X
	} from '@lucide/svelte';
	import type { AttachmentRef } from '$lib/protocol/codec';
	import type { AttachmentVariantName } from '$lib/api/types';
	import { api } from '$lib/api';
	import { scheduleAttachmentDownload } from '$lib/media/attachment-downloads';
	import { formatBytes, formatDuration } from '$lib/utils/format';
	import { cn } from '$lib/utils/cn';
	import Button from '$lib/components/ui/Button.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';

	let {
		attachment,
		mine,
		gallery = [],
		galleryIndex = 0,
		grid = false
	}: {
		attachment: AttachmentRef;
		mine: boolean;
		gallery?: AttachmentRef[];
		galleryIndex?: number;
		grid?: boolean;
	} = $props();

	let urls = $state<Record<string, string>>({});
	let loading = $state<Record<string, boolean>>({});
	let failed = $state<Record<string, boolean>>({});
	let viewerOpen = $state(false);
	let activeIndex = $state(0);
	let thumbnailVisible = $state(false);
	let thumbnailEl = $state<HTMLElement>();
	let viewerPointerStart = $state<{ x: number; y: number } | null>(null);
	let destroyed = false;

	const isImage = $derived(isImageAttachment(attachment));
	const isVideo = $derived(isVideoAttachment(attachment));
	const isAudio = $derived(isAudioAttachment(attachment));
	const canPreviewMedia = $derived(isVideo || isAudio);
	const activeAttachment = $derived(gallery.length ? (gallery[activeIndex] ?? attachment) : attachment);
	const activeIsImage = $derived(isImageAttachment(activeAttachment));
	const activeIsVideo = $derived(isVideoAttachment(activeAttachment));
	const activeIsAudio = $derived(isAudioAttachment(activeAttachment));
	const thumbnailVariant = $derived(selectVariant(attachment, ['thumbnail', 'preview', 'original']));
	const viewerVariant = $derived(selectVariant(activeAttachment, ['preview', 'original', 'thumbnail']));
	const originalVariant = $derived(selectVariant(activeAttachment, ['original', 'preview', 'thumbnail']));
	const audioVariant = $derived(selectVariant(attachment, ['original', 'preview', 'thumbnail']));
	const posterVariant = $derived(selectOptionalVariant(activeAttachment, ['thumbnail', 'preview']));
	const displayBytes = $derived(bytesFor(attachment));
	const activeDisplayBytes = $derived(bytesFor(activeAttachment));
	const dimensions = $derived(dimensionsFor(attachment));
	const activeDimensions = $derived(dimensionsFor(activeAttachment));
	const duration = $derived(formatDuration(attachment.durationMs));
	const activeDuration = $derived(formatDuration(activeAttachment.durationMs));
	const thumbnailUrl = $derived(thumbnailVariant ? urls[cacheKey(attachment, thumbnailVariant)] : null);
	const audioUrl = $derived(audioVariant ? urls[cacheKey(attachment, audioVariant)] : null);
	const viewerUrl = $derived(viewerVariant ? urls[cacheKey(activeAttachment, viewerVariant)] : null);
	const posterUrl = $derived(posterVariant ? urls[cacheKey(activeAttachment, posterVariant)] : null);
	const thumbnailFailed = $derived(thumbnailVariant ? failed[cacheKey(attachment, thumbnailVariant)] : false);
	const audioFailed = $derived(audioVariant ? failed[cacheKey(attachment, audioVariant)] : false);
	const audioLoading = $derived(audioVariant ? loading[cacheKey(attachment, audioVariant)] : false);
	const viewerFailed = $derived(viewerVariant ? failed[cacheKey(activeAttachment, viewerVariant)] : false);
	const galleryCount = $derived(gallery.length);
	const showGalleryControls = $derived(activeIsImage && galleryCount > 1);
	const activePosition = $derived(showGalleryControls ? `${activeIndex + 1} / ${galleryCount}` : '');
	const cardLabel = $derived(isVideo ? 'Video' : isAudio ? 'Audio' : 'File');
	const cardMeta = $derived([cardLabel, duration, dimensions, formatBytes(displayBytes)].filter(Boolean).join(' · '));

	function isImageAttachment(item: AttachmentRef): boolean {
		return item.mediaKind === 'image' || item.mediaType?.startsWith('image/');
	}

	function isVideoAttachment(item: AttachmentRef): boolean {
		return item.mediaKind === 'video' || item.mediaType?.startsWith('video/');
	}

	function isAudioAttachment(item: AttachmentRef): boolean {
		return item.mediaKind === 'audio' || item.mediaType?.startsWith('audio/');
	}

	function selectVariant(item: AttachmentRef, preference: AttachmentVariantName[]): AttachmentVariantName {
		if (!item.variants) return 'original';
		for (const variant of preference) {
			if (item.variants[variant]) return variant;
		}
		return 'original';
	}

	function selectOptionalVariant(
		item: AttachmentRef,
		preference: AttachmentVariantName[]
	): AttachmentVariantName | null {
		if (!item.variants) return null;
		for (const variant of preference) {
			if (item.variants[variant]) return variant;
		}
		return null;
	}

	function cacheKey(item: AttachmentRef, variant: AttachmentVariantName): string {
		return `${item.attachmentId}:${variant}`;
	}

	function bytesFor(item: AttachmentRef): number {
		const variant = selectVariant(item, ['original', 'preview', 'thumbnail']);
		return item.variants?.[variant]?.bytes ?? item.bytes;
	}

	function dimensionsFor(item: AttachmentRef): string {
		return item.width && item.height ? `${item.width}x${item.height}` : '';
	}

	async function ensureBlob(item: AttachmentRef, variant: AttachmentVariantName): Promise<string | null> {
		const key = cacheKey(item, variant);
		if (destroyed) return null;
		if (urls[key]) return urls[key];
		if (loading[key]) return null;
		loading = { ...loading, [key]: true };
		try {
			const buffer = await scheduleAttachmentDownload(() => {
				if (destroyed) return Promise.reject(new Error('Attachment view destroyed'));
				return api.downloadAttachmentBlob(item.attachmentId, { variant });
			});
			if (destroyed) return null;
			const blob = new Blob([buffer], {
				type: item.variants?.[variant]?.mimeType ?? item.mediaType ?? 'application/octet-stream'
			});
			const url = URL.createObjectURL(blob);
			if (destroyed) {
				URL.revokeObjectURL(url);
				return null;
			}
			urls = { ...urls, [key]: url };
			failed = { ...failed, [key]: false };
			return url;
		} catch {
			if (destroyed) return null;
			if (variant !== 'original') {
				const fallback = await ensureBlob(item, 'original');
				if (fallback) urls = { ...urls, [key]: fallback };
				return fallback;
			}
			failed = { ...failed, [key]: true };
			return null;
		} finally {
			if (!destroyed) loading = { ...loading, [key]: false };
		}
	}

	function revokeUrls(): void {
		for (const url of new Set(Object.values(urls))) {
			if (url) URL.revokeObjectURL(url);
		}
		urls = {};
	}

	function normalizeActiveIndex(): void {
		if (!gallery.length) {
			activeIndex = 0;
			return;
		}
		activeIndex = Math.min(Math.max(activeIndex, 0), gallery.length - 1);
	}

	$effect(() => {
		if (!isImage) return;
		const node = thumbnailEl;
		if (!node) return;
		if (typeof IntersectionObserver === 'undefined') {
			thumbnailVisible = true;
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					thumbnailVisible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '320px' }
		);
		observer.observe(node);
		return () => observer.disconnect();
	});

	$effect(() => {
		normalizeActiveIndex();
	});

	$effect(() => {
		if (isImage && thumbnailVisible && thumbnailVariant) void ensureBlob(attachment, thumbnailVariant);
	});

	$effect(() => {
		if (viewerOpen && viewerVariant) void ensureBlob(activeAttachment, viewerVariant);
		if (viewerOpen && activeIsVideo && posterVariant) void ensureBlob(activeAttachment, posterVariant);
	});

	$effect(() => {
		if (isAudio && audioVariant) void ensureBlob(attachment, audioVariant);
	});

	onDestroy(() => {
		destroyed = true;
		revokeUrls();
	});

	async function openViewer(): Promise<void> {
		const nextIndex = gallery.length ? Math.min(Math.max(galleryIndex, 0), gallery.length - 1) : 0;
		const nextAttachment = gallery.length ? (gallery[nextIndex] ?? attachment) : attachment;
		const nextVariant = selectVariant(nextAttachment, ['preview', 'original', 'thumbnail']);
		activeIndex = nextIndex;
		viewerOpen = true;
		if (nextVariant) await ensureBlob(nextAttachment, nextVariant);
	}

	async function handleCardAction(): Promise<void> {
		if (canPreviewMedia) {
			await openViewer();
			return;
		}
		await downloadOriginal();
	}

	async function downloadOriginal(): Promise<void> {
		const variant = originalVariant ?? 'original';
		const ready = await ensureBlob(activeAttachment, variant);
		if (!ready) return;
		const anchor = document.createElement('a');
		anchor.href = ready;
		anchor.download = activeAttachment.name || 'attachment';
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	}

	function moveGallery(delta: number): void {
		if (!gallery.length) return;
		activeIndex = (activeIndex + delta + gallery.length) % gallery.length;
	}

	function onViewerKeydown(event: KeyboardEvent): void {
		if (!viewerOpen || !showGalleryControls) return;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			moveGallery(-1);
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			moveGallery(1);
		}
	}

	function onViewerPointerDown(event: PointerEvent): void {
		if (!showGalleryControls) return;
		viewerPointerStart = { x: event.clientX, y: event.clientY };
	}

	function onViewerPointerUp(event: PointerEvent): void {
		if (!viewerPointerStart) return;
		const dx = event.clientX - viewerPointerStart.x;
		const dy = event.clientY - viewerPointerStart.y;
		viewerPointerStart = null;
		if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
		moveGallery(dx < 0 ? 1 : -1);
	}
</script>

<svelte:window onkeydown={onViewerKeydown} />

{#if isImage}
	<div class="max-w-full">
		<button
			bind:this={thumbnailEl}
			onclick={openViewer}
			class={cn(
				'group relative block max-w-full overflow-hidden rounded-2xl border border-black/5 bg-surface-2',
				grid && 'aspect-square w-full'
			)}
			aria-label="Open {attachment.name}"
		>
			{#if thumbnailUrl}
				<img
					src={thumbnailUrl}
					alt={attachment.name}
					loading="lazy"
					decoding="async"
					class={cn(
						'drag-none',
						grid ? 'h-full w-full object-cover' : 'max-h-72 w-auto max-w-full object-cover'
					)}
					draggable="false"
				/>
			{:else if thumbnailFailed}
				<span class={cn('flex items-center justify-center gap-2 bg-surface-2 text-sm text-muted', grid ? 'h-full w-full' : 'h-32 w-48')}>
					<ImageOff class="h-5 w-5" /> Unavailable
				</span>
			{:else}
				<span class={cn('grid animate-pulse place-items-center bg-surface-2 text-muted', grid ? 'h-full w-full' : 'h-32 w-48')}>
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
{:else if isAudio}
	<div
		class={cn(
			'flex max-w-full flex-col gap-2 rounded-xl border p-2.5 text-left',
			mine ? 'border-white/20 bg-white/10' : 'border-border bg-surface-2'
		)}
	>
		<div class="flex min-w-0 items-center gap-3">
			<span
				class={cn(
					'relative grid h-10 w-10 shrink-0 place-items-center rounded-lg',
					mine ? 'bg-white/15 text-white' : 'bg-primary-soft text-primary'
				)}
			>
				<Music class="h-5 w-5" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block max-w-[14rem] truncate text-sm font-medium">{attachment.name}</span>
				<span class={cn('block text-xs', mine ? 'text-white/70' : 'text-faint')}>
					{cardMeta}{audioLoading ? ' · loading…' : audioFailed ? ' · unavailable' : ''}
				</span>
			</span>
			<button
				type="button"
				onclick={downloadOriginal}
				class={cn(
					'grid h-8 w-8 shrink-0 place-items-center rounded-lg transition',
					mine ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-surface-3'
				)}
				aria-label={`Download ${attachment.name}`}
				title="Download audio"
			>
				<Download class="h-4 w-4" />
			</button>
		</div>
		{#if audioUrl}
			<audio src={audioUrl} controls preload="metadata" class="h-9 w-full max-w-[20rem]"></audio>
		{:else}
			<div class="h-1.5 overflow-hidden rounded-full bg-border">
				<div
					class={cn('h-full rounded-full', audioFailed ? 'w-full bg-danger' : 'w-1/3 animate-pulse bg-primary')}
				></div>
			</div>
		{/if}
	</div>
{:else}
	<button
		onclick={handleCardAction}
		class={cn(
			'flex max-w-full items-center gap-3 rounded-xl border p-2.5 text-left transition',
			mine
				? 'border-white/20 bg-white/10 hover:bg-white/15'
				: 'border-border bg-surface-2 hover:bg-surface-3'
		)}
		aria-label={canPreviewMedia ? `Open ${attachment.name}` : `Download ${attachment.name}`}
	>
		<span
			class={cn(
				'relative grid h-10 w-10 shrink-0 place-items-center rounded-lg',
				mine ? 'bg-white/15 text-white' : 'bg-primary-soft text-primary'
			)}
		>
			{#if isVideo}
				<Video class="h-5 w-5" />
			{:else if isAudio}
				<Music class="h-5 w-5" />
			{:else}
				<File class="h-5 w-5" />
			{/if}
			{#if canPreviewMedia}
				<span class="absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full bg-background text-primary shadow-sm">
					<Play class="h-2.5 w-2.5 fill-current" />
				</span>
			{/if}
		</span>
		<span class="min-w-0">
			<span class="block max-w-[12rem] truncate text-sm font-medium">{attachment.name}</span>
			<span class={cn('block text-xs', mine ? 'text-white/70' : 'text-faint')}>
				{cardMeta}{loading[cacheKey(attachment, 'original')] ? ' · loading…' : failed[cacheKey(attachment, 'original')] ? ' · unavailable' : ''}
			</span>
		</span>
		<Download class={cn('ml-1 h-4 w-4 shrink-0', mine ? 'text-white/80' : 'text-muted')} />
	</button>
{/if}

<Modal bind:open={viewerOpen} title={activeAttachment.name || 'Attachment'} size="lg" class="sm:max-w-5xl">
	<div
		class="flex min-h-[48dvh] flex-col items-center justify-center gap-4"
		role="presentation"
		onpointerdown={onViewerPointerDown}
		onpointerup={onViewerPointerUp}
		onpointercancel={() => (viewerPointerStart = null)}
	>
		<div class="relative flex min-h-60 w-full items-center justify-center overflow-hidden rounded-xl bg-surface-2">
			{#if showGalleryControls}
				<button
					type="button"
					onclick={() => moveGallery(-1)}
					class="absolute left-2 z-10 grid h-10 w-10 place-items-center rounded-full bg-background/85 text-foreground shadow-sm transition hover:bg-background"
					aria-label="Previous image"
				>
					<ChevronLeft class="h-5 w-5" />
				</button>
				<button
					type="button"
					onclick={() => moveGallery(1)}
					class="absolute right-2 z-10 grid h-10 w-10 place-items-center rounded-full bg-background/85 text-foreground shadow-sm transition hover:bg-background"
					aria-label="Next image"
				>
					<ChevronRight class="h-5 w-5" />
				</button>
			{/if}

			{#if viewerUrl && activeIsImage}
				<img
					src={viewerUrl}
					alt={activeAttachment.name}
					decoding="async"
					class="max-h-[72dvh] max-w-full object-contain"
					draggable="false"
				/>
			{:else if viewerUrl && activeIsVideo}
				<!-- svelte-ignore a11y_media_has_caption: user-uploaded video attachments may not include captions. -->
				<video
					src={viewerUrl}
					poster={posterUrl ?? undefined}
					controls
					preload="metadata"
					class="max-h-[72dvh] max-w-full"
				></video>
			{:else if viewerUrl && activeIsAudio}
				<div class="flex w-full max-w-xl flex-col items-center gap-4 p-6">
					<div class="grid h-16 w-16 place-items-center rounded-2xl bg-primary-soft text-primary">
						<Music class="h-7 w-7" />
					</div>
					<audio src={viewerUrl} controls preload="metadata" class="w-full"></audio>
				</div>
			{:else if viewerFailed}
				<div class="flex min-h-60 items-center justify-center gap-2 text-muted">
					<ImageOff class="h-5 w-5" /> Attachment unavailable
				</div>
			{:else}
				<div class="grid min-h-60 place-items-center text-muted">
					<Loader2 class="h-7 w-7 animate-spin" />
				</div>
			{/if}
		</div>
		<div class="flex w-full flex-wrap items-center justify-between gap-3 text-sm text-muted">
			<div class="min-w-0">
				<div class="truncate font-medium text-foreground">{activeAttachment.name}</div>
				<div>
					{formatBytes(activeDisplayBytes)}{activeDimensions ? ` · ${activeDimensions}` : ''}{activeDuration ? ` · ${activeDuration}` : ''}{activePosition ? ` · ${activePosition}` : ''}
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
