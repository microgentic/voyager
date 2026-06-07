<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		ArrowLeft, Search, UserPlus, Bot, LogOut, Archive, Pencil, Check,
		Crown, ShieldCheck, MoreVertical, Users, FolderPlus
	} from '@lucide/svelte';
	import type { Membership, Room } from '$lib/api/types';
	import { api, isApiError } from '$lib/api';
	import { rooms, principals, sync, toasts } from '$lib/stores';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import TextInput from '$lib/components/ui/TextInput.svelte';
	import Textarea from '$lib/components/ui/Textarea.svelte';
	import CollectionPicker from './CollectionPicker.svelte';
	import { avatarGradient } from '$lib/utils/avatar';
	import { cn } from '$lib/utils/cn';

	let { room, open = $bindable(false) }: { room: Room; open?: boolean } = $props();

	type View = 'main' | 'invite' | 'addAgent';
	let view = $state<View>('main');
	let query = $state('');
	let busy = $state(false);

	let editing = $state(false);
	let editName = $state('');
	let editDescription = $state('');

	let confirmLeave = $state(false);
	let confirmArchive = $state(false);
	let removeTarget = $state<Membership | null>(null);
	let showCollections = $state(false);

	const isGroup = $derived(room.type === 'group');
	const canManage = $derived(rooms.canManage(room));
	const isOwner = $derived(rooms.myRole(room) === 'owner');
	const me = $derived(rooms.myMembership(room)?.principalId);
	const active = $derived(rooms.activeMembers(room));
	const members = $derived(active.filter((m) => m.principalType === 'human'));
	const agentMembers = $derived(active.filter((m) => m.principalType === 'agent'));
	const counterpart = $derived(rooms.counterpart(room));
	const title = $derived(rooms.displayName(room));

	// reset transient state whenever the panel (re)opens
	$effect(() => {
		if (open) {
			view = 'main';
			query = '';
			editing = false;
		}
	});

	const inviteCandidates = $derived(
		principals.humans
			.filter((p) => !active.some((m) => m.principalId === p.principalId))
			.filter((p) => p.displayName.toLowerCase().includes(query.trim().toLowerCase()))
	);
	const agentCandidates = $derived(
		principals.agents
			.filter((p) => !active.some((m) => m.principalId === p.principalId))
			.filter((p) => p.displayName.toLowerCase().includes(query.trim().toLowerCase()))
	);

	function startEdit(): void {
		editName = room.name ?? '';
		editDescription = room.description ?? '';
		editing = true;
	}

	async function saveEdit(): Promise<void> {
		busy = true;
		try {
			await api.updateRoom(room.roomId, { name: editName.trim(), description: editDescription.trim() });
			await rooms.refresh(room.roomId);
			editing = false;
			toasts.success('Group updated.');
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not update group.');
		} finally {
			busy = false;
		}
	}

	async function invite(principalId: string): Promise<void> {
		busy = true;
		try {
			await api.inviteToRoom(room.roomId, principalId, 'member');
			toasts.success('Invitation sent.');
			view = 'main';
			query = '';
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not send the invitation.');
		} finally {
			busy = false;
		}
	}

	async function addAgent(principalId: string): Promise<void> {
		busy = true;
		try {
			await api.addRoomMember(room.roomId, principalId, 'agent');
			await rooms.refresh(room.roomId);
			sync.pokeNow();
			toasts.success('Agent added.');
			view = 'main';
			query = '';
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not add the agent.');
		} finally {
			busy = false;
		}
	}

	async function setRole(member: Membership, role: 'admin' | 'member'): Promise<void> {
		try {
			await api.updateMemberRole(room.roomId, member.principalId, role);
			await rooms.refresh(room.roomId);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not change role.');
		}
	}

	async function transferOwnership(member: Membership): Promise<void> {
		try {
			await api.proposeOwnershipTransfer(room.roomId, member.principalId);
			toasts.success(`Ownership offered to ${member.displayName}. They must accept it.`);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not propose transfer.');
		}
	}

	async function confirmRemove(): Promise<void> {
		if (!removeTarget) return;
		busy = true;
		try {
			await api.removeMember(room.roomId, removeTarget.principalId);
			await rooms.refresh(room.roomId);
			toasts.success('Member removed.');
			removeTarget = null;
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not remove member.');
		} finally {
			busy = false;
		}
	}

	async function leave(): Promise<void> {
		busy = true;
		try {
			await api.leaveRoom(room.roomId);
			rooms.remove(room.roomId);
			confirmLeave = false;
			open = false;
			await goto('/app');
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not leave. A group must keep an owner.');
		} finally {
			busy = false;
		}
	}

	async function archive(): Promise<void> {
		busy = true;
		try {
			const updated = await api.archiveRoom(room.roomId);
			rooms.upsert(updated);
			confirmArchive = false;
			toasts.success('Conversation archived.');
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not archive.');
		} finally {
			busy = false;
		}
	}

	function roleBadge(role: Membership['role']) {
		if (role === 'owner') return { tone: 'primary' as const, label: 'Owner', icon: Crown };
		if (role === 'admin') return { tone: 'neutral' as const, label: 'Admin', icon: ShieldCheck };
		return null;
	}
