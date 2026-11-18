<script lang="ts">
	/**
	 * Which computer a prompt came from, at the top of its modal, when it
	 * isn't this one (plan/instance-sync/). Answering it decides there.
	 */
	import type { PromptOrigin } from '#lib/stores/approvalQueue.svelte.ts';

	let { origin }: { origin?: PromptOrigin } = $props();
</script>

{#if origin}
	<p
		class="origin"
		data-testid="prompt-origin"
		title="Asked by {origin.name}. Your answer, and anything it allows, applies there."
	>
		On {origin.name}
	</p>
{/if}

<style>
	.origin {
		display: inline-block;
		margin: 0 0 8px;
		padding: 2px 8px;
		font-size: 0.72rem;
		font-weight: 600;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		color: var(--text-secondary);
	}
</style>
