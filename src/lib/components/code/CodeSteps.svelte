<script lang="ts">
	/**
	 * A turn's tool steps: commands as command cards, edits and writes as
	 * diff cards, and everything else (grep, reads, web) as the usual step
	 * list, in the order they ran.
	 */
	import SearchStepComponent from '#lib/components/SearchStep.svelte';
	import CommandCard from './CommandCard.svelte';
	import DiffCard from './DiffCard.svelte';
	import type { SearchStep } from '#lib/agent/loop.ts';
	import { editDiffFromStep, type FileDiff } from '#lib/code/diff.ts';

	let { steps }: { steps: SearchStep[] } = $props();

	type Block =
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
		{#if block.kind === 'command'}
			<CommandCard step={block.step} />
		{:else if block.kind === 'diff'}
			<DiffCard diff={block.diff} />
		{:else}
			<SearchStepComponent steps={block.steps} />
		{/if}
	{/each}
</div>

<style>
	.code-steps {
		margin: 4px 0;
	}

	/* The shared step list draws a rule under itself for Chat; here the
	   cards around it already separate the blocks. */
	.code-steps :global(.search-steps) {
		border-bottom: 0;
		padding: 4px 0;
	}
</style>
