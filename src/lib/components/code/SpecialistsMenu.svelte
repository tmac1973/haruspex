<script lang="ts">
	/**
	 * The session header's Specialists menu: which of Settings → Code →
	 * Specialists this session offers its agent (`ask_specialist`). Hidden
	 * while there are none. Applies from the next turn.
	 */
	import { specialistEntries } from '#lib/specialists/entries.ts';
	import { specialistKind } from '#lib/specialists/kinds.ts';
	import '#lib/specialists/kinds/index.ts';
	import { sessionSpecialists } from '#lib/specialists/session.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	// Read live so the menu follows Settings → Code → Specialists.
	const settings = $derived(getLiveSettings());
	const entries = $derived.by(() => {
		void settings;
		return specialistEntries();
	});
	const onIds = $derived.by(() => {
		void settings;
		return new Set(sessionSpecialists(session.specialists).map((e) => e.id));
	});

	let open = $state(false);
	let wrap = $state<HTMLElement>();

	async function store(ids: string[] | null) {
		try {
			await session.setSessionSpecialists(ids);
		} catch (e) {
			showToast(`Couldn't change the specialists: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function toggle(id: string, on: boolean) {
		const next = entries.filter((e) => (e.id === id ? on : onIds.has(e.id))).map((e) => e.id);
		void store(next);
	}

	function closeOutside(e: MouseEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={closeOutside} />

{#if entries.length > 0}
	<span class="wrap" bind:this={wrap}>
		<button
			class="pick"
			aria-expanded={open}
			title="Small models the agent can hand a job to. Applies from the next message."
			onclick={() => (open = !open)}
		>
			Specialists: {onIds.size} ▾
		</button>
		{#if open}
			<div class="panel" role="dialog" aria-label="Specialists">
				{#each entries as e (e.id)}
					{@const writes = specialistKind(e.kind)?.writes ?? false}
					<label
						class="item"
						title={writes && session.readOnly ? 'This session is read-only.' : undefined}
					>
						<input
							type="checkbox"
							checked={onIds.has(e.id)}
							disabled={session.busy || (writes && session.readOnly)}
							onchange={(ev) => toggle(e.id, ev.currentTarget.checked)}
						/>
						<span>{e.name}</span>
					</label>
				{/each}
				<button
					class="defaults"
					disabled={session.busy || session.specialists === null}
					title="The ones marked On by default in Settings → Code → Specialists."
					onclick={() => void store(null)}>Use defaults</button
				>
			</div>
		{/if}
	</span>
{/if}

<style>
	.wrap {
		position: relative;
	}

	.pick {
		padding: 3px 6px;
		font-size: 0.76rem;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		cursor: pointer;
		white-space: nowrap;
	}

	.panel {
		position: absolute;
		left: 0;
		top: calc(100% + 6px);
		z-index: 50;
		min-width: 200px;
		max-height: 320px;
		overflow-y: auto;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
	}

	.item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		border-radius: 5px;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.item:hover {
		background: var(--bg-secondary);
	}

	.defaults {
		margin-top: 4px;
		padding: 4px 6px;
		font-size: 0.76rem;
		text-align: left;
		background: none;
		border: none;
		border-top: 1px solid var(--border);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.defaults:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
