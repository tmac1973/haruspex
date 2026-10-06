<script lang="ts">
	/**
	 * Management UI for the shared API-key store. Shown inside the Inference
	 * settings section. Lets the user add, rename, update, and delete named
	 * keys that are referenced by inference backends and per-job overrides.
	 */
	import { getApiKeys, updateApiKey } from '#lib/stores/settings.ts';
	import {
		addStoredApiKey,
		apiKeyValueWarning,
		deleteStoredApiKey,
		setStoredApiKeyValue
	} from '#lib/stores/apiKeySecrets.ts';
	import type { StoredApiKey } from '#lib/stores/settings.ts';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	let keys = $state<StoredApiKey[]>(getApiKeys());
	let newName = $state('');
	let newValue = $state('');
	/** What is being typed into an existing key's value field, per key. */
	let drafts = $state<Record<string, string>>({});
	const newValueWarning = $derived(apiKeyValueWarning(newValue));

	// Key awaiting delete confirmation via ConfirmDialog.
	let pendingDelete = $state<StoredApiKey | null>(null);

	function refresh() {
		keys = getApiKeys();
	}

	async function add() {
		if (!newValue.trim()) return;
		await addStoredApiKey(newName.trim() || 'Untitled', newValue.trim());
		refresh();
		newName = '';
		newValue = '';
	}

	async function confirmRemove() {
		if (!pendingDelete) return;
		await deleteStoredApiKey(pendingDelete.id);
		pendingDelete = null;
		refresh();
	}

	function onNameBlur(k: StoredApiKey, name: string) {
		if (name !== k.name) {
			updateApiKey(k.id, { name });
			refresh();
		}
	}

	/** A typed value replaces the key; an untouched (empty) field keeps it. */
	async function onValueBlur(k: StoredApiKey, input: HTMLInputElement) {
		const value = input.value.trim();
		if (!value || value === k.value) return;
		await setStoredApiKeyValue(k.id, value);
		input.value = '';
		drafts = { ...drafts, [k.id]: '' };
		refresh();
	}
</script>

<section class="settings-section">
	<h2>API Keys</h2>
	<p class="hint">
		Named keys shared across inference backends and per-job model overrides. Selecting a key in the
		OpenRouter or remote server form references it by name — updating a key here updates it
		everywhere it's used.
	</p>

	{#if keys.length > 0}
		<div class="key-list">
			{#each keys as k (k.id)}
				<div class="key-row">
					<input
						type="text"
						value={k.name}
						onblur={(e) => onNameBlur(k, (e.currentTarget as HTMLInputElement).value)}
						placeholder="Key name"
					/>
					<input
						type="password"
						value=""
						oninput={(e) => (drafts = { ...drafts, [k.id]: e.currentTarget.value })}
						onblur={(e) => onValueBlur(k, e.currentTarget as HTMLInputElement)}
						placeholder={k.stored || k.value ? 'Saved — type to replace' : 'Key value'}
					/>
					<button class="btn btn-danger btn-small" onclick={() => (pendingDelete = k)}>
						Delete
					</button>
				</div>
				{@const warning = apiKeyValueWarning(drafts[k.id] ?? '')}
				{#if warning}<p class="key-warning" role="alert">{warning}</p>{/if}
			{/each}
		</div>
	{:else}
		<p class="empty">
			No API keys saved yet. Add one below or use the "+ Add key" button in any inference form.
		</p>
	{/if}

	<div class="add-row">
		<input type="text" bind:value={newName} placeholder="Name (e.g. OpenRouter)" />
		<input type="password" bind:value={newValue} placeholder="Key value" />
		<button class="btn btn-primary btn-small" onclick={add} disabled={!newValue.trim()}>
			Add key
		</button>
	</div>
	{#if newValueWarning}<p class="key-warning" role="alert">{newValueWarning}</p>{/if}
</section>

<ConfirmDialog
	open={pendingDelete !== null}
	title="Remove API key?"
	message={pendingDelete
		? `The ${pendingDelete.name} key will be removed. You can add it again later.`
		: ''}
	confirmLabel="Remove"
	onconfirm={confirmRemove}
	oncancel={() => (pendingDelete = null)}
/>

<style>
	.hint {
		margin: 0 0 12px 0;
	}
	.key-warning {
		margin: 2px 0 6px;
		font-size: 0.8rem;
		color: var(--error-text, #c97);
	}

	.key-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}

	.key-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.key-row input {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.82rem;
	}

	.empty {
		font-size: 0.82rem;
		color: var(--text-secondary);
		margin: 0 0 12px 0;
		font-style: italic;
	}

	.add-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.add-row input {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.82rem;
	}
</style>
