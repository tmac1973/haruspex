<script lang="ts">
	/**
	 * The address rows of a generation server's Connection section: a
	 * dropdown of the saved servers that run `kind`, with Remove, then the
	 * address field, with Add. Two label-and-control pairs, laid out by the
	 * section's own two-column grid. A server is also saved by the section
	 * once a probe reaches it (`rememberServer`).
	 */
	import {
		forgetServer,
		rememberServer,
		savedServers
	} from '#lib/stores/generationServers.svelte.ts';
	import {
		normalizeServerUrl,
		type GenerationServer,
		type GenerationServerKind
	} from '#lib/stores/settings.ts';

	interface Props {
		kind: GenerationServerKind;
		/** The address field's id, for its label. */
		id: string;
		value: string;
		placeholder: string;
		/** The section's chosen key, saved with the address. */
		keyId?: string | null;
		title?: string;
		/** The field lost focus: save the address as typed. */
		onCommit: () => void;
		/** A saved server was chosen, or the last one removed (null). */
		onPick: (server: GenerationServer | null) => void;
	}

	let {
		kind,
		id,
		value = $bindable(),
		placeholder,
		keyId = null,
		title,
		onCommit,
		onPick
	}: Props = $props();

	const servers = $derived(savedServers(kind));
	const current = $derived(normalizeServerUrl(value));
	const isSaved = $derived(servers.some((s) => s.url === current));

	function choose(e: Event) {
		const url = (e.currentTarget as HTMLSelectElement).value;
		const server = servers.find((s) => s.url === url);
		if (server) onPick(server);
	}

	function add() {
		rememberServer(kind, current, keyId);
	}

	function remove() {
		forgetServer(kind, current);
		onPick(savedServers(kind)[0] ?? null);
	}
</script>

{#if servers.length > 0}
	<label for="{id}-saved">Saved servers:</label>
	<div class="row">
		<select id="{id}-saved" value={isSaved ? current : ''} onchange={choose}>
			{#if !isSaved}
				<option value="" disabled>Choose a saved server</option>
			{/if}
			{#each servers as s (s.url)}
				<option value={s.url}>{s.url}</option>
			{/each}
		</select>
		<button type="button" onclick={remove} disabled={!isSaved}>Remove</button>
	</div>
{/if}

<label for={id}>Server address:</label>
<div class="row">
	<input {id} type="text" {placeholder} {title} bind:value onblur={onCommit} />
	<button type="button" onclick={add} disabled={!current || isSaved}>Add</button>
</div>

<style>
	.row {
		display: flex;
		gap: 6px;
		align-items: center;
		min-width: 0;
	}

	.row input,
	.row select {
		flex: 1;
		min-width: 0;
	}
</style>
