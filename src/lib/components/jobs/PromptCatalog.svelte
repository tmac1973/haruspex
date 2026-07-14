<script lang="ts">
	/**
	 * Catalog picker for a prompt field: insert a built-in starter or a saved
	 * prompt, or save the current text for reuse. Scoped to the job type so only
	 * relevant prompts show.
	 */
	import { builtinsFor, promptAppliesTo } from '$lib/agent/jobs/promptCatalog';
	import {
		ensureSavedPromptsLoaded,
		getSavedPrompts,
		createSavedPrompt,
		deleteSavedPrompt
	} from '$lib/stores/promptCatalog.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	interface Props {
		jobType: 'audit' | 'research';
		/** Current field text — used for the "Save current" action. */
		current: string;
		/** Called with the chosen prompt text to drop into the field. */
		oninsert: (text: string) => void;
	}

	const { jobType, current, oninsert }: Props = $props();

	let open = $state(false);
	let saving = $state(false);
	// Prompt text waiting for "replace current?" ConfirmDialog approval.
	let pendingInsert = $state<string | null>(null);

	const builtins = $derived(builtinsFor(jobType));
	const saved = $derived(getSavedPrompts().filter((p) => promptAppliesTo(p.scope, jobType)));

	async function toggle() {
		open = !open;
		if (open) await ensureSavedPromptsLoaded();
	}

	function insert(text: string) {
		if (current.trim()) {
			pendingInsert = text;
			return;
		}
		applyInsert(text);
	}

	function applyInsert(text: string) {
		pendingInsert = null;
		oninsert(text);
		open = false;
	}

	async function saveCurrent() {
		const text = current.trim();
		if (!text) return;
		const name = window.prompt('Save this prompt to the catalog as:');
		if (!name || !name.trim()) return;
		saving = true;
		await createSavedPrompt({ name: name.trim(), scope: jobType, prompt: text });
		saving = false;
	}

	async function remove(id: number, e: MouseEvent) {
		e.stopPropagation();
		await deleteSavedPrompt(id);
	}
</script>

<div class="catalog">
	<button type="button" class="catalog-toggle" onclick={toggle}>Catalog ▾</button>
	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="catalog-backdrop" onclick={() => (open = false)}></div>
		<div class="catalog-panel">
			<div class="catalog-section">Starters</div>
			{#if builtins.length === 0}
				<div class="catalog-empty">No built-in starters for this job type.</div>
			{:else}
				{#each builtins as p (p.id)}
					<button
						type="button"
						class="catalog-item"
						title={p.prompt}
						onclick={() => insert(p.prompt)}>{p.name}</button
					>
				{/each}
			{/if}

			<div class="catalog-section with-action">
				<span>Saved</span>
				<button
					type="button"
					class="save-current"
					disabled={!current.trim() || saving}
					onclick={saveCurrent}>+ Save current</button
				>
			</div>
			{#if saved.length === 0}
				<div class="catalog-empty">Nothing saved yet.</div>
			{:else}
				{#each saved as p (p.id)}
					<div class="catalog-item saved-row">
						<button
							type="button"
							class="catalog-item-name"
							title={p.prompt}
							onclick={() => insert(p.prompt)}>{p.name}</button
						>
						<button
							type="button"
							class="catalog-del"
							title="Delete saved prompt"
							onclick={(e) => remove(p.id, e)}>×</button
						>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>

{#if pendingInsert !== null}
	{@const text = pendingInsert}
	<ConfirmDialog
		open
		title="Replace prompt?"
		message="Replace the current prompt with this one?"
		confirmLabel="Replace"
		destructive={false}
		onconfirm={() => applyInsert(text)}
		oncancel={() => (pendingInsert = null)}
	/>
{/if}

<style>
	.catalog {
		position: relative;
		display: inline-block;
	}

	.catalog-toggle {
		padding: 2px 8px;
		font-size: 0.72rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
	}

	.catalog-toggle:hover {
		border-color: var(--text-secondary);
		color: var(--text-primary);
	}

	.catalog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 10;
	}

	.catalog-panel {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 11;
		width: 240px;
		max-height: 320px;
		overflow-y: auto;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
		padding: 4px;
	}

	.catalog-section {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);
		padding: 6px 6px 2px;
	}

	.catalog-section.with-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.save-current {
		font-size: 0.68rem;
		border: none;
		background: none;
		color: var(--accent);
		cursor: pointer;
		padding: 0;
	}

	.save-current:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.catalog-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 5px 6px;
		font-size: 0.82rem;
		border: none;
		background: none;
		color: var(--text-primary);
		border-radius: 4px;
		cursor: pointer;
	}

	.catalog-item:hover,
	.catalog-item-name:hover {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.saved-row {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 0;
	}

	.catalog-item-name {
		flex: 1;
		min-width: 0;
		text-align: left;
		padding: 5px 6px;
		font-size: 0.82rem;
		border: none;
		background: none;
		color: var(--text-primary);
		border-radius: 4px;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.catalog-del {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 4px;
	}

	.catalog-del:hover {
		background: color-mix(in srgb, red 18%, transparent);
		color: var(--text-primary);
	}

	.catalog-empty {
		padding: 4px 6px 8px;
		font-size: 0.76rem;
		color: var(--text-secondary);
		font-style: italic;
	}
</style>
