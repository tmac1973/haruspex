<script lang="ts">
	/**
	 * The session header's Extras menu: which specialists (Settings → Code →
	 * Specialists, `ask_specialist`) and helpers (Settings → Code → Helpers)
	 * this session offers its agent. One menu for both, to save room in the
	 * header. Hidden while there are neither. Applies from the next turn.
	 */
	import { helpers, sessionHelpers } from '#lib/helpers/registry.ts';
	import '#lib/helpers/index.ts';
	import { specialistEntries } from '#lib/specialists/entries.ts';
	import { specialistKind } from '#lib/specialists/kinds.ts';
	import '#lib/specialists/kinds/index.ts';
	import { sessionSpecialists } from '#lib/specialists/session.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	// Read live so the menu follows Settings → Code.
	const settings = $derived(getLiveSettings());
	const entries = $derived.by(() => {
		void settings;
		return specialistEntries();
	});
	const onIds = $derived.by(() => {
		void settings;
		return new Set(sessionSpecialists(session.specialists).map((e) => e.id));
	});
	const helperList = helpers();
	const helpersOn = $derived.by(() => {
		void settings;
		return new Set(sessionHelpers(session.helpers).map((h) => h.id));
	});
	const count = $derived(onIds.size + helpersOn.size);
	const custom = $derived(session.specialists !== null || session.helpers !== null);

	let open = $state(false);
	let wrap = $state<HTMLElement>();

	async function store(kind: 'specialists' | 'helpers', ids: string[] | null) {
		try {
			if (kind === 'specialists') await session.setSessionSpecialists(ids);
			else await session.setSessionHelpers(ids);
		} catch (e) {
			showToast(`Couldn't change the ${kind}: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function toggleSpecialist(id: string, on: boolean) {
		const next = entries.filter((e) => (e.id === id ? on : onIds.has(e.id))).map((e) => e.id);
		void store('specialists', next);
	}

	function toggleHelper(id: string, on: boolean) {
		const next = helperList
			.filter((h) => (h.id === id ? on : helpersOn.has(h.id)))
			.map((h) => h.id);
		void store('helpers', next);
	}

	async function useDefaults() {
		if (session.specialists !== null) await store('specialists', null);
		if (session.helpers !== null) await store('helpers', null);
	}

	function closeOutside(e: MouseEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={closeOutside} />

{#if entries.length > 0 || helperList.length > 0}
	<span class="wrap" bind:this={wrap}>
		<button
			class="pick"
			aria-expanded={open}
			title="Specialists and helpers the agent can hand a job to. Applies from the next message."
			onclick={() => (open = !open)}
		>
			Extras: {count} ▾
		</button>
		{#if open}
			<div class="panel" role="dialog" aria-label="Extras">
				{#if entries.length > 0}
					<div
						class="heading"
						title="Small models tuned for one job (Settings → Code → Specialists)."
					>
						Specialists
					</div>
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
								onchange={(ev) => toggleSpecialist(e.id, ev.currentTarget.checked)}
							/>
							<span>{e.name}</span>
						</label>
					{/each}
				{/if}
				{#if helperList.length > 0}
					<div class="heading" title="Tools that run without a model (Settings → Code → Helpers).">
						Helpers
					</div>
					{#each helperList as h (h.id)}
						<label
							class="item"
							title={h.writes && session.readOnly ? 'This session is read-only.' : h.tooltip}
						>
							<input
								type="checkbox"
								checked={helpersOn.has(h.id)}
								disabled={session.busy || (h.writes && session.readOnly)}
								onchange={(ev) => toggleHelper(h.id, ev.currentTarget.checked)}
							/>
							<span>{h.label}</span>
						</label>
					{/each}
				{/if}
				<button
					class="defaults"
					disabled={session.busy || !custom}
					title="The specialists marked On by default and the helpers switched on, in Settings → Code."
					onclick={() => void useDefaults()}>Use defaults</button
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
		max-height: 360px;
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

	.heading {
		padding: 4px 6px 2px;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
	}

	.heading:not(:first-child) {
		margin-top: 4px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
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
