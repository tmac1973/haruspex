<script lang="ts">
	/**
	 * The in-app editor for working-directory files, opened through
	 * `editWorkdirFiles`. Mounted once in the root layout.
	 *
	 * Saving writes the file at once (Ctrl/Cmd-S or Save); closing with
	 * unsaved changes asks first rather than dropping them.
	 */
	import Modal from './Modal.svelte';
	import CodeEditor from './CodeEditor.svelte';
	import { getPendingEdit } from '#lib/stores/fileEditor.svelte.ts';
	import { EditorDocument } from '#lib/editor/document.svelte.ts';
	import { plainIO } from '#lib/editor/io.ts';

	const pending = $derived(getPendingEdit());

	/** One document per file, in the order the list shows them. */
	let docs = $state<EditorDocument[]>([]);
	let current = $state('');
	let saved = $state<string[]>([]);
	let confirmingClose = $state(false);
	let loadedFor = $state<unknown>(null);

	const doc = (file: string) => docs.find((d) => d.relPath === file);
	const dirty = (file: string) => doc(file)?.dirty ?? false;
	const anyDirty = $derived(docs.some((d) => d.dirty));
	const currentDoc = $derived(doc(current));
	/** The newest problem: the current file's first, then any other's. */
	const error = $derived(currentDoc?.error || docs.find((d) => d.error)?.error || '');

	$effect(() => {
		if (pending && loadedFor !== pending) {
			loadedFor = pending;
			void load(pending.workdir, pending.files);
		}
	});

	async function load(workdir: string, files: string[]): Promise<void> {
		saved = [];
		confirmingClose = false;
		current = files[0] ?? '';
		const next = files.map((f) => new EditorDocument(workdir, f, plainIO));
		docs = next;
		await Promise.all(next.map((d) => d.load()));
	}

	async function save(file = current): Promise<boolean> {
		const d = doc(file);
		if (!pending || !d || !d.dirty) return true;
		if (!(await d.save())) return false;
		if (!saved.includes(file)) saved = [...saved, file];
		return true;
	}

	async function saveAllAndClose(): Promise<void> {
		if (!pending) return;
		for (const file of pending.files) {
			if (!(await save(file))) return;
		}
		pending.finish({ saved });
	}

	function close(): void {
		if (!pending) return;
		if (anyDirty) {
			confirmingClose = true;
			return;
		}
		pending.finish({ saved });
	}

	function discardAndClose(): void {
		pending?.finish({ saved });
	}

	function fileName(path: string): string {
		return path.split('/').pop() || path;
	}
</script>

<Modal
	open={pending != null}
	maxWidth={1100}
	title={pending?.title ?? ''}
	dismissable
	onclose={close}
>
	{#if pending}
		<div class="editor-layout" class:single={pending.files.length === 1}>
			{#if pending.files.length > 1}
				<nav class="files" aria-label="Files">
					{#each pending.files as file (file)}
						<button
							type="button"
							class:active={file === current}
							onclick={() => (current = file)}
							title={file}
						>
							{fileName(file)}{#if dirty(file)}<span class="dot" aria-label="unsaved">●</span>{/if}
						</button>
					{/each}
				</nav>
			{/if}
			<div class="pane">
				<p class="path" title={pending.workdir}>{current}</p>
				{#if currentDoc?.loaded}
					{#key current}
						<CodeEditor
							value={currentDoc.draft}
							label={current}
							onchange={(v) => currentDoc.edit(v)}
							onsave={() => save()}
						/>
					{/key}
				{/if}
			</div>
		</div>

		{#if error}
			<p class="error">{error}</p>
		{/if}

		<div class="actions">
			{#if confirmingClose}
				<span class="warn">Unsaved changes.</span>
				<button type="button" class="primary" onclick={saveAllAndClose}>Save and close</button>
				<button type="button" onclick={discardAndClose}>Discard</button>
				<button type="button" onclick={() => (confirmingClose = false)}>Keep editing</button>
			{:else}
				<button type="button" disabled={!dirty(current)} onclick={() => save()} title="Ctrl+S"
					>Save</button
				>
				<button type="button" class="primary" onclick={close}>Done</button>
			{/if}
		</div>
	{/if}
</Modal>

<style>
	.editor-layout {
		display: grid;
		grid-template-columns: 200px 1fr;
		gap: 12px;
		height: min(70vh, 720px);
	}
	.editor-layout.single {
		grid-template-columns: 1fr;
	}
	.files {
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
	}
	.files button {
		appearance: none;
		background: none;
		border: 0;
		border-radius: 4px;
		padding: 6px 8px;
		text-align: left;
		color: var(--text-secondary);
		font-size: 0.85rem;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.files button:hover,
	.files button.active {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}
	.dot {
		color: var(--accent);
		margin-left: 4px;
		font-size: 0.7rem;
	}
	.pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.pane :global(.code-editor) {
		flex: 1;
	}
	.path {
		margin: 0 0 6px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
	}
	.warn {
		margin-right: auto;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}
	.error {
		color: var(--danger, #ef4444);
		font-size: 0.85rem;
		margin: 8px 0 0;
	}
</style>
