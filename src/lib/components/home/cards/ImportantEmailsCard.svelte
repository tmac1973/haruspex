<script lang="ts">
	/**
	 * Home's Important emails card: the unread messages its email digest job
	 * picked. Subject, sender and date come from IMAP; only the reason under
	 * each is the model's.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import type { ImportantEmail } from '#lib/agent/jobs/types/email-digest/pipeline.ts';
	import { enqueue, getCurrentRun, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
	import { getLatestRun } from '#lib/home/latestRun.svelte.ts';
	import { lastActive } from '#lib/code/sessionList.ts';

	let { card }: { card: HomeCard } = $props();

	const jobId = $derived(card.job_id);
	const latestRun = $derived(jobId === null ? null : getLatestRun(jobId));
	const running = $derived.by(() => {
		const run = getCurrentRun();
		return run !== null && run.jobId === jobId && run.status === 'running';
	});
	const waiting = $derived(running ? (getCurrentRun()?.waitingForSlot ?? false) : false);
	const queued = $derived(getPendingQueue().some((q) => q.jobId === jobId));
	const failed = $derived(latestRun?.latest?.status === 'failed' ? latestRun.latest : null);
	const items = $derived.by((): ImportantEmail[] | null => {
		const json = latestRun?.latestSucceeded?.result_json;
		if (!json) return null;
		try {
			return (JSON.parse(json) as { items: ImportantEmail[] }).items;
		} catch {
			return null;
		}
	});

	function when(date: string): string {
		const at = Date.parse(date);
		return Number.isNaN(at) ? '' : lastActive(at);
	}
</script>

{#if jobId === null}
	<p class="muted">This card's job was deleted. Remove the card and add it again.</p>
{:else}
	{#if running}
		<p class="muted">{waiting ? 'Waiting for chat…' : 'Checking your mail…'}</p>
	{:else if queued}
		<p class="muted">Queued</p>
	{/if}
	{#if failed}
		<p class="error" title={failed.error ?? undefined}>
			The last check failed{failed.error ? `: ${failed.error}` : '.'}
		</p>
	{/if}
	{#if items && items.length > 0}
		<ul>
			{#each items as item (item.id)}
				<li>
					<div class="head">
						<span class="subject">{item.source.subject || '(no subject)'}</span>
						<span class="date">{when(item.source.date)}</span>
					</div>
					<div class="from">{item.source.from}</div>
					<div class="why">{item.why}</div>
				</li>
			{/each}
		</ul>
	{:else if items}
		<p class="muted">No important mail.</p>
	{:else if !running && !queued && !failed}
		<p class="muted">Not checked yet.</p>
	{/if}
	<div class="actions">
		<button
			onclick={() => void enqueue(jobId, 'manual')}
			disabled={running || queued}
			title={running || queued ? 'Already checking' : 'Check for new mail now'}>Refresh</button
		>
	</div>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li + li {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	.head {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}

	.subject {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.date,
	.from,
	.muted {
		color: var(--text-secondary);
	}

	.date {
		flex-shrink: 0;
		font-size: 0.75rem;
	}

	.from {
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.why {
		font-size: 0.8rem;
	}

	.muted,
	.error {
		margin: 4px 0;
	}

	.error {
		color: var(--error-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 8px;
	}

	.actions button {
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
