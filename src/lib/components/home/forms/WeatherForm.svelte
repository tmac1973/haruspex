<script lang="ts">
	/** Add card → Weather: find the place once, and pick the units. */
	import Modal from '#lib/components/Modal.svelte';
	import { geocode, type Place, type Units } from '#lib/home/weather.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { open, defaultSchedule, onadd, ondone }: CardFormProps = $props();

	let query = $state('');
	let matches = $state<Place[] | null>(null);
	let picked = $state<Place | null>(null);
	// Fahrenheit where the locale says so (the US); Celsius elsewhere.
	let units = $state<Units>(
		new Intl.Locale(navigator.language).region === 'US' ? 'imperial' : 'metric'
	);
	let searching = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function search() {
		if (!query.trim() || searching) return;
		searching = true;
		error = null;
		picked = null;
		try {
			matches = await geocode(query);
			if (matches.length === 1) picked = matches[0];
		} catch (e) {
			error = `Couldn't look that up: ${errMessage(e)}`;
		} finally {
			searching = false;
		}
	}

	async function add() {
		if (!picked || saving) return;
		saving = true;
		error = null;
		try {
			const config = { place: picked.name, lat: picked.lat, lon: picked.lon, units };
			if (await onadd(config, defaultSchedule)) ondone();
			else error = 'The card could not be added.';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} title="Weather" dismissable onclose={ondone} maxWidth={440}>
	<div class="form">
		<form
			class="search"
			onsubmit={(e) => {
				e.preventDefault();
				void search();
			}}
		>
			<input
				type="search"
				bind:value={query}
				placeholder="Town or city"
				aria-label="Town or city"
			/>
			<button type="submit" class="btn" disabled={!query.trim() || searching}>Find</button>
		</form>
		{#if matches?.length === 0}
			<p class="hint">No place by that name.</p>
		{:else if matches}
			<fieldset>
				<legend class="label">Pick one</legend>
				{#each matches as place (`${place.lat},${place.lon}`)}
					<label class="check">
						<input
							type="radio"
							name="place"
							checked={picked === place}
							onchange={() => (picked = place)}
						/>
						{place.name}
					</label>
				{/each}
			</fieldset>
		{/if}
		<label class="field">
			<span class="label">Units</span>
			<select bind:value={units}>
				<option value="metric">°C, km/h</option>
				<option value="imperial">°F, mph</option>
			</select>
		</label>
		{#if error}
			<p class="error">{error}</p>
		{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={ondone}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void add()}
				disabled={!picked || saving}
				title={picked ? undefined : 'Find and pick a place first'}>Add card</button
			>
		</div>
	</div>
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.search {
		display: flex;
		gap: 8px;
	}

	.search input {
		flex: 1;
	}

	fieldset {
		border: none;
		margin: 0;
		padding: 0;
	}

	.label,
	.hint {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.88rem;
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.error {
		margin: 0;
		color: var(--error-text);
	}
</style>
