<script lang="ts">
	/**
	 * Settings → Memory → Duplicates: memories that say the same thing,
	 * grouped by the model with a merged sentence for each, which the user
	 * merges (after editing, if they like) or skips. Nothing changes without a
	 * click on Merge. See `agent/memory/dedupe.ts`.
	 */
	import {
		findDuplicateGroups,
		mergeGroup,
		type DuplicateGroup
	} from '#lib/agent/memory/dedupe.ts';
	import { refreshMemoryCount } from '#lib/stores/memory.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { onMerged }: { onMerged: () => void } = $props();

	let groups = $state<(DuplicateGroup & { draft: string; error: string })[] | null>(null);
	let searching = $state(false);
	let error = $state('');

	async function find() {
		searching = true;
		error = '';
		try {
			groups = (await findDuplicateGroups()).map((g) => ({ ...g, draft: g.content, error: '' }));
		} catch (e) {
			error = errMessage(e);
		} finally {
			searching = false;
		}
	}

	function drop(group: DuplicateGroup) {
		groups = groups?.filter((g) => g !== group) ?? null;
	}

	async function merge(group: DuplicateGroup & { draft: string; error: string }) {
		try {
			await mergeGroup(group, group.draft.trim());
			drop(group);
			void refreshMemoryCount();
			onMerged();
		} catch (e) {
			group.error = errMessage(e);
		}
	}
</script>

<section class="settings-section">
	<h2>Duplicates</h2>
	<p class="help">
		Find memories that say the same thing and merge them. Nothing changes until you press Merge.
	</p>
	<button
		type="button"
		class="btn btn-small"
		onclick={find}
		disabled={searching}
		title="The chat model reads the memories that look alike and suggests which to merge."
	>
		{searching ? 'Checking…' : 'Find duplicates'}
	</button>
	{#if error}
		<p class="help error-line">Couldn't check: {error}</p>
	{/if}
	{#if groups && groups.length === 0}
		<p class="help">No duplicates found.</p>
	{/if}
	{#each groups ?? [] as group (group.keepId)}
		<div class="group">
			<ul>
				{#each group.memories as memory (memory.id)}
					<li>
						{memory.content}
						{#if memory.origin === 'explicit'}<span class="muted"> (saved by you)</span>{/if}
					</li>
				{/each}
			</ul>
			<label>
				<span>Merge into</span>
				<textarea bind:value={group.draft} rows="2" aria-label="Merged memory"></textarea>
			</label>
			{#if group.error}
				<p class="help error-line">{group.error}</p>
			{/if}
			<div class="actions">
				<button
					type="button"
					class="btn btn-small"
					onclick={() => merge(group)}
					disabled={!group.draft.trim()}>Merge</button
				>
				<button type="button" class="btn btn-small" onclick={() => drop(group)}>Skip</button>
			</div>
		</div>
	{/each}
</section>

<style>
	.group {
		margin-top: 12px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.group ul {
		margin: 0 0 8px;
		padding-left: 18px;
		font-size: 0.9rem;
	}

	.group label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.group textarea {
		width: 100%;
		font: inherit;
		color: var(--text-primary);
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 8px;
		resize: vertical;
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}

	.muted {
		color: var(--text-secondary);
	}

	.error-line {
		color: var(--error, #d66);
	}
</style>
