<script lang="ts">
	/**
	 * Home's GitHub card: issues or pull requests that need you, read from the
	 * GitHub MCP server with no model. Each row opens on GitHub; an issue can
	 * also start work in your checkout.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import {
		GITHUB_EMPTY,
		GITHUB_PRESETS,
		githubConfigOf,
		scopeLine,
		type GitHubResult
	} from '#lib/home/github.ts';
	import { getCardError, getCardNotice } from '#lib/home/fetchedCards.svelte.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import { openInBrowser } from '#lib/utils/openInBrowser.ts';
	import { askAbout } from '#lib/home/askAbout.ts';
	import { openSessionOnIssue, planIssue } from '#lib/home/workOnIssue.ts';
	import ItemActions, { type ItemAction } from '#lib/components/home/ItemActions.svelte';
	import type { GitHubItem } from '#lib/home/github.ts';

	let { card }: { card: HomeCard } = $props();

	const config = $derived(githubConfigOf(card.config));
	const result = $derived.by((): GitHubResult | null => {
		try {
			return card.last_result ? (JSON.parse(card.last_result) as GitHubResult) : null;
		} catch {
			return null;
		}
	});
	const error = $derived(getCardError(card.id));
	const notice = $derived(getCardNotice(card.id));

	function actions(item: GitHubItem): ItemAction[] {
		const title = GITHUB_PRESETS[config.preset];
		const list: ItemAction[] = [
			{ label: 'Ask about this', run: () => askAbout(title, { kind: 'github', item }) }
		];
		if (!item.isPr) {
			list.push(
				{ label: 'Open code session', run: () => void openSessionOnIssue(item) },
				{ label: 'Plan this issue', run: () => void planIssue(item) }
			);
		}
		return list;
	}

	function age(at: string): string {
		const t = Date.parse(at);
		return Number.isNaN(t) ? '' : lastActive(t);
	}
</script>

<p class="scope">{scopeLine(config)}</p>
{#if notice}
	<p class="notice">{notice}</p>
{/if}
{#if error}
	<p class="error" title={error}>{error}</p>
{/if}
{#if result && result.items.length > 0}
	<ul>
		{#each result.items as item (item.id)}
			<li>
				<button class="title" onclick={() => void openInBrowser(item.url)} title={item.url}
					>{item.title}</button
				>
				<div class="meta">
					<span>
						{item.repo}#{item.number} · {item.author} · 💬 {item.comments} · {age(item.updatedAt)}
					</span>
					<ItemActions label={item.title} actions={actions(item)} />
				</div>
				{#if item.labels.length > 0}
					<div class="labels">
						{#each item.labels as label (label)}<span class="chip">{label}</span>{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{:else if result}
	<p class="muted">{GITHUB_EMPTY[config.preset]}</p>
{:else if !error && !notice}
	<p class="muted">Reading GitHub…</p>
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

	.title {
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

	.title:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.meta,
	.scope,
	.muted {
		color: var(--text-secondary);
	}

	.meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-size: 0.8rem;
	}

	.scope {
		margin: 0 0 6px;
		font-size: 0.78rem;
	}

	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}

	.chip {
		padding: 0 6px;
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.muted,
	.error,
	.notice {
		margin: 4px 0;
	}

	.notice {
		color: var(--accent);
		font-size: 0.85rem;
	}

	.error {
		color: var(--error-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
