<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Bot, Plus, MessageSquare, Clock3, CircleCheck, CircleX, Hourglass } from '@lucide/svelte';
	import type { AgentRequest, AgentRequestStatus, Principal } from '$lib/api/types';
	import { api, isApiError } from '$lib/api';
	import { auth, principals, rooms, toasts } from '$lib/stores';
	import SectionHeader from '$lib/components/nav/SectionHeader.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import TextInput from '$lib/components/ui/TextInput.svelte';
	import Textarea from '$lib/components/ui/Textarea.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { formatRelativeShort } from '$lib/utils/time';

	let requests = $state<AgentRequest[]>([]);
	let loading = $state(true);
	let starting = $state<string | null>(null);

	let showRequest = $state(false);
	let agentName = $state('');
	let summary = $state('');
	let submitting = $state(false);

	const statusMeta: Record<AgentRequestStatus, { tone: 'neutral' | 'primary' | 'success' | 'danger' | 'warning'; label: string }> = {
		submitted: { tone: 'neutral', label: 'Submitted' },
		under_review: { tone: 'warning', label: 'Under review' },
		approved: { tone: 'primary', label: 'Approved' },
		provisioning: { tone: 'primary', label: 'Provisioning' },
		active: { tone: 'success', label: 'Active' },
		rejected: { tone: 'danger', label: 'Rejected' },
		closed: { tone: 'neutral', label: 'Closed' }
	};

	async function load() {
		loading = true;
		try {
			const page = await api.listAgentRequests({ limit: 100 });
			requests = page.items;
		} catch {
			/* ignore */
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void principals.load();
		void load();
	});

	async function messageAgent(agent: Principal) {
		starting = agent.principalId;
		try {
			const existing = rooms.list.find(
				(r) =>
					r.type === 'direct' &&
					r.status !== 'deleted' &&
					rooms.otherMembers(r).some((m) => m.principalId === agent.principalId)
			);
			const room = existing ?? (await api.createDirectRoom(agent.principalId));
			rooms.upsert(room);
			await goto(`/app/${room.roomId}`);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not open the agent chat.');
		} finally {
			starting = null;
		}
	}

	async function submitRequest() {
		if (!agentName.trim() || !summary.trim() || submitting) return;
		submitting = true;
		try {
			await api.createAgentRequest({ desiredAgentName: agentName.trim(), summary: summary.trim() });
			toasts.success('Agent request submitted for review.');
			agentName = '';
			summary = '';
			showRequest = false;
			await load();
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not submit the request.');
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head><title>Agents · Voyager</title></svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<SectionHeader title="Agents" subtitle="AI agents you can message">
		{#snippet actions()}
			<Button size="sm" onclick={() => (showRequest = true)}>
				<Plus class="h-4 w-4" /> Request
			</Button>
		{/snippet}
	</SectionHeader>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-3xl space-y-6 px-4 py-4">
			<section>
				<h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-faint">Available agents</h2>
				{#if !principals.loaded && principals.loading}
					<div class="grid place-items-center py-10"><Spinner class="text-primary" /></div>
				{:else if principals.agents.length === 0}
					<div class="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted">
						No agents are available yet. Request one and an administrator will provision it.
					</div>
				{:else}
					<div class="space-y-2">
						{#each principals.agents as agent (agent.principalId)}
							<div class="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
								<Avatar name={agent.displayName} seed={agent.principalId} isAgent size="md" />
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-1.5">
										<span class="truncate font-semibold text-foreground">{agent.displayName}</span>
										<Badge tone="agent">Agent</Badge>
									</div>
									{#if agent.ownerPrincipalId === auth.principal?.principalId}
										<p class="text-xs text-muted">Owned by you</p>
									{/if}
								</div>
								<Button size="sm" variant="secondary" loading={starting === agent.principalId} onclick={() => messageAgent(agent)}>
									<MessageSquare class="h-4 w-4" /> Message
								</Button>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section>
				<h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-faint">Your requests</h2>
				{#if loading}
					<div class="grid place-items-center py-10"><Spinner class="text-primary" /></div>
				{:else if requests.length === 0}
					<EmptyState title="No agent requests" description="Request a custom agent for your team or workflow.">
						{#snippet icon()}<Bot class="h-7 w-7" />{/snippet}
						<Button onclick={() => (showRequest = true)}><Plus class="h-4 w-4" /> Request an agent</Button>
					</EmptyState>
				{:else}
					<div class="space-y-2">
						{#each requests as request (request.requestId)}
							{@const meta = statusMeta[request.status]}
							<div class="rounded-2xl border border-border bg-surface p-3.5">
								<div class="flex items-center justify-between gap-2">
									<span class="truncate font-semibold text-foreground">{request.desiredAgentName}</span>
									<Badge tone={meta.tone}>{meta.label}</Badge>
								</div>
								<p class="mt-1 line-clamp-2 text-sm text-muted">{request.summary}</p>
								<p class="mt-1.5 text-xs text-faint">Requested {formatRelativeShort(request.createdAt)}</p>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</div>
</div>

<Modal bind:open={showRequest} title="Request an agent" description="An administrator reviews and provisions agents.">
	<div class="space-y-4">
		<Field label="Agent name" for="agent-name">
			<TextInput id="agent-name" bind:value={agentName} placeholder="e.g. Billing Assistant" maxlength={120} />
		</Field>
		<Field label="What should it do?" for="agent-summary" hint="Describe the agent’s purpose, scope, and any rules.">
			<Textarea id="agent-summary" bind:value={summary} placeholder="Summary of the agent’s responsibilities…" maxRows={6} maxlength={2000} />
		</Field>
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (showRequest = false)}>Cancel</Button>
		<Button loading={submitting} disabled={!agentName.trim() || !summary.trim()} onclick={submitRequest}>
			Submit request
		</Button>
	{/snippet}
</Modal>
