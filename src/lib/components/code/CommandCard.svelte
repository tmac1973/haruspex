<script lang="ts">
	/**
	 * A `run_command` (or `open_in_shell`) step: the command, its exit code
	 * and duration, and its output. Long output shows its last lines until
	 * expanded. With the session folder, **Open in Shell** types the command
	 * into a new Shell tab there, without running it.
	 */
	import { copyText } from '#lib/utils/copyText.ts';

	import type { SearchStep } from '#lib/agent/loop.ts';
	import { formatDuration, parseCommandResult, tailLines } from '#lib/code/commandResult.ts';
	import { hasShellCommandOpener, openShellForCommand } from '#lib/code/shellBridge.ts';

	let { step, root }: { step: SearchStep; root?: string } = $props();

	const canOpenInShell = $derived(!!root && hasShellCommandOpener());

	/** The user's own action, so nothing waits for the command. */
	function openInShell() {
		if (!root) return;
		void openShellForCommand({ command, cwd: root, wait: false });
	}

	/** Output lines shown before "Show all". */
	const PREVIEW_LINES = 20;

	const command = $derived(typeof step.args?.command === 'string' ? step.args.command : step.query);
	const view = $derived(parseCommandResult(step.result));
	const clipped = $derived(tailLines(view.output, PREVIEW_LINES));
	const failed = $derived(
		step.status === 'done' &&
			(view.error !== null || view.killed || (view.exitCode !== null && view.exitCode !== 0))
	);

	let expanded = $state(false);
	let outputOpen = $state(true);
	let copied = $state(false);

	async function copy() {
		try {
			await copyText(command);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
		}
	}

	const status = $derived.by(() => {
		if (step.status === 'running') {
			return step.toolName === 'open_in_shell' ? 'in Shell…' : 'running…';
		}
		if (view.error !== null) return 'not run';
		if (view.background) return 'in background';
		if (view.killed) return 'killed';
		if (view.exitCode !== null) return `exit ${view.exitCode}`;
		return 'done';
	});
</script>

<div class="card" class:failed data-testid="command-card">
	<div class="head">
		<span class="prompt">$</span>
		<code class="cmd" title={command}>{command}</code>
		<span class="status" class:bad={failed} class:running={step.status === 'running'}>{status}</span
		>
		{#if view.durationMs !== null}
			<span class="dur">{formatDuration(view.durationMs)}</span>
		{/if}
		{#if view.output}
			<button
				class="mini"
				onclick={() => (outputOpen = !outputOpen)}
				aria-expanded={outputOpen}
				title={outputOpen ? 'Hide output' : 'Show output'}>{outputOpen ? '▾' : '▸'}</button
			>
		{/if}
		{#if canOpenInShell}
			<button
				class="mini"
				onclick={openInShell}
				title="Type this command in a new Shell tab at the session's folder. It doesn't run until you press Enter."
				>Open in Shell</button
			>
		{/if}
		<button class="mini" onclick={copy} title="Copy the command"
			>{copied ? 'Copied' : 'Copy'}</button
		>
	</div>
	{#if view.error}
		<div class="error">{view.error}</div>
	{:else if view.output && outputOpen}
		{#if clipped.hidden > 0 && !expanded}
			<button class="more" onclick={() => (expanded = true)}
				>Show all {clipped.hidden + PREVIEW_LINES} lines</button
			>
		{/if}
		<pre class="out">{expanded ? view.output : clipped.shown}</pre>
	{/if}
</div>

<style>
	.card {
		margin: 6px 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--code-bg);
		color: #e8e3d9;
		overflow: hidden;
		font-size: 0.8rem;
	}

	.card.failed {
		border-color: color-mix(in srgb, var(--error-text) 55%, var(--border));
	}

	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
	}

	.prompt {
		color: #4fb0a5;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
	}

	.cmd {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8rem;
		background: none;
		color: inherit;
	}

	.status,
	.dur {
		flex-shrink: 0;
		font-size: 0.7rem;
		color: #a39d92;
	}

	.status.running {
		color: #4fb0a5;
	}

	.status.bad {
		color: #dd6b60;
	}

	.mini {
		appearance: none;
		flex-shrink: 0;
		background: none;
		border: 1px solid #3a352d;
		border-radius: 4px;
		color: #a39d92;
		font-size: 0.7rem;
		padding: 1px 6px;
		cursor: pointer;
	}

	.mini:hover {
		color: #ece7dd;
	}

	.more {
		display: block;
		width: 100%;
		appearance: none;
		background: #16140f;
		border: 0;
		border-top: 1px solid #2a2621;
		color: #4fb0a5;
		font-size: 0.72rem;
		padding: 3px;
		cursor: pointer;
	}

	.out {
		margin: 0;
		padding: 8px 12px 10px;
		border-top: 1px solid #2a2621;
		max-height: 480px;
		overflow: auto;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
		font-size: 0.74rem;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.error {
		padding: 6px 12px 8px;
		border-top: 1px solid #2a2621;
		color: #dd6b60;
		font-size: 0.76rem;
	}
</style>
