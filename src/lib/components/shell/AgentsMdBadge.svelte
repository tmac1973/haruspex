<script lang="ts">
	/**
	 * The Shell sidebar's sign that a repo's AGENTS.md is in the turn, and the
	 * nearest place to stop it: Settings → Skills → Repos is a long way from
	 * the moment you notice instructions you'd rather not have.
	 */
	import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
	import { describeAgentsMd } from '#lib/skills/agentsMd.ts';

	let {
		agentsMd,
		root,
		onIgnore
	}: { agentsMd: AgentsMd; root: string | null; onIgnore: () => void } = $props();

	let open = $state(false);
	let wrap = $state<HTMLElement>();

	function closeOutside(e: MouseEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window
	onclick={closeOutside}
	onkeydown={(e) => {
		if (e.key === 'Escape') open = false;
	}}
/>

<span class="wrap" bind:this={wrap}>
	<button
		class="agents-badge"
		class:warn={agentsMd.truncated}
		aria-expanded={open}
		title={describeAgentsMd(agentsMd)}
		onclick={() => (open = !open)}>AGENTS.md</button
	>
	{#if open}
		<div class="panel" role="dialog" aria-label="This repo's instructions">
			<p>
				{describeAgentsMd(agentsMd)}{#if root}&nbsp;from <code>{root}</code>{/if}.
			</p>
			{#if root}
				<button
					class="btn btn-small"
					onclick={() => {
						open = false;
						onIgnore();
					}}>Stop using this repo's instructions</button
				>
				<p class="hint">Settings → Skills → Repos turns them back on.</p>
			{/if}
		</div>
	{/if}
</span>

<style>
	.wrap {
		position: relative;
		display: inline-flex;
	}

	.agents-badge {
		font-size: 0.7rem;
		padding: 1px 6px;
		border: none;
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-family: monospace;
		cursor: pointer;
	}

	.agents-badge.warn {
		color: var(--warning);
	}

	.panel {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 20;
		width: 260px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
		font-size: 0.8rem;
	}

	.panel p {
		margin: 0 0 8px;
		overflow-wrap: anywhere;
	}

	.panel .hint {
		margin: 6px 0 0;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}
</style>
