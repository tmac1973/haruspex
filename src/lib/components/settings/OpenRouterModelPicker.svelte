<script lang="ts">
	/**
	 * Searchable combobox for picking an OpenRouter model from the ~300-entry
	 * catalog. Hand-rolled (no new dependency) to keep the project dependency-
	 * free for UI widgets. Renders a text input that filters the dropdown list
	 * by name or id; selecting an entry calls back with the model id.
	 */
	import type { OpenRouterModel } from '$lib/openrouter';
	import { isOpenRouterFreeModel, isOpenRouterToolCapable } from '$lib/openrouter';

	interface Props {
		models: OpenRouterModel[];
		selectedId: string;
		onSelect: (id: string) => void;
		/** When true, only models with `tools` in supported_parameters show. */
		toolsOnly: boolean;
	}

	let { models, selectedId, onSelect, toolsOnly }: Props = $props();

	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(0);

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return models.filter((m) => {
			if (toolsOnly && !isOpenRouterToolCapable(m)) return false;
			if (!q) return true;
			return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
		});
	});

	const selectedModel = $derived(models.find((m) => m.id === selectedId) ?? null);

	function toggleOpen() {
		open = !open;
		if (open) {
			query = '';
			activeIndex = 0;
		}
	}

	function pick(m: OpenRouterModel) {
		onSelect(m.id);
		open = false;
		query = '';
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) {
			if (e.key === 'Enter' || e.key === 'ArrowDown') {
				e.preventDefault();
				open = true;
				activeIndex = 0;
			}
			return;
		}
		if (e.key === 'Escape') {
			open = false;
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const m = filtered[activeIndex];
			if (m) pick(m);
		}
	}

	function fmtContext(n: number): string {
		if (n >= 1000) return `${Math.round(n / 1000)}K`;
		return String(n);
	}
</script>

<div class="picker">
	<button
		type="button"
		class="picker-trigger"
		onclick={toggleOpen}
		onkeydown={onKeydown}
		aria-expanded={open}
	>
		{#if selectedModel}
			<span class="model-name">{selectedModel.name}</span>
			<span class="model-id">{selectedModel.id}</span>
			{#if isOpenRouterFreeModel(selectedModel.id)}
				<span class="badge free">free</span>
			{/if}
		{:else}
			<span class="placeholder">{selectedId || 'Select a model…'}</span>
		{/if}
		<span class="chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>
	{#if open}
		<div class="dropdown">
			<input
				type="text"
				class="search"
				placeholder="Search models…"
				bind:value={query}
				onkeydown={onKeydown}
			/>
			<ul class="list">
				{#each filtered as m, i (m.id)}
					<li>
						<button
							type="button"
							class="option"
							class:active={i === activeIndex}
							onclick={() => pick(m)}
							onmouseenter={() => (activeIndex = i)}
						>
							<span class="model-name">{m.name}</span>
							<span class="model-meta">
								<span class="model-id">{m.id}</span>
								<span class="ctx">{fmtContext(m.context_length)}</span>
								{#if isOpenRouterFreeModel(m.id)}
									<span class="badge free">free</span>
								{/if}
								{#if m.expiration_date}
									<span class="badge deprecated" title="Deprecated {m.expiration_date}"
										>deprecated</span
									>
								{/if}
							</span>
						</button>
					</li>
				{:else}
					<li class="empty">No models match "{query}".</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.picker {
		position: relative;
	}

	.picker-trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
	}

	.picker-trigger:hover {
		border-color: var(--text-secondary);
	}

	.model-name {
		flex: none;
		font-weight: 500;
	}

	.model-id {
		flex: 1;
		font-family: monospace;
		font-size: 0.75rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.placeholder {
		flex: 1;
		color: var(--text-secondary);
	}

	.chevron {
		flex: none;
		color: var(--text-secondary);
		font-size: 0.7rem;
	}

	.dropdown {
		position: absolute;
		z-index: 10;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		max-height: 320px;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	}

	.search {
		padding: 8px 12px;
		border: none;
		border-bottom: 1px solid var(--border);
		font-size: 0.85rem;
		background: transparent;
		color: var(--text-primary);
	}

	.search:focus {
		outline: none;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
	}

	.option {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		padding: 6px 12px;
		border: none;
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
	}

	.option.active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.model-meta {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ctx {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.badge {
		flex: none;
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.68rem;
		font-weight: 500;
	}

	.badge.free {
		background: color-mix(in srgb, var(--success) 20%, transparent);
		color: var(--success);
	}

	.badge.deprecated {
		background: color-mix(in srgb, var(--error-text) 20%, transparent);
		color: var(--error-text);
	}

	.empty {
		padding: 10px 12px;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
