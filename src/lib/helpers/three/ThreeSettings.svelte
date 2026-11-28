<script lang="ts">
	/**
	 * The 3D helper's row in Settings → Code → Helpers: the model `delegate_3d`
	 * hands assets to (picked with the Jobs model picker, remote or
	 * OpenRouter only) and the caps on one call. Saved on every change, as
	 * plain JSON under `codeHelperConfig['3d']`.
	 */
	import type { BackendOverride } from '#lib/api.ts';
	import DelegateModelPicker from '#lib/helpers/three/DelegateModelPicker.svelte';
	import { overrideModelLabel } from '#lib/code/backends.ts';
	import {
		clampDelegateRounds,
		MAX_DELEGATE_ROUNDS,
		MIN_DELEGATE_ROUNDS,
		parseDelegate3dConfig
	} from '#lib/helpers/three/delegateConfig.ts';
	import { getSettings, setCodeHelperConfig } from '#lib/stores/settings.ts';

	let { helperId }: { helperId: string } = $props();

	const stored = parseDelegate3dConfig(getSettings().codeHelperConfig?.['3d']);
	let backend = $state<BackendOverride | null>(stored.backend);
	let rounds = $state(stored.maxRounds);
	let unlimited = $state(stored.maxCostUsd === null);
	let cost = $state<number>(stored.maxCostUsd ?? 1);

	let open = $state(false);

	const modelLabel = $derived(backend ? overrideModelLabel(backend).label : 'None');

	function save() {
		const value = {
			backend: backend ? $state.snapshot(backend) : null,
			maxRounds: rounds,
			maxCostUsd: unlimited ? null : cost > 0 ? cost : null
		};
		// The store snapshots it: no proxies and no undefined fields reach it.
		setCodeHelperConfig(helperId, value);
	}

	function choose(next: BackendOverride | null) {
		backend = next;
		open = false;
		save();
	}

	function saveRounds() {
		rounds = clampDelegateRounds(Number(rounds));
		save();
	}

	function saveCost() {
		if (!unlimited && !(cost > 0)) cost = 1;
		save();
	}
</script>

<div class="three-settings">
	<p
		class="help"
		title="delegate_3d hands one asset to this model, which builds and checks it with check_3d and reports back. With None, the session's own model does 3D work itself."
	>
		Hands 3D modelling to another model.
	</p>
	<div class="form">
		<span class="label">Delegate to</span>
		<div>
			<button
				type="button"
				class="btn btn-small"
				aria-label="Delegate to: {modelLabel}"
				onclick={() => (open = true)}
			>
				{modelLabel}
			</button>
		</div>

		<label for="three-delegate-rounds">Rounds per asset</label>
		<input
			id="three-delegate-rounds"
			type="number"
			min={MIN_DELEGATE_ROUNDS}
			max={MAX_DELEGATE_ROUNDS}
			step="1"
			bind:value={rounds}
			onchange={saveRounds}
			title="The most model calls one asset may take; at the limit it stops and reports what it has."
		/>

		<label
			for="three-delegate-cost"
			title="Counts the cost the server reports, or OpenRouter's prices for the model; a server with neither has no cost to limit."
		>
			Cost limit per asset
		</label>
		<div class="inline">
			<span class="dollar" aria-hidden="true">$</span>
			<input
				id="three-delegate-cost"
				type="number"
				min="0.01"
				step="0.01"
				bind:value={cost}
				disabled={unlimited}
				onchange={saveCost}
			/>
			<label class="check">
				<input type="checkbox" bind:checked={unlimited} onchange={saveCost} />
				Unlimited
			</label>
		</div>
	</div>
</div>

{#if open}
	<DelegateModelPicker
		title="3D delegate model"
		current={backend}
		onchoose={choose}
		onclose={() => (open = false)}
	/>
{/if}

<style>
	.three-settings {
		margin: 4px 0 10px;
	}

	.form {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 8px 12px;
		align-items: start;
		font-size: 0.85rem;
	}

	.form > label,
	.label {
		padding-top: 6px;
		color: var(--text-secondary);
	}

	input[type='number'] {
		width: 100%;
		max-width: 9rem;
		box-sizing: border-box;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.inline {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.dollar {
		color: var(--text-secondary);
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.help {
		margin: 0 0 6px;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}
</style>
