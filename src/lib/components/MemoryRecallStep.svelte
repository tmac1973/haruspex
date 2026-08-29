<script lang="ts">
	/**
	 * "Why did it say that?" — the memories this turn was given, shown inline
	 * with the answer they shaped.
	 *
	 * Collapsed by default: on a turn where recall worked well this is noise,
	 * and it only becomes interesting when an answer is surprising. Expanding
	 * it is the moment a user finds the wrong fact, so delete is right there.
	 *
	 * Deleting affects FUTURE turns only. The answer above was already
	 * generated with that memory in the prompt, and quietly rewriting history
	 * to look otherwise would be the opposite of the transparency this exists
	 * for.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import type { SearchStep } from '$lib/agent/loop';
	import type { RecalledMemory } from '$lib/agent/memory/recall';
	import { refreshMemoryCount } from '$lib/stores/memory.svelte';

	interface Props {
		step: SearchStep;
	}

	const { step }: Props = $props();

	let expanded = $state(false);
	let deleted = $state<Record<string, boolean>>({});

	const memories = $derived(
		Array.isArray(step.args?.memories) ? (step.args.memories as RecalledMemory[]) : []
	);

	async function forget(id: string) {
		try {
			await invoke('memory_delete', { id });
			deleted = { ...deleted, [id]: true };
			void refreshMemoryCount();
		} catch {
			// Nothing useful to say here: the row stays listed, and the manager
			// in Settings is the reliable route if this failed.
		}
	}
</script>

{#if memories.length > 0}
	<div class="recall">
		<button
			type="button"
			class="summary"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
		>
			<span class="icon">🧠</span>
			<span>
				Recalled {memories.length}
				{memories.length === 1 ? 'memory' : 'memories'}
			</span>
			<span class="chevron">{expanded ? '▾' : '▸'}</span>
		</button>

		{#if expanded}
			<ul class="list">
				{#each memories as memory (memory.id)}
					<li class:forgotten={deleted[memory.id]}>
						<span class="content">{memory.content}</span>
						{#if deleted[memory.id]}
							<span class="note">forgotten — future chats only</span>
						{:else}
							<button type="button" class="forget" onclick={() => forget(memory.id)}>
								Forget this
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.recall {
		margin: 4px 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.summary {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 2px 0;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.summary:hover {
		color: var(--text-primary);
	}

	.list {
		margin: 4px 0 4px 20px;
		padding: 0;
		list-style: none;
	}

	.list li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 2px 0;
	}

	.forgotten .content {
		text-decoration: line-through;
		opacity: 0.6;
	}

	.note {
		font-size: 0.72rem;
		opacity: 0.7;
	}

	.forget {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
		flex-shrink: 0;
	}
</style>
