<script lang="ts">
	/** GitHub: issues or pull requests that need you. A title opens it in this browser. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { lastActive } from '#lib/code/sessionList.ts';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'github' }> } = $props();

	function age(at: string): string {
		const t = Date.parse(at);
		return Number.isNaN(t) ? '' : lastActive(t);
	}
</script>

<p class="detail">{payload.scope}</p>
{#if payload.notice}
	<p class="muted">{payload.notice}</p>
{/if}
{#if payload.error}
	<p class="error">{payload.error}</p>
{/if}
{#if payload.items && payload.items.length > 0}
	<ul>
		{#each payload.items as item (item.url)}
			<li>
				<a class="name" href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
				<div class="detail">
					{item.repo}#{item.number} · {item.author} · 💬 {item.comments} · {age(item.updatedAt)}
				</div>
				{#if item.labels.length > 0}
					<div class="labels">
						{#each item.labels as label (label)}<span class="label">{label}</span>{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{:else if payload.items}
	<p class="muted">{payload.empty}</p>
{:else if !payload.error && !payload.notice}
	<p class="muted">Reading GitHub…</p>
{/if}
