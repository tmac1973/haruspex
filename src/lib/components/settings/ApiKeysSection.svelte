<script lang="ts">
	/**
	 * Management UI for the shared API-key store. Shown inside the Inference
	 * settings section. Lets the user add, rename, update, and delete named
	 * keys that are referenced by inference backends and per-job overrides.
	 */
	import { onMount } from 'svelte';
	import { getApiKeyProblem, getApiKeys, updateApiKey } from '#lib/stores/settings.ts';
	import {
		addStoredApiKey,
		apiKeysReady,
		apiKeyValueWarning,
		deleteStoredApiKey,
		setStoredApiKeyValue
	} from '#lib/stores/apiKeySecrets.ts';
	import type { StoredApiKey } from '#lib/stores/settings.ts';
	import { secretStoreHint, secretStoreKind, type SecretStoreKind } from '#lib/stores/secrets.ts';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	let keys = $state<StoredApiKey[]>(getApiKeys());
	let newName = $state('');
	let newValue = $state('');
	/** What is being typed into an existing key's value field, per key. */
	let drafts = $state<Record<string, string>>({});
	const newValueWarning = $derived(apiKeyValueWarning(newValue));

	/** Where keys are kept here; a weaker place than the keychain is said once. */
	let storeKind = $state<SecretStoreKind>('keychain');
	void secretStoreKind().then((k) => (storeKind = k));

	// Key awaiting delete confirmation via ConfirmDialog.
	let pendingDelete = $state<StoredApiKey | null>(null);

	function refresh() {
		keys = getApiKeys();
	}

	// A key the store had no value for is only known once the stored keys are read.
	onMount(() => {
		void apiKeysReady().then(refresh);
	});

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
	{#if storeKind === 'file'}
		<p class="store-note" title={secretStoreHint(storeKind)}>
			No system keychain works here, so keys are kept in Haruspex's encrypted file.
		</p>
	{:else if storeKind === 'none'}
		<p class="store-note" title={secretStoreHint(storeKind)}>
			No secret store works here, so keys are kept only until Haruspex closes.
		</p>
	{/if}

	{#if keys.length > 0}
		<div class="key-list">
			{#each keys as k (k.id)}
				{@const problem = getApiKeyProblem(k.id)?.problem}
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
						placeholder={problem
							? 'Missing — type the key again'
							: k.stored || k.value
								? 'Saved — type to replace'
								: 'Key value'}
					/>
					<button class="btn btn-danger btn-small" onclick={() => (pendingDelete = k)}>
						Delete
					</button>
				</div>
				{@const warning = apiKeyValueWarning(drafts[k.id] ?? '')}
				{#if warning}
					<p class="key-warning" role="alert">{warning}</p>
				{:else if problem}
					<p
						class="key-warning"
						title={problem === 'missing'
							? 'The secret store has nothing saved under this key, so requests that use it are refused.'
							: 'The secret store refused to give Haruspex this key, so requests that use it are refused.'}
					>
						{problem === 'missing'
							? 'This key is missing from the secret store. Type it again.'
							: "Haruspex couldn't read this key from the secret store. Type it again."}
					</p>
				{/if}
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
	.store-note {
		margin: -6px 0 12px;
		font-size: 0.8rem;
		color: var(--text-secondary);
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
