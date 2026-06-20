<script lang="ts">
	import { Paperclip, SendHorizontal, X, Sparkles, Archive, Ban } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import type { AttachmentRef } from '$lib/protocol/codec';
	import { api, isApiError } from '$lib/api';
	import { messages, rooms, sync, ui, toasts } from '$lib/stores';
	import Textarea from '$lib/components/ui/Textarea.svelte';
	import { cn } from '$lib/utils/cn';
	import { formatBytes } from '$lib/utils/format';
	import { localId } from '$lib/utils/id';

	let { room }: { room: Room } = $props();

	interface Pending {
		id: string;
		name: string;
		mediaType: string;
		bytes: number;
		ref?: AttachmentRef;
		status: 'uploading' | 'ready' | 'error';
	}

	let text = $state('');
	let markdown = $state(false);
	let sending = $state(false);
	let pending = $state<Pending[]>([]);
	let textareaEl = $state<HTMLTextAreaElement>();
	let fileInput = $state<HTMLInputElement>();

	const membership = $derived(rooms.myMembership(room));
	const blocked = $derived(!membership || membership.status !== 'active');
	const archived = $derived(room.status !== 'active');
	const uploading = $derived(pending.some((p) => p.status === 'uploading'));
	const ready = $derived(text.trim().length > 0 || pending.some((p) => p.status === 'ready'));

	async function addFiles(files: FileList | null) {
		if (!files) return;
		for (const file of Array.from(files).slice(0, 10 - pending.length)) {
			const id = localId('att');
			pending = [
				...pending,
				{ id, name: file.name, mediaType: file.type || 'application/octet-stream', bytes: file.size, status: 'uploading' }
			];
			try {
				const allocated = await api.allocateAttachment(room.roomId, {
					expectedBytes: Math.max(1, file.size),
					contentCategory: file.type || 'application/octet-stream'
				});
				await api.uploadAttachmentBlob(allocated.attachmentId, await file.arrayBuffer());
				await api.completeAttachment(allocated.attachmentId, { ciphertextBytes: file.size });
				const ref: AttachmentRef = {
					attachmentId: allocated.attachmentId,
					name: file.name,
					mediaType: file.type || 'application/octet-stream',
					bytes: file.size
				};
				pending = pending.map((p) => (p.id === id ? { ...p, ref, status: 'ready' } : p));
			} catch (err) {
				pending = pending.map((p) => (p.id === id ? { ...p, status: 'error' } : p));
				toasts.error(isApiError(err) ? err.display : `Couldn’t upload ${file.name}.`);
			}
		}
		if (fileInput) fileInput.value = '';
	}

	function removePending(id: string): void {
		const target = pending.find((p) => p.id === id);
		if (target?.ref) void api.deleteAttachment(target.ref.attachmentId).catch(() => undefined);
		pending = pending.filter((p) => p.id !== id);
	}

	async function send(): Promise<void> {
		if (!ready || sending || uploading || blocked || archived) return;
		const body = text.trim();
		const attachments = pending.filter((p) => p.status === 'ready' && p.ref).map((p) => p.ref!);
		sending = true;
		text = '';
		pending = [];
		try {
			await messages.sendText(room.roomId, {
				contentType: markdown ? 'text/markdown' : 'text/plain',
				body,
				attachments
			});
			sync.pokeNow();
		} catch {
			// The optimistic bubble is now marked failed (with retry) by the store.
			toasts.error('Message failed to send. Tap the message to retry.');
		} finally {
			sending = false;
			textareaEl?.focus();
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && ui.isWide && !event.isComposing) {
			event.preventDefault();
			void send();
		}
	}
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
	<div class="shrink-0 border-t border-border bg-surface pb-[calc(var(--sab)+0.5rem)] pl-[calc(var(--sal)+0.5rem)] pr-[calc(var(--sar)+1.5rem)] pt-2 sm:px-3">
		{#if pending.length > 0}
			<div class="mb-2 flex flex-wrap gap-2 px-1">
				{#each pending as item (item.id)}
					<span
						class={cn(
							'flex items-center gap-2 rounded-lg border px-2 py-1 text-xs',
							item.status === 'error' ? 'border-danger/40 text-danger' : 'border-border text-muted'
						)}
					>
						<span class="max-w-[10rem] truncate font-medium text-foreground">{item.name}</span>
						<span class="text-faint">{formatBytes(item.bytes)}</span>
						{#if item.status === 'uploading'}
							<span class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
						{/if}
						<button onclick={() => removePending(item.id)} aria-label="Remove" class="text-faint hover:text-foreground">
							<X class="h-3.5 w-3.5" />
						</button>
					</span>
				{/each}
			</div>
		{/if}

		<div class="flex min-w-0 items-end gap-1 sm:gap-1.5">
			<input
				bind:this={fileInput}
				type="file"
				multiple
				class="hidden"
				onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)}
			/>
			<button
				onclick={() => fileInput?.click()}
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
					onkeydown={onKeydown}
					maxRows={6}
					class="min-w-0"
					placeholder={markdown ? 'Write with Markdown…' : 'Message…'}
					aria-label="Message"
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
