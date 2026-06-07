<script lang="ts">
	import { goto } from '$app/navigation';
	import { Search, Users } from '@lucide/svelte';
	import type { Principal } from '$lib/api/types';
	import { api, isApiError } from '$lib/api';
	import { compose } from '$lib/stores/compose.svelte';
	import { principals, rooms, toasts } from '$lib/stores';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import TextInput from '$lib/components/ui/TextInput.svelte';

	let mode = $state<'direct' | 'group'>('direct');
	let query = $state('');
	let groupName = $state('');
	let busy = $state(false);

	// Reset + ensure directory is loaded whenever the dialog opens.
	$effect(() => {
		if (compose.isOpen) {
			mode = 'direct';
			query = '';
			groupName = '';
			void principals.load();
		}
	});

	const candidates = $derived(
		[...principals.humans, ...principals.agents].filter((p) =>
			p.displayName.toLowerCase().includes(query.trim().toLowerCase())
		)
	);

	async function startDirect(principal: Principal) {
		if (busy) return;
		busy = true;
		try {
			const existing = rooms.list.find(
				(r) =>
					r.type === 'direct' &&
					r.status !== 'deleted' &&
					rooms.otherMembers(r).some((m) => m.principalId === principal.principalId)
			);
			const room = existing ?? (await api.createDirectRoom(principal.principalId));
			rooms.upsert(room);
			compose.close();
			await goto(`/app/${room.roomId}`);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not start the conversation.');
		} finally {
			busy = false;
		}
	}

	async function createGroup() {
		if (!groupName.trim() || busy) return;
		busy = true;
		try {
			const room = await api.createGroupRoom(groupName.trim());
			rooms.upsert(room);
			compose.close();
			toasts.success('Group created. Invite people from the group menu.');
			await goto(`/app/${room.roomId}`);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not create the group.');
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:open={compose.isOpen} title="New conversation">
	<div class="space-y-4">
		<Segmented
			bind:value={mode}
			options={[
				{ value: 'direct', label: 'Direct' },
				{ value: 'group', label: 'Group' }
			]}
			class="w-full"
		/>

		{#if mode === 'direct'}
			<div class="relative flex items-center">
				<Search class="pointer-events-none absolute left-3 h-4 w-4 text-faint" />
				<input
					bind:value={query}
					placeholder="Search people and agents"
					class="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary"
				/>
			</div>
			<div class="max-h-[46vh] space-y-0.5 overflow-y-auto sm:max-h-80">
				{#if !principals.loaded && principals.loading}
					<p class="py-6 text-center text-sm text-muted">Loading directory…</p>
				{:else if candidates.length === 0}
					<p class="py-6 text-center text-sm text-muted">No matching people or agents.</p>
				{:else}
					{#each candidates as principal (principal.principalId)}
						<button
							onclick={() => startDirect(principal)}
							disabled={busy}
							class="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-surface-2 disabled:opacity-60"
						>
							<Avatar
								name={principal.displayName}
								seed={principal.principalId}
								isAgent={principal.principalType === 'agent'}
								size="sm"
							/>
							<span class="min-w-0 flex-1 truncate font-medium text-foreground">
								{principal.displayName}
							</span>
							{#if principal.principalType === 'agent'}
								<Badge tone="agent">Agent</Badge>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		{:else}
			<Field label="Group name" for="group-name" hint="You can invite people and add agents after creating.">
				<TextInput id="group-name" bind:value={groupName} placeholder="e.g. Billing operations" maxlength={120} />
			</Field>
			<div class="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3 text-xs text-muted">
				<Users class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
				<p>Groups start with just you as owner. Invite humans and add agents from the group details once it exists.</p>
			</div>
		{/if}
	</div>

	{#snippet footer()}
		{#if mode === 'group'}
			<Button variant="ghost" onclick={() => compose.close()}>Cancel</Button>
			<Button onclick={createGroup} loading={busy} disabled={!groupName.trim()}>Create group</Button>
		{:else}
			<Button variant="ghost" onclick={() => compose.close()}>Cancel</Button>
		{/if}
	{/snippet}
</Modal>
