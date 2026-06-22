<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { getSettings, updateSettings } from '$lib/stores/settings';
	import type { ShellCatalogEntry } from '$lib/ipc/gen/ShellCatalogEntry';

	// Called after the user picks an installed shell (and the selection has been
	// persisted) so the caller can restart the active session as that shell.
	let { onPick }: { onPick: () => void } = $props();

	let entries = $state<ShellCatalogEntry[]>([]);

	// The id of the entry that matches the persisted selection, falling back to
	// the catalog's default. Used to keep the <select> in sync.
	const currentId = $derived.by(() => {
		const sel = getSettings().shellSelection;
		if (sel) {
			const match = entries.find(
				(e) => e.selection && JSON.stringify(e.selection) === JSON.stringify(sel)
			);
			if (match) return match.id;
		}
		return entries.find((e) => e.is_default)?.id ?? entries[0]?.id ?? '';
	});

	onMount(async () => {
		try {
			entries = await invoke<ShellCatalogEntry[]>('shell_list_shells');
		} catch {
			entries = [];
		}
	});

	function onChange(event: Event) {
		const id = (event.currentTarget as HTMLSelectElement).value;
		const entry = entries.find((e) => e.id === id);
		// Greyed-out (uninstalled) entries are <option disabled> so they can't be
		// chosen; guard anyway.
		if (!entry || !entry.installed || !entry.selection) return;
		updateSettings({ shellSelection: entry.selection });
		onPick();
	}
</script>

<!-- Only meaningful when there's a real choice: Windows lists PowerShell
     variants + WSL distros; Linux/macOS return a single native entry, so the
     picker stays hidden there. -->
{#if entries.length > 1}
	<select
		class="shell-picker"
		value={currentId}
		onchange={onChange}
		title="Shell"
		aria-label="Select shell"
	>
		{#each entries as entry (entry.id)}
			<option value={entry.id} disabled={!entry.installed}>
				{entry.label}{entry.installed
					? ''
					: entry.install_hint
						? ` (${entry.install_hint})`
						: ' (not installed)'}
			</option>
		{/each}
	</select>
{/if}

<style>
	.shell-picker {
		margin-left: auto;
		align-self: center;
		max-width: 200px;
		padding: 2px 4px;
		font-size: 0.75rem;
		color: var(--text-secondary);
		background: var(--bg-tertiary, #222);
		border: 1px solid var(--border);
		border-radius: 4px;
	}
</style>