</script>

<Modal bind:open title={view === 'main' ? '' : view === 'invite' ? 'Invite people' : 'Add an agent'} hideClose={view !== 'main'}>
	{#if view !== 'main'}
		<button onclick={() => (view = 'main')} class="mb-3 -ml-1 flex items-center gap-1 text-sm text-muted hover:text-foreground">
			<ArrowLeft class="h-4 w-4" /> Back
		</button>
		<div class="relative mb-3 flex items-center">
			<Search class="pointer-events-none absolute left-3 h-4 w-4 text-faint" />
			<input bind:value={query} placeholder="Search" class="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary" />
		</div>
		<div class="max-h-[50vh] space-y-0.5 overflow-y-auto sm:max-h-80">
			{#each view === 'invite' ? inviteCandidates : agentCandidates as p (p.principalId)}
				<button
					onclick={() => (view === 'invite' ? invite(p.principalId) : addAgent(p.principalId))}
					disabled={busy}
					class="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-surface-2 disabled:opacity-50"
				>
					<Avatar name={p.displayName} seed={p.principalId} isAgent={p.principalType === 'agent'} size="sm" />
					<span class="min-w-0 flex-1 truncate font-medium">{p.displayName}</span>
					{#if view === 'invite'}<UserPlus class="h-4 w-4 text-primary" />{:else}<Bot class="h-4 w-4 text-agent" />{/if}
				</button>
			{:else}
				<p class="py-8 text-center text-sm text-muted">
					{view === 'invite' ? 'Everyone is already here.' : 'No agents available to add.'}
				</p>
			{/each}
		</div>
	{:else}
		<!-- Identity -->
		<div class="flex flex-col items-center pb-2 text-center">
			{#if isGroup}
				<span class="grid h-20 w-20 place-items-center rounded-full text-white" style="background-image:{avatarGradient(room.roomId)}">
					<Users class="h-8 w-8" />
				</span>
			{:else}
				<Avatar name={counterpart?.displayName ?? title} seed={counterpart?.principalId ?? room.roomId} isAgent={rooms.isAgentDirect(room)} size="xl" />
			{/if}

			{#if editing}
				<div class="mt-3 w-full space-y-2 text-left">
					<TextInput bind:value={editName} placeholder="Group name" maxlength={120} />
					<Textarea bind:value={editDescription} placeholder="Description (optional)" maxRows={4} maxlength={1000} />
					<div class="flex justify-end gap-2">
						<Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
						<Button size="sm" loading={busy} onclick={saveEdit} disabled={!editName.trim()}>
							<Check class="h-4 w-4" /> Save
						</Button>
					</div>
				</div>
			{:else}
				<h2 class="mt-3 flex items-center gap-2 text-lg font-semibold text-foreground">
					{title}
					{#if isGroup && canManage}
						<button onclick={startEdit} class="text-muted hover:text-foreground" aria-label="Edit"><Pencil class="h-4 w-4" /></button>
					{/if}
				</h2>
				<p class="text-sm text-muted">
					{#if isGroup}{active.length} {active.length === 1 ? 'member' : 'members'}{:else if rooms.isAgentDirect(room)}AI agent · direct{:else}Direct message{/if}
				</p>
				{#if room.description}<p class="mt-1.5 max-w-xs text-sm text-muted">{room.description}</p>{/if}
			{/if}
		</div>

		<!-- Quick actions -->
		<div class="my-3 flex flex-wrap justify-center gap-2">
			<Button size="sm" variant="secondary" onclick={() => (showCollections = true)}>
				<FolderPlus class="h-4 w-4" /> Collections
			</Button>
			{#if isGroup && canManage}
				<Button size="sm" variant="secondary" onclick={() => (view = 'invite')}>
					<UserPlus class="h-4 w-4" /> Invite
				</Button>
				<Button size="sm" variant="secondary" onclick={() => { view = 'addAgent'; void principals.load(); }}>
					<Bot class="h-4 w-4" /> Add agent
				</Button>
			{/if}
		</div>

		<!-- Members -->
		{#if isGroup}
			<div class="space-y-1">
				<p class="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-faint">Members</p>
				{#each [...members, ...agentMembers] as member (member.principalId)}
					{@const badge = roleBadge(member.role)}
					{@const isMe = member.principalId === me}
					<div class="flex items-center gap-3 rounded-xl px-1.5 py-1.5">
						<Avatar name={member.displayName} seed={member.principalId} isAgent={member.principalType === 'agent'} size="sm" />
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								<span class="truncate font-medium text-foreground">{member.displayName}{isMe ? ' (you)' : ''}</span>
								{#if member.principalType === 'agent'}<Badge tone="agent">Agent</Badge>{/if}
							</span>
						</span>
						{#if badge}
							{@const BadgeIcon = badge.icon}
							<Badge tone={badge.tone}><BadgeIcon class="h-3 w-3" /> {badge.label}</Badge>
						{/if}
						{#if canManage && !isMe && member.role !== 'owner'}
							<Menu align="end" class="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground" label="Member actions">
								{#snippet trigger()}<MoreVertical class="h-4 w-4" />{/snippet}
								{#if member.principalType === 'human'}
									{#if member.role === 'member'}
										<MenuItem onSelect={() => setRole(member, 'admin')}>
											{#snippet icon()}<ShieldCheck class="h-4 w-4" />{/snippet}
											Make admin
										</MenuItem>
									{:else}
										<MenuItem onSelect={() => setRole(member, 'member')}>
											{#snippet icon()}<Users class="h-4 w-4" />{/snippet}
											Revoke admin
										</MenuItem>
									{/if}
									{#if isOwner}
										<MenuItem onSelect={() => transferOwnership(member)}>
											{#snippet icon()}<Crown class="h-4 w-4" />{/snippet}
											Transfer ownership
										</MenuItem>
									{/if}
									<MenuSeparator />
								{/if}
								<MenuItem danger onSelect={() => (removeTarget = member)}>
									{#snippet icon()}<LogOut class="h-4 w-4" />{/snippet}
									Remove
								</MenuItem>
							</Menu>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Destructive -->
		<div class="mt-4 space-y-1 border-t border-border pt-3">
			{#if isOwner && isGroup && room.status === 'active'}
				<button onclick={() => (confirmArchive = true)} class="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-2">
					<Archive class="h-4.5 w-4.5 text-muted" /> Archive conversation
				</button>
			{/if}
			<button onclick={() => (confirmLeave = true)} class="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-sm text-danger transition hover:bg-danger-soft">
				<LogOut class="h-4.5 w-4.5" /> {isGroup ? 'Leave group' : 'Leave conversation'}
			</button>
		</div>
	{/if}
</Modal>

<ConfirmDialog
	bind:open={confirmLeave}
	title={isGroup ? 'Leave this group?' : 'Leave this conversation?'}
	message="You’ll stop receiving new messages here. Local history stays on this device."
	confirmLabel="Leave"
	danger
	loading={busy}
	onConfirm={leave}
/>
<ConfirmDialog
	bind:open={confirmArchive}
	title="Archive conversation?"
	message="Archived conversations become read-only for everyone."
	confirmLabel="Archive"
	loading={busy}
	onConfirm={archive}
/>
<ConfirmDialog
	open={removeTarget !== null}
	title="Remove member?"
	message={removeTarget ? `${removeTarget.displayName} will be removed from the group.` : ''}
	confirmLabel="Remove"
	danger
	loading={busy}
	onConfirm={confirmRemove}
/>
{#if showCollections}
	<CollectionPicker {room} bind:open={showCollections} />
{/if}
