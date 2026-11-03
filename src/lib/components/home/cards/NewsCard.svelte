<script lang="ts">
	/**
	 * Home's News card: the stories its news digest job picked. Headline, link
	 * and source come from the feed; only the summary under each is the model's.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import type { NewsItem } from '#lib/agent/jobs/types/news-digest/pipeline.ts';
	import { getCurrentRun, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
	import { getLatestRun } from '#lib/home/latestRun.svelte.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import { openInBrowser } from '#lib/utils/openInBrowser.ts';
	import { askAbout } from '#lib/home/askAbout.ts';
	import ItemActions from '#lib/components/home/ItemActions.svelte';

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
	const items = $derived.by((): NewsItem[] | null => {
		const json = latestRun?.latestSucceeded?.result_json;
		if (!json) return null;
		try {
			return (JSON.parse(json) as { items: NewsItem[] }).items;
		} catch {
			return null;
		}
	});
</script>

{#if jobId === null}
	<p class="muted">This card's job was deleted. Remove the card and add it again.</p>
{:else}
	{#if running}
		<p class="muted">{waiting ? 'Waiting for chat…' : 'Reading your feeds…'}</p>
	{:else if queued}
		<p class="muted">Queued</p>
	{/if}
	{#if failed}
		<p class="error" title={failed.error ?? undefined}>
			The last read failed{failed.error ? `: ${failed.error}` : '.'}
		</p>
	{/if}
	{#if items && items.length > 0}
		<ul>
			{#each items as item (item.id)}
				<li>
					{#if item.source.link}
						<button
							class="headline"
							onclick={() => void openInBrowser(item.source.link)}
							title={item.source.link}>{item.source.title}</button
						>
					{:else}
						<span class="headline">{item.source.title}</span>
					{/if}
					<div class="meta">
						<span
							>{item.source.source}{item.source.published
								? ` · ${lastActive(item.source.published)}`
								: ''}</span
						>
						<ItemActions
							label={item.source.title}
							actions={[
								{ label: 'Ask about this', run: () => askAbout('News', { kind: 'news', item }) }
							]}
						/>
					</div>
					<div class="summary">{item.summary}</div>
				</li>
			{/each}
		</ul>
	{:else if items}
		<p class="muted">No matching news.</p>
	{:else if !running && !queued && !failed}
		<p class="muted">Not read yet.</p>
	{/if}
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

	.headline {
		display: block;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-primary);
		font: inherit;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	button.headline:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.meta,
	.muted {
		color: var(--text-secondary);
	}

	.meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}

	.meta,
	.summary {
		font-size: 0.8rem;
	}

	/* The model's words, apart from the feed's. */
	.summary {
		margin-top: 2px;
		padding-left: 6px;
		border-left: 2px solid var(--accent);
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
</style>
