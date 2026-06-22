<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import {
		Archive,
		Ban,
		CornerUpLeft,
		File as FileIcon,
		Image as ImageIcon,
		Paperclip,
		Pencil,
		RotateCcw,
		SendHorizontal,
		Sparkles,
		X
	} from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import type { AttachmentRef } from '$lib/protocol/codec';
	import { api, isApiError } from '$lib/api';
	import { messages, rooms, sync, ui, toasts, type ChatMessage } from '$lib/stores';
	import Textarea from '$lib/components/ui/Textarea.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import { cn } from '$lib/utils/cn';
	import { formatBytes } from '$lib/utils/format';
	import { localId } from '$lib/utils/id';
	import {
		attachmentRefFromUpload,
		buildAttachmentUploadPlan,
		pickLocalPreviewVariant,
		type AttachmentUploadPlan
	} from '$lib/media/attachments';

	let {
		room,
		replyTo = null,
		editingMessage = null,
		threadRoot = null,
		onCancelContext,
		onSent
	}: {
		room: Room;
		replyTo?: ChatMessage | null;
		editingMessage?: ChatMessage | null;
		threadRoot?: ChatMessage | null;
		onCancelContext?: () => void;
		onSent?: () => void;
	} = $props();

	interface Pending {
		id: string;
		file: File;
		name: string;
		mediaType: string;
		bytes: number;
		sourceOriginal: boolean;
		plan?: AttachmentUploadPlan;
		ref?: AttachmentRef;
		attachmentId?: string;
		status: 'processing' | 'uploading' | 'ready' | 'error';
		progress: number;
		statusText: string;
		localPreviewUrl?: string;
		abort?: AbortController;
		error?: string;
	}

	let text = $state('');
	let markdown = $state(false);
	let sending = $state(false);
	let pending = $state<Pending[]>([]);
	let alsoSendToRoom = $state(false);
	let sendOriginalImages = $state(false);
	let textareaEl = $state<HTMLTextAreaElement>();
	let fileInput = $state<HTMLInputElement>();
	let hydratedEditKey = '';
	let dragDepth = $state(0);

	const membership = $derived(rooms.myMembership(room));
	const blocked = $derived(!membership || membership.status !== 'active');
	const archived = $derived(room.status !== 'active');
	const uploading = $derived(pending.some((p) => p.status === 'processing' || p.status === 'uploading'));
	const editing = $derived(Boolean(editingMessage));
	const inThread = $derived(Boolean(threadRoot) && !editing);
	const dragActive = $derived(dragDepth > 0 && !editing && !blocked && !archived);
	const alsoSendLabel = $derived(room.type === 'direct' ? 'the main chat' : `#${room.name ?? 'room'}`);
	const activeContext = $derived(editingMessage ?? replyTo);
	const ready = $derived(text.trim().length > 0 || (!editing && pending.some((p) => p.status === 'ready')));
	const contextTitle = $derived(
		editingMessage ? 'Edit message' : replyTo ? `Reply to ${replyTo.mine ? 'yourself' : (room.members.find((m) => m.principalId === replyTo.senderPrincipalId)?.displayName ?? 'message')}` : ''
	);
	const contextBody = $derived(activeContext?.content.undecodable ? 'Message can’t be displayed' : (activeContext?.content.body ?? '').trim());

	async function addFiles(files: FileList | null) {
		if (!files) return;
		for (const file of Array.from(files).slice(0, 10 - pending.length)) {
			const id = localId('att');
			const controller = new AbortController();
			const sourceOriginal = sendOriginalImages && file.type.startsWith('image/');
			pending = [
				...pending,
				{
					id,
					file,
					name: file.name || 'attachment',
					mediaType: file.type || 'application/octet-stream',
					bytes: file.size,
					sourceOriginal,
					status: 'processing',
					progress: 0.08,
					statusText: 'Preparing',
					abort: controller
				}
			];
			void uploadPending(id, file, controller, sourceOriginal);
		}
		if (fileInput) fileInput.value = '';
	}

	async function uploadPending(
		id: string,
		file: File,
		controller: AbortController,
		sourceOriginal = false
	): Promise<void> {
		let attachmentId: string | undefined;
		try {
			const plan = await buildAttachmentUploadPlan(file, { includeSourceOriginal: sourceOriginal });
			if (controller.signal.aborted) return;
			const localPreviewUrl =
				plan.mediaKind === 'image' ? URL.createObjectURL(pickLocalPreviewVariant(plan).blob) : undefined;
			patchPending(id, {
				plan,
				localPreviewUrl,
				status: 'uploading',
				progress: 0.18,
				statusText:
					plan.mediaKind === 'image' && sourceOriginal
						? 'Source included'
						: plan.mediaKind === 'image'
							? 'Optimized'
							: 'Ready to upload'
			});
			const allocated = await api.allocateAttachment(room.roomId, {
				expectedBytes: Math.max(1, plan.expectedBytes),
				contentCategory: plan.contentCategory,
				originalFilename: plan.originalFilename,
				declaredMimeType: plan.declaredMimeType,
				mediaKind: plan.mediaKind,
				width: plan.width ?? undefined,
				height: plan.height ?? undefined,
				durationMs: plan.durationMs ?? undefined,
				variantManifest: plan.variantManifest
			});
			attachmentId = allocated.attachmentId;
			if (controller.signal.aborted) {
				await api.deleteAttachment(attachmentId).catch(() => undefined);
				return;
			}
			patchPending(id, { attachmentId, progress: 0.25, statusText: 'Uploading' });
			let uploaded = 0;
			let latest = allocated;
			for (const variant of plan.variants) {
				latest = await api.uploadAttachmentBlob(attachmentId, variant.blob, {
					variant: variant.variant,
					contentType: variant.mimeType,
					signal: controller.signal
				});
				uploaded += variant.bytes;
				patchPending(id, {
					progress: Math.min(0.88, 0.25 + (uploaded / Math.max(1, plan.expectedBytes)) * 0.58),
					statusText:
						variant.variant === 'thumbnail'
							? 'Uploaded thumbnail'
							: variant.variant === 'preview'
								? 'Uploaded preview'
								: 'Uploaded primary'
				});
			}
			const original = plan.variants.find((item) => item.variant === 'original') ?? plan.variants[0];
			latest = await api.completeAttachment(attachmentId, {
				ciphertextBytes: original.bytes,
				originalFilename: plan.originalFilename,
				declaredMimeType: plan.declaredMimeType,
				mediaKind: plan.mediaKind,
				width: plan.width ?? undefined,
				height: plan.height ?? undefined,
				durationMs: plan.durationMs ?? undefined,
				variantManifest: plan.variantManifest
			});
			const ref = attachmentRefFromUpload(latest, plan);
			patchPending(id, {
				ref,
				status: 'ready',
				progress: 1,
				statusText: sourceOriginal ? 'Ready with source' : 'Ready',
				abort: undefined
			});
		} catch (err) {
			if (attachmentId) void api.deleteAttachment(attachmentId).catch(() => undefined);
			if ((err as Error)?.name === 'AbortError') return;
			const display = isApiError(err) ? err.display : `Couldn’t upload ${file.name || 'attachment'}.`;
			patchPending(id, {
				status: 'error',
				progress: 0,
				statusText: 'Upload failed',
				error: display,
				abort: undefined
			});
			toasts.error(display);
		}
	}

	function patchPending(id: string, patch: Partial<Pending>): void {
		pending = pending.map((item) => (item.id === id ? { ...item, ...patch } : item));
	}

	function removePending(id: string): void {
		const target = pending.find((p) => p.id === id);
		target?.abort?.abort();
		if (target?.localPreviewUrl) URL.revokeObjectURL(target.localPreviewUrl);
		const attachmentId = target?.ref?.attachmentId ?? target?.attachmentId;
		if (attachmentId) void api.deleteAttachment(attachmentId).catch(() => undefined);
		pending = pending.filter((p) => p.id !== id);
	}

	function retryPending(id: string): void {
		const target = pending.find((item) => item.id === id);
		if (!target) return;
		if (target.localPreviewUrl) URL.revokeObjectURL(target.localPreviewUrl);
		const staleAttachmentId = target.ref?.attachmentId ?? target.attachmentId;
		if (staleAttachmentId) void api.deleteAttachment(staleAttachmentId).catch(() => undefined);
		const controller = new AbortController();
		patchPending(id, {
			attachmentId: undefined,
			ref: undefined,
			plan: undefined,
			localPreviewUrl: undefined,
			status: 'processing',
			progress: 0.08,
			statusText: 'Preparing',
			abort: controller,
			error: undefined
		});
		void uploadPending(id, target.file, controller, target.sourceOriginal);
	}

	function clearPending(list = pending, options: { deleteRemote?: boolean } = {}): void {
		for (const item of list) {
			item.abort?.abort();
			if (item.localPreviewUrl) URL.revokeObjectURL(item.localPreviewUrl);
			if (options.deleteRemote) {
				const attachmentId = item.ref?.attachmentId ?? item.attachmentId;
				if (attachmentId) void api.deleteAttachment(attachmentId).catch(() => undefined);
			}
		}
		pending = [];
	}

	async function send(): Promise<void> {
		if (!ready || sending || uploading || blocked || archived) return;
		const body = text.trim();
		const attachments = pending.filter((p) => p.status === 'ready' && p.ref).map((p) => p.ref!);
		const sentPending = pending;
		sending = true;
		text = '';
		clearPending(sentPending);
		try {
			if (editingMessage) {
				await messages.editText(editingMessage, {
					contentType: markdown ? 'text/markdown' : 'text/plain',
					body,
					replyToMessageId: editingMessage.content.replyToMessageId,
					attachments: editingMessage.content.attachments
				});
			} else if (inThread && threadRoot?.envelopeId) {
				await messages.replyInThread(
					room.roomId,
					threadRoot.envelopeId,
					{ contentType: markdown ? 'text/markdown' : 'text/plain', body, attachments },
					alsoSendToRoom
				);
				alsoSendToRoom = false;
			} else {
				await messages.sendText(room.roomId, {
					contentType: markdown ? 'text/markdown' : 'text/plain',
					body,
					replyToMessageId: replyTo?.envelopeId ?? null,
					attachments
				});
			}
			onSent?.();
			sync.pokeNow();
		} catch {
			// The optimistic bubble is now marked failed (with retry) by the store.
			toasts.error(editingMessage ? 'Message edit failed.' : 'Message failed to send. Tap the message to retry.');
		} finally {
			sending = false;
			textareaEl?.focus();
			notifyComposerFocus();
		}
	}

	function onDragEnter(event: DragEvent): void {
		if (editing || blocked || archived || !event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		dragDepth += 1;
	}

	function onDragOver(event: DragEvent): void {
		if (editing || blocked || archived || !event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(event: DragEvent): void {
		if (dragDepth > 0) dragDepth -= 1;
	}

	function onDrop(event: DragEvent): void {
		if (editing || blocked || archived) return;
		event.preventDefault();
		dragDepth = 0;
		void addFiles(event.dataTransfer?.files ?? null);
	}

	function notifyComposerFocus(): void {
		document.dispatchEvent(new CustomEvent('voyager:composer-focus'));
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && ui.isWide && !event.isComposing) {
			event.preventDefault();
			void send();
		}
	}

	$effect(() => {
		const key = editingMessage?.key ?? '';
		if (key === hydratedEditKey) return;
		hydratedEditKey = key;
		if (!editingMessage) return;
		text = editingMessage.content.body;
		markdown = editingMessage.content.contentType === 'text/markdown';
		pending = [];
		void tick().then(() => {
			textareaEl?.focus();
			notifyComposerFocus();
		});
	});

	onDestroy(() => clearPending(pending, { deleteRemote: true }));
</script>

{#if blocked}
	<div class="flex shrink-0 items-center justify-center gap-2 border-t border-border bg-surface px-4 py-4 pb-[calc(var(--sab)+1rem)] text-sm text-muted">
		<Ban class="h-4 w-4" /> You’re no longer a member of this conversation.
	</div>
{:else if archived}
	<div class="flex shrink-0 items-center justify-center gap-2 border-t border-border bg-surface px-4 py-4 pb-[calc(var(--sab)+1rem)] text-sm text-muted">
		<Archive class="h-4 w-4" /> This conversation is archived.
	</div>
{:else}
	<div
		class={cn(
			'relative shrink-0 border-t border-border bg-surface pb-[calc(var(--sab)+0.5rem)] pl-[calc(var(--sal)+0.5rem)] pr-[calc(var(--sar)+1.5rem)] pt-2 sm:px-3',
			dragActive && 'ring-2 ring-inset ring-primary/70'
		)}
		ondragenter={onDragEnter}
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		ondrop={onDrop}
		role="region"
		aria-label="Message composer"
	>
		{#if dragActive}
			<div class="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-2xl border border-dashed border-primary bg-primary-soft/95 text-sm font-semibold text-primary shadow-sm">
				Drop files to attach
			</div>
		{/if}
		{#if activeContext}
			<div class="mb-2 flex min-w-0 items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm">
				<div class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
					{#if editingMessage}<Pencil class="h-4 w-4" />{:else}<CornerUpLeft class="h-4 w-4" />{/if}
				</div>
				<div class="min-w-0 flex-1">
					<div class="font-semibold text-foreground">{contextTitle}</div>
					<div class="truncate text-xs text-muted">{contextBody || 'Attachment message'}</div>
				</div>
				<button
					type="button"
					class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-foreground"
					aria-label="Cancel message context"
					onclick={() => {
						text = '';
						onCancelContext?.();
					}}
				>
					<X class="h-4 w-4" />
				</button>
			</div>
		{/if}

		{#if pending.length > 0}
			<div class="mb-2 grid gap-2 px-1 sm:grid-cols-2 lg:grid-cols-3">
				{#each pending as item (item.id)}
					<div
						class={cn(
							'min-w-0 overflow-hidden rounded-xl border bg-surface-2 text-xs shadow-sm',
							item.status === 'error' ? 'border-danger/40' : 'border-border'
						)}
					>
						<div class="flex min-w-0 gap-2 p-2">
							<div class="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface-3 text-muted">
								{#if item.localPreviewUrl}
									<img src={item.localPreviewUrl} alt="" class="h-full w-full object-cover" draggable="false" />
								{:else if item.mediaType.startsWith('image/')}
									<ImageIcon class="h-5 w-5" />
								{:else}
									<FileIcon class="h-5 w-5" />
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<div class="truncate font-semibold text-foreground">{item.name}</div>
								<div class={cn('truncate', item.status === 'error' ? 'text-danger' : 'text-muted')}>
									{item.statusText} · {formatBytes(item.ref?.bytes ?? item.plan?.expectedBytes ?? item.bytes)}
								</div>
								<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
									<div
										class={cn(
											'h-full rounded-full transition-[width]',
											item.status === 'error' ? 'bg-danger' : 'bg-primary'
										)}
										style={`width: ${Math.max(4, Math.round(item.progress * 100))}%`}
									></div>
								</div>
							</div>
							<div class="flex shrink-0 items-start gap-0.5">
								{#if item.status === 'error'}
									<Button
										variant="ghost"
										size="icon-sm"
										title={item.error ?? 'Retry upload'}
										aria-label="Retry attachment upload"
										onclick={() => retryPending(item.id)}
									>
										<RotateCcw class="h-3.5 w-3.5" />
									</Button>
								{/if}
								<button
									onclick={() => removePending(item.id)}
									aria-label="Remove attachment"
									class="grid h-8 w-8 place-items-center rounded-lg text-faint transition hover:bg-surface-3 hover:text-foreground"
								>
									<X class="h-3.5 w-3.5" />
								</button>
							</div>
						</div>
						{#if item.status === 'ready' && item.plan && item.plan.file.size > (item.ref?.bytes ?? item.plan.expectedBytes)}
							<div class="border-t border-border px-2 py-1 text-[11px] text-muted">
								Optimized from {formatBytes(item.plan.file.size)}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if inThread}
			<label class="mb-2 flex w-fit cursor-pointer items-center gap-2 px-1 text-xs text-muted">
				<input type="checkbox" bind:checked={alsoSendToRoom} class="h-4 w-4 rounded border-border accent-primary" />
				<span>Also send to {alsoSendLabel}</span>
			</label>
		{/if}

		{#if !editing}
			<label class="mb-2 flex w-fit cursor-pointer items-center gap-2 px-1 text-xs font-medium text-muted">
				<Switch bind:checked={sendOriginalImages} aria-label="Send original image files" />
				<ImageIcon class="h-4 w-4" />
				<span>Send original images</span>
			</label>
		{/if}

		<div class="flex min-w-0 items-end gap-1 sm:gap-1.5">
			<input
				bind:this={fileInput}
				type="file"
				multiple
				accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.csv,.json"
				class="hidden"
				onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)}
			/>
			<button
				onclick={() => fileInput?.click()}
				disabled={editing}
				class="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-foreground sm:h-10 sm:w-10"
				aria-label="Attach files"
			>
				<Paperclip class="h-5 w-5" />
			</button>
			<button
				onclick={() => (markdown = !markdown)}
				aria-pressed={markdown}
				title="Markdown formatting"
				class={cn(
					'hidden h-9 w-9 shrink-0 place-items-center rounded-xl transition sm:grid sm:h-10 sm:w-10',
					markdown ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-foreground'
				)}
				aria-label="Toggle Markdown"
			>
				<Sparkles class="h-5 w-5" />
			</button>

			<div class="min-w-0 flex-1">
				<Textarea
					bind:el={textareaEl}
					bind:value={text}
					onfocus={notifyComposerFocus}
					onpointerdown={notifyComposerFocus}
					onkeydown={onKeydown}
					maxRows={6}
					class="min-w-0"
					placeholder={inThread ? 'Reply in thread…' : markdown ? 'Write with Markdown…' : 'Message…'}
					aria-label={inThread ? 'Reply in thread' : 'Message'}
				/>
			</div>

			<button
				onpointerdown={(event) => event.preventDefault()}
				onclick={send}
				disabled={!ready || sending || uploading}
				class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground transition enabled:hover:bg-primary-hover disabled:opacity-40 enabled:active:scale-95 sm:h-10 sm:w-10"
				aria-label="Send message"
			>
				<SendHorizontal class="h-5 w-5" />
			</button>
		</div>
	</div>
{/if}
