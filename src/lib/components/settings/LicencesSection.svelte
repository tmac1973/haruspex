<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		filterLicences,
		loadLicences,
		SOURCE_LABELS,
		textOf,
		type Licences
	} from '#lib/components/settings/licences.ts';

	let licences = $state<Licences | null>(null);
	let loaded = $state(false);
	let query = $state('');
	// Texts are rendered only while their entry is open: there are hundreds.
	const open = new SvelteSet<string>();

	const shown = $derived(licences ? filterLicences(licences.packages, query) : []);

	function toggle(key: string, e: Event) {
		if ((e.currentTarget as HTMLDetailsElement).open) open.add(key);
		else open.delete(key);
	}

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
		{@const list = licences}
		<h3>Programs</h3>
		{#each list.sidecars as s (s.name)}
			{@const key = `program:${s.name}`}
			<details ontoggle={(e) => toggle(key, e)}>
				<summary><span class="name">{s.name}</span> · {s.licence}</summary>
				{#if open.has(key)}
					{@const text = textOf(list, s)}
					{#if text}
						<pre>{text}</pre>
					{:else}
						<p class="hint">This build carries no licence text for it. {s.url}</p>
					{/if}
				{/if}
			</details>
		{/each}
		<h3>Packages ({list.packages.length})</h3>
		<input
			class="filter"
			type="search"
			placeholder="Filter by name, licence, npm, Rust or Python"
			bind:value={query}
			aria-label="Filter packages"
		/>
		{#each shown as p (`${p.source}:${p.name}@${p.version}`)}
			{@const key = `${p.source}:${p.name}@${p.version}`}
			<details ontoggle={(e) => toggle(key, e)}>
				<summary>
					<span class="name">{p.name}</span>
					{p.version} · {p.licence} · <span class="source">{SOURCE_LABELS[p.source]}</span>
				</summary>
				{#if open.has(key)}
					{@const text = textOf(list, p)}
					{#if text}
						<pre>{text}</pre>
					{:else}
						<p class="hint">The package ships no licence file. {p.url}</p>
					{/if}
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

	.name {
		font-weight: 600;
	}

	.source {
		color: var(--text-secondary);
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
