<script lang="ts">
	/**
	 * "Running: N" for a session's background processes, opening a list of
	 * them with their output and a Stop button each.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import Modal from '#lib/components/Modal.svelte';
	import { stripAnsi } from '#lib/code/commandResult.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';
	import type { BgProcess } from '#lib/ipc/gen/BgProcess.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	/** How much of a log the Output window reads. */
	const TAIL_BYTES = 64 * 1024;

	const procs = $derived(session.background);
	const running = $derived(procs.filter((p) => p.running).length);

	let open = $state(false);
	let wrap = $state<HTMLElement>();
	let now = $state(Date.now());

	// Uptimes tick while the list is open.
	$effect(() => {
		if (!open) return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	function uptime(p: BgProcess): string {
		if (!p.running) return p.exit_code == null ? 'stopped' : `exited ${p.exit_code}`;
		const s = Math.max(0, Math.round((now - p.started_at) / 1000));
		return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
	}

	let output = $state<{ proc: BgProcess; text: string } | null>(null);

	async function showOutput(p: BgProcess) {
		try {
			const text = await invoke<string>('code_bg_tail', { id: p.id, bytes: TAIL_BYTES });
			output = { proc: p, text: stripAnsi(text) };
		} catch (e) {
			showToast(`Couldn't read the output: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	async function stop(p: BgProcess) {
		try {
			await invoke('code_bg_stop', { id: p.id });
		} catch (e) {
			showToast(`Couldn't stop it: ${errMessage(e)}`, { kind: 'error' });
		}
		await session.refreshBackground();
	}

	function closeOutside(e: MouseEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={closeOutside} />

{#if procs.length > 0}
	<span class="wrap" bind:this={wrap}>
		<button
			class="chip"
			class:live={running > 0}
			aria-expanded={open}
			title="Commands this session started in the background"
			onclick={() => (open = !open)}
		>
			{running > 0 ? `Running: ${running}` : `Finished: ${procs.length}`} ▾
		</button>
		{#if open}
			<div class="panel" role="dialog" aria-label="Background processes">
				{#each procs as p (p.id)}
					<div class="proc">
						<code class="cmd" title={`${p.command}\n${p.cwd}`}>{p.command}</code>
						<div class="row">
							<span class="meta" class:live={p.running}>{uptime(p)}</span>
							<button class="btn btn-small" onclick={() => showOutput(p)}>Output</button>
							{#if p.running}
								<button class="btn btn-small btn-danger" onclick={() => stop(p)}>Stop</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</span>
{/if}

<Modal
	open={output !== null}
	maxWidth={760}
	title={output ? `Output: ${output.proc.command}` : 'Output'}
	dismissable
	onclose={() => (output = null)}
>
	{#if output}
		<pre class="log">{output.text || '(no output yet)'}</pre>
		<div class="actions">
			<button class="btn" onclick={() => output && showOutput(output.proc)}>Refresh</button>
		</div>
	{/if}
</Modal>

<style>
	.wrap {
		position: relative;
	}

	.chip {
		appearance: none;
		font-size: 0.72rem;
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		white-space: nowrap;
	}

	.chip.live {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-soft);
	}

	.panel {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 50;
		width: 360px;
		max-height: 320px;
		overflow-y: auto;
		padding: 6px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
	}

	.proc {
		padding: 6px;
		border-radius: 6px;
	}

	.proc + .proc {
		border-top: 1px solid var(--border);
	}

	.cmd {
		display: block;
		font-size: 0.76rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
	}

	.meta {
		flex: 1;
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.meta.live {
		color: var(--accent);
	}

	.log {
		margin: 0;
		max-height: 60vh;
		overflow: auto;
		padding: 10px 12px;
		background: var(--code-bg);
		color: #e8e3d9;
		border-radius: 6px;
		font-size: 0.75rem;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 10px;
	}
</style>
