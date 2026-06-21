<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { BellOff, ChevronDown, MessageSquareText, MessagesSquare } from '@lucide/svelte';
	import { messages, rooms, threads, toasts } from '$lib/stores';
	import type { ThreadInboxItem } from '$lib/api/types';
	import SectionHeader from '$lib/components/nav/SectionHeader.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { formatRelativeShort } from '$lib/utils/time';

	let busyRoot = $state<string | null>(null);

	onMount(() => {
		void threads.load(true);
	});

	function rootText(item: ThreadInboxItem): string {
		const cached = messages.findByEnvelopeId(item.room.roomId, item.root.envelopeId);
		const message = cached ?? null;
		if (!message) return 'Thread message';
		if (message.deletedForEveryone.deleted) return 'Message deleted';
		const text = message.content.body.trim();
		return text || 'Thread message';
	}

	function senderName(item: ThreadInboxItem): string {
		const sender = item.room.members.find((member) => member.principalId === item.root.senderPrincipalId);
		return sender?.displayName ?? rooms.displayName(item.room);
	}

	async function openThread(item: ThreadInboxItem): Promise<void> {
		await goto(`/app/${item.room.roomId}?thread=${item.root.envelopeId}`);
	}

	async function unfollow(item: ThreadInboxItem): Promise<void> {
		if (busyRoot) return;
		busyRoot = item.root.envelopeId;
		try {
			await threads.setFollowing(item.room.roomId, item.root.envelopeId, false);
			toasts.info('Thread removed from Threads.');
		} catch {
			toasts.error('Could not update thread follow state.');
		} finally {
			busyRoot = null;
		}
	}
</script>

<svelte:head><title>Threads · Voyager</title></svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<SectionHeader title="Threads" subtitle="Follow-ups from conversations you participate in" />

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-4xl px-4 py-4">
			{#if !threads.loaded && threads.loading}
				<div class="grid place-items-center py-20"><Spinner class="text-primary" /></div>
			{:else if threads.items.length === 0}
				<EmptyState title="No followed threads" description="Reply in a thread or follow one to keep it here.">
					{#snippet icon()}<MessagesSquare class="h-7 w-7" />{/snippet}
				</EmptyState>
			{:else}
				<div class="space-y-2">
					{#each threads.items as item (item.root.envelopeId)}
						<div
							class="group flex w-full items-start gap-3 rounded-2xl border border-border bg-surface p-3.5 text-left transition hover:border-primary/50 hover:bg-surface-2"
						>
							<button
								type="button"
								class="flex min-w-0 flex-1 items-start gap-3 text-left"
								onclick={() => openThread(item)}
							>
								<Avatar
									name={senderName(item)}
									seed={item.root.senderPrincipalId}
									size="md"
									badge={false}
								/>
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<span class="truncate font-semibold text-foreground">{rooms.displayName(item.room)}</span>
										{#if item.unreadCount > 0}
											<Badge tone="primary">{item.unreadCount} new</Badge>
										{/if}
										<span class="text-xs text-faint">{formatRelativeShort(item.updatedAt)}</span>
									</div>
									<p class="mt-0.5 line-clamp-2 text-sm text-muted">
										<span class="font-medium text-foreground">{senderName(item)}:</span>
										{rootText(item)}
									</p>
									<div class="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary">
										<MessageSquareText class="h-3.5 w-3.5" />
										<span>{item.root.threadSummary?.replyCount ?? 0} replies</span>
									</div>
								</div>
							</button>
							<Button
								size="sm"
								variant="ghost"
								loading={busyRoot === item.root.envelopeId}
								onclick={() => unfollow(item)}
							>
								<BellOff class="h-4 w-4" /> Unfollow
							</Button>
						</div>
					{/each}
				</div>
				{#if threads.nextCursor}
					<div class="mt-4 flex justify-center">
						<Button variant="secondary" loading={threads.loading} onclick={() => threads.loadMore()}>
							<ChevronDown class="h-4 w-4" /> More threads
						</Button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
