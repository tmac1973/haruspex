<script lang="ts">
	/**
	 * One session's header: its folder, model (see CodeModelPicker) and reasoning effort, the
	 * repo's AGENTS.md, how full the context is, and its background processes.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import AgentsMdBadge from '#lib/components/shell/AgentsMdBadge.svelte';
	import ContextGauge from '#lib/components/ContextGauge.svelte';
	import BackgroundChip from './BackgroundChip.svelte';
	import CodeModelPicker from './CodeModelPicker.svelte';
	import { folderName } from '#lib/code/sessionList.ts';
	import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { setRepoTrusted } from '#lib/skills/project.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	// Read live so a session following Settings re-resolves when Settings
	// changes model; the descriptor itself reads settings untracked.
	const settings = $derived(getLiveSettings());
	const effortCaps = $derived.by(() => {
		void settings;
		return resolveBackendDescriptor(session.backend ?? undefined).reasoningEffort;
	});
	const effortLevels = $derived.by(() => {
		const levels = effortCaps?.levels ?? [];
		return session.effort && !levels.includes(session.effort)
			? [...levels, session.effort]
			: levels;
	});
	const globalEffort = $derived(settings.reasoningEffort ?? 'model default');

	async function pickEffort(value: string) {
		try {
			await session.setEffort(value || null);
		} catch (e) {
			showToast(`Couldn't change the effort: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function openFolder() {
		invoke('open_folder', { path: session.root }).catch((e: unknown) =>
			showToast(`Couldn't open the folder: ${errMessage(e)}`, { kind: 'error' })
		);
	}

	function ignoreProject() {
		if (!session.projectRoot) return;
		setRepoTrusted(session.projectRoot, false);
		session.projectRoot = null;
		session.agentsMd = null;
	}
</script>

<div class="header">
	<button class="folder" title="{session.root} — open in the file manager" onclick={openFolder}>
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
			></path></svg
		>
		<span>{folderName(session.root)}</span>
	</button>

	<CodeModelPicker {session} />

	<select
		class="pick"
		aria-label="Reasoning effort"
		title={effortCaps
			? 'How hard the model thinks. Applies from the next message.'
			: 'This model publishes no effort levels.'}
		value={session.effort ?? ''}
		disabled={session.busy || effortLevels.length === 0}
		onchange={(e) => pickEffort(e.currentTarget.value)}
	>
		<option value="">Effort: Settings ({globalEffort})</option>
		{#each effortLevels as level (level)}
			<option value={level}>Effort: {level}</option>
		{/each}
	</select>

	<span class="spacer"></span>

	{#if session.agentsMd}
		<AgentsMdBadge
			agentsMd={session.agentsMd}
			root={session.projectRoot}
			onIgnore={ignoreProject}
		/>
	{/if}
	{#if session.usage}
		<ContextGauge
			promptTokens={session.usage.promptTokens}
			contextSize={session.usage.contextSize}
			label="This session"
			compact
		/>
	{/if}
	<BackgroundChip {session} />
</div>

<style>
	.header {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
		flex: 0 0 auto;
	}

	.folder {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		appearance: none;
		background: none;
		border: 1px solid transparent;
		border-radius: 6px;
		padding: 3px 6px;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-primary);
		cursor: pointer;
	}

	.folder:hover {
		border-color: var(--border);
		background: var(--bg-secondary);
	}

	.folder svg {
		color: var(--accent);
	}

	.pick {
		max-width: 220px;
		padding: 3px 6px;
		font-size: 0.76rem;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.pick:disabled {
		opacity: 0.6;
	}

	.spacer {
		flex: 1;
	}
</style>
