<script lang="ts">
	// Per-chat console pane. For now this is a placeholder; step 6 (tool
	// swap) wires stdout/stderr from run_python invocations into a
	// reactive per-chat buffer in workspace.svelte.ts, which this
	// component will read.

	interface Props {
		chatId: string;
	}

	let { chatId }: Props = $props();
</script>

<div class="console" data-chat={chatId}>
	<div class="placeholder">
		Console output from <code>run_python</code> appears here once tools are wired in step 6. Run
		code via the model — or via the spike route at
		<code>/workspace-spike</code> for direct testing.
	</div>
</div>

<style>
	.console {
		flex-shrink: 0;
		max-height: 30%;
		min-height: 80px;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
		overflow-y: auto;
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		padding: 0.5rem 0.75rem;
	}
	.placeholder {
		color: var(--text-secondary);
	}
	.placeholder code {
		background: var(--bg-tertiary);
		padding: 0 0.25rem;
		border-radius: 2px;
	}
</style>
