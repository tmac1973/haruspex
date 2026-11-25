<script lang="ts">
	/**
	 * "Rewind to here": cut the session back to a message, in place, and put
	 * back the files its write and edit tools changed since. A file changed
	 * after the agent wrote it is listed apart and only overwritten when
	 * ticked. Commands' changes are not tracked, and the dialog says so.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import {
		changedFiles,
		describeRewindReport,
		readyFiles,
		skipReason,
		type RewindFile
	} from '#lib/code/checkpoints.ts';
	import type { CodeSessionView } from '#lib/code/sessionView.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let {
		session,
		index,
		onclose
	}: {
		session: Pick<CodeSessionView, 'planRewind' | 'rewind'>;
		/** The message rewound to; null: closed. */
		index: number | null;
		onclose: () => void;
	} = $props();

	let files = $state<RewindFile[] | null>(null);
	let loadError = $state<string | null>(null);
	let restore = $state(true);
	/** Changed files ticked to be overwritten anyway, by path. */
	let overwrite = $state<string[]>([]);
	let working = $state(false);

	$effect(() => {
		const at = index;
		files = null;
		loadError = null;
		restore = true;
		overwrite = [];
		if (at === null || !session.planRewind) return;
		void session
			.planRewind(at)
			.then((plan) => {
				if (index === at) files = plan.files;
			})
			.catch((e: unknown) => {
				if (index === at) loadError = errMessage(e);
			});
	});

	const ready = $derived(files ? readyFiles(files) : []);
	const changed = $derived(files ? changedFiles(files) : []);
	const cannot = $derived(files ? files.filter((f) => f.status === 'cannot') : []);
	const anyFiles = $derived(ready.length + changed.length + cannot.length > 0);

	function toggle(path: string, on: boolean) {
		overwrite = on ? [...overwrite, path] : overwrite.filter((p) => p !== path);
	}

	async function go() {
		if (working || index === null || !session.rewind) return;
		working = true;
		try {
			const report = await session.rewind(index, {
				restoreFiles: restore,
				overwrite: restore ? overwrite : []
			});
			const said = describeRewindReport(report);
			showToast(said ? `Rewound. ${said}` : 'Rewound.', {
				kind: report.skipped.length ? 'info' : 'success'
			});
			onclose();
		} catch (e) {
			showToast(`Couldn't rewind: ${errMessage(e)}`, { kind: 'error' });
		} finally {
			working = false;
		}
	}

	function cancel() {
		if (!working) onclose();
	}
</script>

<Modal
	open={index !== null}
	maxWidth={480}
	labelledBy="rewind-dialog-title"
	dismissable
	onclose={cancel}
>
	<h2 id="rewind-dialog-title">Rewind to here</h2>
	<p>Later messages leave this session.</p>
	{#if loadError}
		<p class="notice" role="alert">Couldn't check the files: {loadError}</p>
	{:else if files === null}
		<p class="notice" role="status">Checking the files…</p>
	{:else if anyFiles}
		<label class="check">
			<input type="checkbox" bind:checked={restore} data-testid="rewind-restore" />
			Put back files the agent changed
		</label>
		{#if restore}
			<ul class="files" data-testid="rewind-files">
				{#each ready as f (f.path)}
					<li title={f.created ? 'The agent made it: it will be deleted.' : undefined}>
						<code>{f.shown}</code>{f.created ? ' (new)' : ''}
					</li>
				{/each}
				{#each changed as f (f.path)}
					<li class="changed">
						<label
							title="Someone changed it after the agent wrote it: you, another session or a command."
						>
							<input
								type="checkbox"
								checked={overwrite.includes(f.path)}
								onchange={(e) => toggle(f.path, e.currentTarget.checked)}
							/>
							<code>{f.shown}</code> changed since; overwrite
						</label>
					</li>
				{/each}
				{#each cannot as f (f.path)}
					<li class="cannot">
						<code>{f.shown}</code> can't be put back: {skipReason(f.reason ?? '')}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
	<p
		class="notice"
		title="Only the agent's write and edit tools are tracked. Files a command changed (a build, git, a formatter, an install) stay as they are."
	>
		Changes made by commands are not undone.
	</p>
	<div class="button-row">
		<ModalButton variant="subtle" onclick={cancel}>
			{#snippet title()}Cancel{/snippet}
		</ModalButton>
		<ModalButton autofocus onclick={go} disabled={working || (files === null && !loadError)}>
			{#snippet title()}{working ? 'Rewinding…' : 'Rewind'}{/snippet}
		</ModalButton>
	</div>
</Modal>

<style>
	.notice {
		color: var(--text-secondary);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.files {
		margin: 8px 0;
		padding-left: 20px;
		max-height: 200px;
		overflow-y: auto;
		overflow-wrap: anywhere;
	}

	.files .changed,
	.files .cannot {
		color: var(--text-secondary);
	}

	.button-row {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
