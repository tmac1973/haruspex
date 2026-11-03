<script lang="ts">
	/**
	 * The Code sessions card, from this page's own session list and prompts:
	 * sessions working or waiting on you, in every window. A row opens it.
	 */
	import type { WebStore } from '../../store.svelte.ts';
	import { sessionsNeedingAttention } from '#lib/home/needsAttention.ts';

	let { store }: { store: WebStore } = $props();

	const CHIPS: Record<string, string> = {
		attention: 'Needs attention',
		running: 'Running',
		'waiting-shell': 'Waiting on shell',
		queued: 'Queued'
	};
	const ORDER = Object.keys(CHIPS);

	const rows = $derived.by(() => {
		const waiting = sessionsNeedingAttention(Object.values(store.prompts));
		return store.sessions
			.map((s) => ({
				s,
				chip: waiting.has(s.id) ? 'attention' : s.status && s.status !== 'idle' ? s.status : null
			}))
			.filter((r): r is typeof r & { chip: string } => r.chip !== null)
			.sort((a, b) => ORDER.indexOf(a.chip) - ORDER.indexOf(b.chip));
	});

	function name(path: string): string {
		return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
	}

	function open(id: string) {
		store.tab = 'code';
		void store.select(id);
	}
</script>

{#if rows.length === 0}
	<p class="muted">No session is working or waiting on you.</p>
{:else}
	<ul>
		{#each rows as { s, chip } (s.id)}
			<li>
				<button class="row" onclick={() => open(s.id)} title={s.root}>
					<span class="name">{s.title || name(s.root)}</span>
					<span
						class="chip"
						class:attention={chip === 'attention'}
						class:running={chip === 'running'}>{CHIPS[chip] ?? chip}</span
					>
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 6px 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.chip {
		flex-shrink: 0;
		padding: 1px 8px;
		border: 1px solid var(--border);
		border-radius: 10px;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.chip.attention {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.chip.running {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
</style>
