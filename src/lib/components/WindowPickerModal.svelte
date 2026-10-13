<script lang="ts">
	/**
	 * The list of open windows to capture, on platforms without a picker of
	 * their own (macOS, Windows). Typing filters by title or app; the arrows
	 * move the highlight, Enter picks it, Escape cancels.
	 */
	import { tick } from 'svelte';
	import Modal from '#lib/components/Modal.svelte';
	import type { CaptureWindow } from '#lib/ipc/gen/CaptureWindow.ts';
	import { windowLabel } from '#lib/shell/captureWindow.ts';

	let {
		windows,
		onPick,
		onCancel
	}: {
		/** Null while closed. */
		windows: CaptureWindow[] | null;
		onPick: (id: number) => void;
		onCancel: () => void;
	} = $props();

	let query = $state('');
	let highlight = $state(0);
	let listEl = $state<HTMLDivElement | undefined>();

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const all = windows ?? [];
		if (!q) return all;
		return all.filter((w) => w.title.toLowerCase().includes(q) || w.app.toLowerCase().includes(q));
	});

	// A new list or a new filter starts again at the top.
	$effect(() => {
		void shown;
		highlight = 0;
	});

	// Each opening starts with an empty filter.
	$effect(() => {
		if (!windows) query = '';
	});

	const optionId = (id: number) => `window-option-${id}`;

	async function move(to: number) {
		if (shown.length === 0) return;
		highlight = Math.max(0, Math.min(shown.length - 1, to));
		await tick();
		listEl
			?.querySelector(`#${optionId(shown[highlight].id)}`)
			?.scrollIntoView({ block: 'nearest' });
	}

	function onkeydown(e: KeyboardEvent) {
		const step: Record<string, number> = {
			ArrowDown: highlight + 1,
			ArrowUp: highlight - 1,
			Home: 0,
			End: shown.length - 1
		};
		if (e.key in step) {
			e.preventDefault();
			void move(step[e.key]);
		} else if (e.key === 'Enter' && shown[highlight]) {
			e.preventDefault();
			onPick(shown[highlight].id);
		}
	}
</script>

<Modal
	open={windows !== null}
	title="Capture which window?"
	labelledBy="window-picker-title"
	dismissable
	onclose={onCancel}
	maxWidth={480}
>
	<!-- svelte-ignore a11y_autofocus -->
	<input
		class="filter"
		type="text"
		placeholder="Filter windows…"
		autofocus
		bind:value={query}
		{onkeydown}
		role="combobox"
		aria-label="Filter windows"
		aria-expanded="true"
		aria-controls="window-picker-list"
		aria-activedescendant={shown[highlight] ? optionId(shown[highlight].id) : undefined}
	/>
	<div bind:this={listEl} id="window-picker-list" class="list" role="listbox" aria-label="Windows">
		{#each shown as w, i (w.id)}
			<!-- The keyboard goes through the filter box (aria-activedescendant). -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				id={optionId(w.id)}
				class="option"
				class:active={i === highlight}
				role="option"
				tabindex="-1"
				aria-selected={i === highlight}
				aria-label={windowLabel(w)}
				title={windowLabel(w)}
				onclick={() => onPick(w.id)}
				onmousemove={() => (highlight = i)}
			>
				<span class="name">{w.title.trim() || w.app}</span>
				{#if w.title.trim() && w.app.trim()}
					<span class="app">{w.app}</span>
				{/if}
			</div>
		{:else}
			<p class="empty">No window matches.</p>
		{/each}
	</div>
</Modal>

<style>
	.filter {
		width: 100%;
		box-sizing: border-box;
		margin: 8px 0;
		padding: 6px 10px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.85rem;
		font-family: inherit;
	}

	.filter:focus {
		outline: none;
		border-color: var(--accent);
	}

	.list {
		display: flex;
		flex-direction: column;
		max-height: min(360px, calc(100vh - 220px));
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.option {
		/* A column that is too short scrolls; the rows never squash to fit. */
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 6px 10px;
		cursor: pointer;
		min-width: 0;
	}

	.option + .option {
		border-top: 1px solid var(--border);
	}

	.option.active {
		background: var(--bg-secondary);
	}

	.name,
	.app {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.name {
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.app {
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.list .empty {
		margin: 0;
		padding: 10px;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}
</style>
