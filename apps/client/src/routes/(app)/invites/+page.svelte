<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Inbox, Users, MessageSquare, ShieldCheck } from '@lucide/svelte';
	import type { RoomInvitation } from '$lib/api/types';
	import { isApiError } from '$lib/api';
	import { invitations, toasts } from '$lib/stores';
	import SectionHeader from '$lib/components/nav/SectionHeader.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { formatRelativeShort } from '$lib/utils/time';

	let busyId = $state<string | null>(null);

	onMount(() => {
		void invitations.load(true);
	});

	async function accept(invitation: RoomInvitation) {
		busyId = invitation.roomInvitationId;
		try {
			await invitations.accept(invitation.roomInvitationId);
			toasts.success(`Joined ${invitation.roomName ?? 'the conversation'}.`);
			await goto(`/app/${invitation.roomId}`);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not accept invitation.');
		} finally {
			busyId = null;
		}
	}

	async function decline(invitation: RoomInvitation) {
		busyId = invitation.roomInvitationId;
		try {
			await invitations.decline(invitation.roomInvitationId);
			toasts.info('Invitation declined.');
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not decline invitation.');
		} finally {
			busyId = null;
		}
	}
</script>

<svelte:head><title>Invites · Voyager</title></svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<SectionHeader title="Invitations" subtitle="Room invitations awaiting your response" />
	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-3xl px-4 py-4">
			{#if !invitations.loaded && invitations.loading}
				<div class="grid place-items-center py-20"><Spinner class="text-primary" /></div>
			{:else if invitations.list.length === 0}
				<EmptyState title="No pending invitations" description="When someone invites you to a group, it shows up here.">
					{#snippet icon()}<Inbox class="h-7 w-7" />{/snippet}
				</EmptyState>
			{:else}
				<div class="space-y-3">
					{#each invitations.list as invitation (invitation.roomInvitationId)}
						<div class="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3.5">
							<span class="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary-soft text-primary">
								{#if invitation.roomType === 'group'}<Users class="h-6 w-6" />{:else}<MessageSquare class="h-6 w-6" />{/if}
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate font-semibold text-foreground">{invitation.roomName ?? 'Conversation'}</span>
									<Badge tone="neutral">{invitation.role}</Badge>
								</div>
								<p class="truncate text-sm text-muted">
									From {invitation.invitedByDisplayName} · {formatRelativeShort(invitation.createdAt)}
								</p>
							</div>
							<div class="flex shrink-0 gap-2">
								<Button size="sm" variant="ghost" disabled={busyId === invitation.roomInvitationId} onclick={() => decline(invitation)}>
									Decline
								</Button>
								<Button size="sm" loading={busyId === invitation.roomInvitationId} onclick={() => accept(invitation)}>
									Accept
								</Button>
							</div>
						</div>
					{/each}
				</div>
				<p class="mt-5 flex items-center justify-center gap-1.5 text-xs text-faint">
					<ShieldCheck class="h-3.5 w-3.5" /> Joining shares your messaging identity with the room
				</p>
			{/if}
		</div>
	</div>
</div>
