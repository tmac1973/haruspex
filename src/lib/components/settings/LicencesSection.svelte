<script lang="ts">
	import { onMount } from 'svelte';
	import {
		filterLicences,
		loadLicences,
		type Licences
	} from '#lib/components/settings/licences.ts';

	let licences = $state<Licences | null>(null);
	let loaded = $state(false);
	let query = $state('');

	const shown = $derived(licences ? filterLicences(licences.packages, query) : []);

	onMount(async () => {
		licences = await loadLicences();
		loaded = true;
	});
</script>

<section class="settings-section">
	<h2>Licences</h2>
	{#if !loaded}
		<p class="hint">Loading…</p>
	{:else if !licences}
		<p class="hint" title="Run npm run build:licences, then reload.">
			This build has no licence list.
		</p>
	{:else}
		<h3>Programs</h3>
		<ul class="sidecars">
			{#each licences.sidecars as s (s.name)}
				<li><span class="name">{s.name}</span> · {s.licence} · <span class="url">{s.url}</span></li>
			{/each}
		</ul>
		<h3>Packages ({licences.packages.length})</h3>
		<input
			class="filter"
			type="search"
			placeholder="Filter by name or licence"
			bind:value={query}
			aria-label="Filter packages"
		/>
		{#each shown as p (`${p.name}@${p.version}`)}
			<details>
				<summary><span class="name">{p.name}</span> {p.version} · {p.licence}</summary>
				{#if p.text}
					<pre>{p.text}</pre>
				{:else}
					<p class="hint">The package ships no licence file. {p.url}</p>
				{/if}
			</details>
		{/each}
	{/if}
</section>

<style>
	h3 {
		margin: 16px 0 8px 0;
		font-size: 0.95rem;
	}

	.sidecars {
		margin: 0;
		padding-left: 18px;
		font-size: 0.85rem;
	}

	.name {
		font-weight: 600;
	}

	.url {
		color: var(--text-secondary);
		user-select: all;
	}

	.filter {
		width: 100%;
		max-width: 320px;
		margin-bottom: 8px;
	}

	details {
		font-size: 0.85rem;
		padding: 4px 0;
		border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.2));
	}

	summary {
		cursor: pointer;
	}

	pre {
		white-space: pre-wrap;
		font-size: 0.75rem;
		max-height: 320px;
		overflow: auto;
		margin: 8px 0;
	}
</style>
