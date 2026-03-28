<script lang="ts">
	import type { SearchStep } from '$lib/agent/loop';

	interface Props {
		steps: SearchStep[];
	}

	let { steps }: Props = $props();
	let expanded = $state(false);
</script>

{#if steps.length > 0}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="search-steps" onclick={() => (expanded = !expanded)}>
		{#each steps as step (step.id)}
			<div class="step" data-status={step.status}>
				<span class="step-icon">
					{#if step.toolName === 'web_search'}
						&#128269;
					{:else}
						&#128196;
					{/if}
				</span>
				<span class="step-label">
					{#if step.toolName === 'web_search'}
						Searching: "{step.query}"
					{:else}
						Reading: {step.query}
					{/if}
				</span>
				<span class="step-status">
					{#if step.status === 'running'}
						<span class="spinner"></span>
					{:else}
						&#10003;
					{/if}
				</span>
			</div>
		{/each}

		{#if expanded}
			<div class="step-details">
				{#each steps as step (step.id)}
					{#if step.result}
						<div class="detail-block">
							<div class="detail-label">{step.toolName}: {step.query}</div>
							<pre>{step.result}</pre>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.search-steps {
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.step {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		color: var(--text-secondary);
	}

	.step[data-status='done'] {
		color: var(--text-primary);
	}

	.step-icon {
		font-size: 0.9rem;
		flex-shrink: 0;
	}

	.step-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.step-status {
		flex-shrink: 0;
		color: #22c55e;
	}

	.spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.step-details {
		margin-top: 8px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
	}

	.detail-block {
		margin-bottom: 8px;
	}

	.detail-label {
		font-weight: 500;
		font-size: 0.75rem;
		margin-bottom: 4px;
		color: var(--text-secondary);
	}

	.detail-block pre {
		margin: 0;
		padding: 8px;
		background: var(--code-bg);
		color: #d4d4d4;
		border-radius: 4px;
		font-size: 0.75rem;
		overflow-x: auto;
		max-height: 150px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
