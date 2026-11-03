<script lang="ts">
	/**
	 * Home's Code sessions card: this window's sessions that are working or
	 * waiting on the user. A session open in a detached Code window isn't here.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import { getOpenSessions, openSession, type CodeSessionStatus } from '#lib/stores/code.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { currentPrompts } from '#lib/engine/prompts.svelte.ts';
	import { sessionsNeedingAttention } from '#lib/home/needsAttention.ts';
	import { folderName, sessionLabel } from '#lib/code/sessionList.ts';

	// Home hands every card its row; a live card keeps nothing in it.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let { card }: { card: HomeCard } = $props();

	type Chip = 'attention' | Exclude<CodeSessionStatus, 'idle'>;

	const CHIP_LABELS: Record<Chip, string> = {
		attention: 'Needs attention',
		running: 'Running',
		queued: 'Queued',
		'waiting-shell': 'Waiting on shell'
	};
	const ORDER: Chip[] = ['attention', 'running', 'waiting-shell', 'queued'];

	// Home lives in the main window only, so its prompts are the main window's.
	const waiting = $derived(sessionsNeedingAttention(currentPrompts('main')));

	const rows = $derived(
		getOpenSessions()
			.map((s) => {
				const chip: Chip | null = waiting.has(s.id)
					? 'attention'
					: s.status === 'idle'
						? null
						: s.status;
				return { id: s.id, label: sessionLabel(s), root: s.root, chip };
			})
			.filter((r): r is typeof r & { chip: Chip } => r.chip !== null)
			.sort((a, b) => ORDER.indexOf(a.chip) - ORDER.indexOf(b.chip))
	);

	async function open(id: string) {
		setActiveTab('code');
		// Null when another window has the session: it was raised instead.
		if (!(await openSession(id))) setActiveTab('home');
	}
</script>

{#if rows.length === 0}
	<p class="muted">No active sessions.</p>
{:else}
	<ul>
		{#each rows as row (row.id)}
			<li>
				<button class="row" onclick={() => void open(row.id)} title={row.root}>
					<span class="text">
						<span class="name">{row.label}</span>
						<span class="root">{folderName(row.root)}</span>
					</span>
					<span
						class="chip"
						class:attention={row.chip === 'attention'}
						class:running={row.chip === 'running'}>{CHIP_LABELS[row.chip]}</span
					>
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 6px;
		margin: 0 -6px;
		border: none;
		border-radius: 4px;
		background: none;
		color: var(--text-primary);
		text-align: left;
		cursor: pointer;
		font-size: inherit;
	}

	.row:hover {
		background: var(--bg-primary);
	}

	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.name,
	.root {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.root {
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.chip {
		flex-shrink: 0;
		padding: 1px 8px;
		border: 1px solid var(--border);
		border-radius: 10px;
		color: var(--text-secondary);
		font-size: 0.75rem;
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

	.muted {
		margin: 4px 0;
		color: var(--text-secondary);
	}
</style>
