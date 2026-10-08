<script lang="ts">
	/**
	 * A turn's tool steps: commands as command cards, edits and writes as
	 * diff cards, and everything else (grep, reads, web) as the usual step
	 * list, in the order they ran. The reasoning behind a batch of calls sits
	 * above it, and calls the model is still writing (`pending`) come last.
	 */
	import SearchStepComponent from '#lib/components/SearchStep.svelte';
	import ThinkingPanel from '#lib/components/ThinkingPanel.svelte';
	import { stepIcon } from '#lib/components/searchStepLabels.ts';
	import { describePendingCall, type PendingToolCall } from '#lib/code/pendingCall.ts';
	import CommandCard from './CommandCard.svelte';
	import DiffCard from './DiffCard.svelte';
	import type { SearchStep } from '#lib/agent/loop.ts';
	import { editDiffFromStep, type FileDiff } from '#lib/code/diff.ts';

	let { steps, pending = [] }: { steps: SearchStep[]; pending?: PendingToolCall[] } = $props();

	type Block =
		| { kind: 'reasoning'; text: string }
		| { kind: 'command'; step: SearchStep }
		| { kind: 'diff'; step: SearchStep; diff: FileDiff }
		| { kind: 'steps'; steps: SearchStep[] };

	function diffOf(step: SearchStep): FileDiff | null {
		if (step.status !== 'done') return null;
		if (step.toolName === 'fs_edit_text') return editDiffFromStep(step);
		if (step.toolName === 'fs_write_text') return step.fileDiff ?? null;
		return null;
	}

	const blocks = $derived.by(() => {
		const out: Block[] = [];
		for (const step of steps) {
			if (step.reasoning?.trim()) out.push({ kind: 'reasoning', text: step.reasoning.trim() });
			const diff = diffOf(step);
			if (step.toolName === 'run_command') out.push({ kind: 'command', step });
			else if (diff) out.push({ kind: 'diff', step, diff });
			else {
				const last = out[out.length - 1];
				if (last?.kind === 'steps') last.steps.push(step);
				else out.push({ kind: 'steps', steps: [step] });
			}
		}
		return out;
	});
</script>

<div class="code-steps">
	{#each blocks as block, i (i)}
		{#if block.kind === 'reasoning'}
			<ThinkingPanel text={block.text} />
		{:else if block.kind === 'command'}
			<CommandCard step={block.step} />
		{:else if block.kind === 'diff'}
			<DiffCard diff={block.diff} />
		{:else}
			<SearchStepComponent steps={block.steps} />
		{/if}
	{/each}
	{#each pending as call (call.index)}
		{@const label = describePendingCall(call)}
		<div class="pending-call" data-testid="pending-call" title={label.command ?? label.path ?? ''}>
			<span class="icon">{stepIcon(call.name ?? '')}</span>
			<span class="label">
				{label.verb}
				{#if label.path}<code>{label.path}</code>…{/if}
				{#if label.size}<span class="size">{label.size}</span>{/if}
			</span>
			<span class="spinner"></span>
		</div>
		{#if label.command}
			<div class="pending-command">
				<span class="prompt">$</span><code>{label.command}</code>
			</div>
		{/if}
	{/each}
</div>

<style>
	.code-steps {
		margin: 4px 0;
	}

	/* The shared step list draws a rule under itself for Chat; here the
	   cards around it already separate the blocks. */
	/* Matches the shared step row (SearchStep's .step) while it runs. */
	.pending-call {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.pending-call .icon {
		font-size: 0.9rem;
		flex-shrink: 0;
	}

	.pending-call .label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pending-call code {
		font-size: 0.8rem;
	}

	.pending-call .size {
		margin-left: 6px;
		font-variant-numeric: tabular-nums;
	}

	.pending-call .spinner {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	/* The command card's head, before the card exists. */
	.pending-command {
		display: flex;
		gap: 8px;
		margin: 2px 0 6px;
		padding: 6px 10px;
		max-height: 8em;
		overflow: auto;
		border: 1px dashed var(--border);
		border-radius: 8px;
		background: var(--code-bg);
		color: #e8e3d9;
		font-size: 0.8rem;
	}

	.pending-command .prompt {
		color: #4fb0a5;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
	}

	.pending-command code {
		background: none;
		color: inherit;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.code-steps :global(.search-steps) {
		border-bottom: 0;
		padding: 4px 0;
	}
</style>
