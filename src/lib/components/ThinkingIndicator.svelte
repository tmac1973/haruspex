<script lang="ts">
	/**
	 * The "model is doing something" indicator (bouncing dots). Default form has
	 * the chat "Haruspex" label + chrome; `bare` is a compact inline form (dots +
	 * a small "Thinking…" caption) for embedding inside a job-run step card.
	 */
	interface Props {
		bare?: boolean;
	}

	const { bare = false }: Props = $props();
</script>

{#if bare}
	<div class="dots bare" role="status" aria-label="Thinking">
		<span class="dot"></span>
		<span class="dot"></span>
		<span class="dot"></span>
		<span class="caption">Thinking…</span>
	</div>
{:else}
	<div class="thinking">
		<div class="message-label">Haruspex</div>
		<div class="dots">
			<span class="dot"></span>
			<span class="dot"></span>
			<span class="dot"></span>
		</div>
	</div>
{/if}

<style>
	.thinking {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}

	.message-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 4px;
		color: var(--text-secondary);
	}

	.dots {
		display: flex;
		gap: 4px;
		padding: 4px 0;
	}

	.dots.bare {
		align-items: center;
	}

	.caption {
		margin-left: 6px;
		font-size: 0.8rem;
		font-style: italic;
		color: var(--text-secondary);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-secondary);
		animation: bounce 1.2s ease-in-out infinite;
	}

	.dot:nth-child(2) {
		animation-delay: 0.15s;
	}

	.dot:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes bounce {
		0%,
		60%,
		100% {
			transform: translateY(0);
			opacity: 0.4;
		}
		30% {
			transform: translateY(-4px);
			opacity: 1;
		}
	}
</style>
