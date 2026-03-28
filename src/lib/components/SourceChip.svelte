<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';

	interface Props {
		urls: string[];
	}

	let { urls }: Props = $props();

	function getDomain(url: string): string {
		try {
			return new URL(url).hostname.replace('www.', '');
		} catch {
			return url;
		}
	}

	async function openUrl(url: string) {
		try {
			await invoke('plugin:shell|open', { path: url });
		} catch {
			window.open(url, '_blank');
		}
	}
</script>

{#if urls.length > 0}
	<div class="sources">
		{#each urls as url, i (url)}
			<button class="chip" onclick={() => openUrl(url)} title={url}>
				<span class="chip-number">{i + 1}</span>
				{getDomain(url)}
			</button>
		{/each}
	</div>
{/if}

<style>
	.sources {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 4px 16px 12px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 10px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: 0.75rem;
		cursor: pointer;
		transition: all 0.15s;
	}

	.chip:hover {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.chip-number {
		font-weight: 600;
		font-size: 0.7rem;
	}
</style>
