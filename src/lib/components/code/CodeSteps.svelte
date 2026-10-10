<script lang="ts">
	/**
	 * A turn's tool steps: commands as command cards, edits and writes as
	 * diff cards, and everything else (grep, reads, web) as the usual step
	 * list, in the order they ran. The reasoning behind a batch of calls sits
	 * above it, then the text the model wrote with it, and calls the model is
	 * still writing (`pending`) come last.
	 *
	 * That text is a remark on the way, not an answer: it is drawn as light
	 * inline markdown, without the answer's header or copy button.
	 */
	import SearchStepComponent from '#lib/components/SearchStep.svelte';
	import ThinkingPanel from '#lib/components/ThinkingPanel.svelte';
	import { renderMarkdown } from '#lib/markdown.ts';
	import { stepIcon } from '#lib/components/searchStepLabels.ts';
	import { describePendingCall, type PendingToolCall } from '#lib/code/pendingCall.ts';
	import CommandCard from './CommandCard.svelte';
	import DiffCard from './DiffCard.svelte';
	import type { SearchStep } from '#lib/agent/loop.ts';
	import { editDiffFromStep, type FileDiff } from '#lib/code/diff.ts';
	import { makeCodePathLinker, relativeToRoot } from '#lib/code/paths.ts';
	import { openFileFromClick } from '#lib/code/openEditor.ts';
	import type { PathLinks } from '#lib/components/SearchStep.svelte';

	/**
	 * `root`: the session folder. Paths inside it become links to the editor,
	 * unless `linkFiles` is off: the web client (src/web/) has no editor.
	 */
	let {
		steps,
		pending = [],
		root,
		linkFiles = true
	}: {
		steps: SearchStep[];
		pending?: PendingToolCall[];
		root?: string;
		linkFiles?: boolean;
	} = $props();

	/** Tools that hand a command over: shown as command cards. */
	const COMMAND_TOOLS = new Set(['run_command', 'open_in_shell']);

	const pathLinks = $derived.by<PathLinks | undefined>(() => {
		const dir = root;
		if (!dir || !linkFiles) return undefined;
		return {
			link: (path) => relativeToRoot(dir, path),
			open: (rel) => openFileFromClick(dir, rel)
		};
	});
	const codePaths = $derived(root && linkFiles ? makeCodePathLinker(root) : undefined);

	/** Open a diff's file, when it is inside the folder. */
	function opener(diff: FileDiff): (() => void) | undefined {
		const rel = pathLinks?.link(diff.path);
		return rel ? () => pathLinks?.open(rel) : undefined;
	}

	type Block =
		| { kind: 'reasoning'; text: string }
		| { kind: 'lead'; text: string }
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
			if (step.lead?.trim()) out.push({ kind: 'lead', text: step.lead.trim() });
			const diff = diffOf(step);
			if (COMMAND_TOOLS.has(step.toolName)) out.push({ kind: 'command', step });
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
		{:else if block.kind === 'lead'}
			<div class="lead" data-testid="step-lead">
				{@html renderMarkdown(block.text, undefined, codePaths)}
			</div>
		{:else if block.kind === 'command'}
			<CommandCard step={block.step} {root} />
		{:else if block.kind === 'diff'}
			<DiffCard diff={block.diff} onOpen={opener(block.diff)} />
		{:else}
			<SearchStepComponent steps={block.steps} {pathLinks} />
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

	.lead {
		margin: 6px 0 2px;
		color: var(--text-secondary);
		font-size: 0.86rem;
		line-height: 1.5;
		overflow-wrap: break-word;
	}

	.lead :global(p) {
		margin: 0 0 0.35em;
	}

	.lead :global(p:last-child) {
		margin-bottom: 0;
	}

	.lead :global(ul),
	.lead :global(ol) {
		margin: 0.3em 0;
		padding-left: 1.4em;
	}

	.lead :global(pre) {
		margin: 0.4em 0;
		overflow-x: auto;
	}

	.lead :global(a) {
		color: var(--accent);
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
