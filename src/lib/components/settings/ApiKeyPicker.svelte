<script lang="ts">
	/**
	 * Reusable dropdown for selecting a named API key from the Settings key
	 * store. Used by the generic remote form, the OpenRouter form, and the
	 * per-job model override. Keys are managed in Settings → Inference →
	 * API Keys; this component is selection-only.
	 */
	import { getApiKeys, type StoredApiKey } from '$lib/stores/settings';

	interface Props {
		/** Currently selected key id, or null for "no key". */
		selectedId: string | null;
		/** Callback when the user picks a key (or null for "None"). */
		onSelect: (id: string | null) => void;
	}

	let { selectedId, onSelect }: Props = $props();

	let keys = $state<StoredApiKey[]>(getApiKeys());

	function onChange(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		onSelect(v || null);
	}
</script>

<div class="picker-row">
	<select value={selectedId ?? ''} onchange={onChange}>
		<option value="">No API key</option>
		{#each keys as k (k.id)}
			<option value={k.id}>{k.name}</option>
		{/each}
	</select>
</div>

<style>
	.picker-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.picker-row select {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.82rem;
	}
</style>
