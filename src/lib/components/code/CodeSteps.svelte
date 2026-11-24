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
	import CommandCard from '#lib/components/code/CommandCard.svelte';
	import DiffCard from '#lib/components/code/DiffCard.svelte';
	import SubtaskCard from '#lib/components/code/SubtaskCard.svelte';
	// A subtask's card lists the child's own steps with this same component.
	import CodeSteps from '#lib/components/code/CodeSteps.svelte';
	import type { SubtaskState } from '#lib/code/subtask.ts';
	import type { SearchStep } from '#lib/agent/loop.ts';
	import { editDiffFromStep, type FileDiff } from '#lib/code/diff.ts';
	import { isPreviewable, makeCodePathLinker, relativeToRoot } from '#lib/code/paths.ts';
	import { openFileFromClick } from '#lib/code/openEditor.ts';
	import type { PathLinks } from '#lib/components/SearchStep.svelte';

	/**
	 * `root`: the session folder. Paths inside it become links that open the
	 * file: in an editor window, or with `openFile` (the web client's viewer,
	 * src/web/). `linkFiles` off: no links at all.
	 */
	let {
		steps,
		pending = [],
		root,
		linkFiles = true,
		wslDistro = null,
		openFile,
		compact = false,
		openInShell = true,
		onPreview,
		onStopSubtask
	}: {
		steps: SearchStep[];
		pending?: PendingToolCall[];
		root?: string;
		linkFiles?: boolean;
		/** The WSL distro `root` is in; editor windows open through its share. */
		wslDistro?: string | null;
		/** Open a file (relative to `root`) instead of in an editor window. */
		openFile?: (rel: string) => void;
		/** The web client: subtask cards without their steps or stop button. */
		compact?: boolean;
		/** Commands offer Open in Shell (with `root`): off for another computer's session. */
		openInShell?: boolean;
		/** Stop a running subtask, by its id; absent once the turn is over. */
		onStopSubtask?: (id: string) => void;
		/** Show a page (relative to `root`) in the preview window; absent when the session can't. */
		onPreview?: (rel: string) => void;
	} = $props();

	/** Tools that hand a command over: shown as command cards. */
	const COMMAND_TOOLS = new Set(['run_command', 'open_in_shell']);

	const pathLinks = $derived.by<PathLinks | undefined>(() => {
		const dir = root;
		if (!dir || !linkFiles) return undefined;
		return {
			link: (path) => relativeToRoot(dir, path),
			open: (rel) => (openFile ? openFile(rel) : openFileFromClick(dir, rel, wslDistro))
		};
	});
	const codePaths = $derived(
		root && linkFiles ? makeCodePathLinker(root, { preview: !!onPreview }) : undefined
	);

	/** Show a diff's file in the preview window, when it is a page inside the folder. */
	function previewer(diff: FileDiff): (() => void) | undefined {
		if (!root || !onPreview || !isPreviewable(diff.path)) return undefined;
		const rel = relativeToRoot(root, diff.path);
		return rel ? () => onPreview(rel) : undefined;
	}

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
		| { kind: 'preview'; path: string }
		| { kind: 'subtask'; subtask: SubtaskState }
		| { kind: 'steps'; steps: SearchStep[] };

	function diffOf(step: SearchStep): FileDiff | null {
		if (step.status !== 'done') return null;
		if (step.toolName === 'fs_edit_text') return editDiffFromStep(step);
		if (step.toolName === 'fs_write_text') return step.fileDiff ?? null;
		return null;
	}

	/**
	 * The page a `show_preview` step opened, so its row can open it again
	 * once the window is closed; null when it failed or the session can't.
	 */
	function previewedOf(step: SearchStep): string | null {
		if (!onPreview || step.toolName !== 'show_preview' || step.status !== 'done') return null;
		if (!step.result?.startsWith('Opened ')) return null;
		const path = step.args?.path;
		return typeof path === 'string' && path.trim() ? path.trim() : null;
	}

	const blocks = $derived.by(() => {
		const out: Block[] = [];
		for (const step of steps) {
			if (step.reasoning?.trim()) out.push({ kind: 'reasoning', text: step.reasoning.trim() });
			if (step.lead?.trim()) out.push({ kind: 'lead', text: step.lead.trim() });
			const diff = diffOf(step);
			const previewed = previewedOf(step);
			if (step.toolName === 'delegate' && step.subtask) {
				out.push({ kind: 'subtask', subtask: step.subtask });
			} else if (COMMAND_TOOLS.has(step.toolName)) out.push({ kind: 'command', step });
			else if (diff) out.push({ kind: 'diff', step, diff });
			else if (previewed) out.push({ kind: 'preview', path: previewed });
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
				<!-- Read here, not via buildFlags, so the web build drops the chunk too. -->
				{#if import.meta.env.VITE_HARUSPEX_WEB !== '1'}
					<button
						class="lead-save notebook-save"
						title="Save to a notebook"
						onclick={(e) => {
							const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
							const text = block.text;
							void import('#lib/notebooks/capture.ts').then((m) =>
								m.captureText(text, { x: r.left, y: r.bottom })
							);
						}}
					>
						📓
					</button>
				{/if}
			</div>
		{:else if block.kind === 'command'}
			<CommandCard step={block.step} root={openInShell ? root : undefined} />
		{:else if block.kind === 'diff'}
			<DiffCard diff={block.diff} onOpen={opener(block.diff)} onPreview={previewer(block.diff)} />
		{:else if block.kind === 'preview'}
			{@const rel = root ? (relativeToRoot(root, block.path) ?? block.path) : block.path}
			<div class="previewed" data-testid="previewed">
				<span class="icon">🌐</span>
				<span class="label">Previewed <code>{rel}</code></span>
				<button class="preview" title="Open in the preview window" onclick={() => onPreview?.(rel)}>
					Preview
				</button>
			</div>
		{:else if block.kind === 'subtask'}
			<SubtaskCard subtask={block.subtask} {compact} onStop={onStopSubtask}>
				{#snippet steps(s: SubtaskState)}
					<CodeSteps steps={s.steps} {root} {linkFiles} {wslDistro} {openFile} {onPreview} />
				{/snippet}
			</SubtaskCard>
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

	/* A show_preview step: the shared step row, with a button that opens
	   the page again (the window may have been closed since). */
	.previewed {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.previewed .icon {
		font-size: 0.9rem;
		flex-shrink: 0;
	}

	.previewed .label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.previewed code {
		font-size: 0.8rem;
	}

	.previewed .preview {
		appearance: none;
		background: none;
		border: 1px solid var(--accent);
		border-radius: 4px;
		padding: 0 6px;
		font: inherit;
		font-size: 0.85em;
		color: var(--accent);
		cursor: pointer;
		flex-shrink: 0;
	}

	.previewed .preview:hover {
		background: var(--bg-secondary);
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

	.lead {
		position: relative;
	}

	.lead-save {
		position: absolute;
		top: 0;
		right: 0;
		opacity: 0;
		border: none;
		background: none;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 2px 4px;
	}

	.lead:hover .lead-save,
	.lead-save:focus-visible {
		opacity: 0.7;
	}
</style>
