<script lang="ts">
	/**
	 * An editor window: one project folder, a tab per file (see
	 * `#lib/editor/windows.ts`). The root layout treats it as detached, so it
	 * runs none of the app's bootstrap and shows none of its chrome.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { emit } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import CodeEditor from '#lib/components/CodeEditor.svelte';
	import { EditorWorkspace } from '#lib/editor/workspace.svelte.ts';
	import { watchedIO } from '#lib/editor/io.ts';
	import {
		OPEN_EVENT,
		READY_EVENT,
		editorTitle,
		folderLabel,
		openInEditorWindows,
		saveGeometry,
		type OpenPayload,
		type ReadyPayload
	} from '#lib/editor/windows.ts';
	import type { EditorFileChanged } from '#lib/ipc/gen/EditorFileChanged.ts';
	import {
		SETTINGS_KEY,
		applyAccent,
		applyTheme,
		type AccentColor,
		type ThemeMode
	} from '#lib/stores/settings.ts';

	const win = getCurrentWindow();
	const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

	let closing = false;
	const ws = new EditorWorkspace(page.url.searchParams.get('root') ?? '', watchedIO, {
		closeWindow: () => void closeNow()
	});
	const root = $derived(ws.root);
	const active = $derived(ws.active);

	$effect(() => {
		void win.setTitle(editorTitle(active?.relPath ?? null, root)).catch(() => {});
	});

	/** Remember where the folder's own window was, for next time. */
	async function rememberGeometry(): Promise<void> {
		if (win.label !== folderLabel(root)) return;
		try {
			const scale = await win.scaleFactor();
			const pos = (await win.outerPosition()).toLogical(scale);
			const size = (await win.innerSize()).toLogical(scale);
			saveGeometry(root, { x: pos.x, y: pos.y, width: size.width, height: size.height });
		} catch {
			// Not worth holding the close for.
		}
	}

	async function closeNow(): Promise<void> {
		if (closing) return;
		closing = true;
		ws.closeAll();
		await rememberGeometry();
		await win.destroy();
	}

	async function raise(): Promise<void> {
		await win.unminimize().catch(() => {});
		await win.setFocus().catch(() => {});
	}

	/** Move to new window: this file, in a window of its own. */
	async function split(relPath: string): Promise<void> {
		const doc = ws.tab(relPath);
		if (!doc || doc.dirty) return;
		await openInEditorWindows(root, [relPath], true);
		ws.closeTab(relPath);
	}

	function onKeydown(e: KeyboardEvent): void {
		const mod = isMac ? e.metaKey : e.ctrlKey;
		if (!mod || e.altKey || e.shiftKey || e.defaultPrevented) return;
		const key = e.key.toLowerCase();
		if (key === 's') {
			e.preventDefault();
			void ws.active?.save();
		} else if (key === 'w') {
			e.preventDefault();
			ws.requestCloseTab();
		}
	}

	/** Follow the theme when Settings changes it in the main window. */
	function onStorage(e: StorageEvent): void {
		if (e.key !== SETTINGS_KEY || !e.newValue) return;
		try {
			const s = JSON.parse(e.newValue) as { theme?: ThemeMode; accentColor?: AccentColor };
			if (s.theme) applyTheme(s.theme);
			if (s.accentColor) applyAccent(s.accentColor);
		} catch {
			// A half-written value: the next change will do.
		}
	}

	onMount(() => {
		const webview = getCurrentWebviewWindow();
		const stops: Promise<() => void>[] = [
			webview.listen<OpenPayload>(OPEN_EVENT, (e) => {
				if (!ws.root) ws.root = e.payload.root;
				void ws.open(e.payload.files);
				void raise();
			}),
			webview.listen<EditorFileChanged>('editor://file-changed', (e) =>
				ws.diskChanged(e.payload.path, e.payload.hash)
			),
			win.onCloseRequested((e) => {
				if (closing) return;
				if (!ws.requestCloseWindow()) {
					e.preventDefault();
					void raise();
					return;
				}
				e.preventDefault();
				void closeNow();
			})
		];
		// Listening now: ask for the files this window was opened for.
		void Promise.all(stops).then(() =>
			emit(READY_EVENT, { label: win.label } satisfies ReadyPayload)
		);
		return () => {
			for (const s of stops) void s.then((stop) => stop());
		};
	});
</script>

<svelte:window onkeydown={onKeydown} onstorage={onStorage} />

<div class="editor-window">
	<div class="strip" role="tablist" aria-label="Open files">
		{#each ws.tabs as doc (doc.relPath)}
			<div
				class="tab"
				class:active={doc.relPath === ws.activePath}
				role="tab"
				tabindex="0"
				aria-selected={doc.relPath === ws.activePath}
				title={doc.relPath}
				onclick={() => ws.select(doc.relPath)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						ws.select(doc.relPath);
					}
				}}
			>
				<span class="label">{doc.name}</span>
				{#if doc.dirty}<span class="dot" aria-label="unsaved">●</span>{/if}
				{#if ws.tabs.length > 1}
					<button
						class="icon"
						title={doc.dirty ? 'Save first to move it' : 'Move to new window'}
						aria-label="Move {doc.name} to a new window"
						disabled={doc.dirty}
						onclick={(e) => {
							e.stopPropagation();
							void split(doc.relPath);
						}}>⤢</button
					>
				{/if}
				<button
					class="icon"
					title="Close (Ctrl+W)"
					aria-label="Close {doc.name}"
					onclick={(e) => {
						e.stopPropagation();
						ws.requestCloseTab(doc.relPath);
					}}>×</button
				>
			</div>
		{/each}
	</div>

	{#if ws.question?.kind === 'window'}
		<div class="bar warn" role="alert">
			<span>Unsaved changes in {ws.dirtyTabs.map((d) => d.name).join(', ')}.</span>
			<button class="primary" onclick={() => void ws.saveAllAndCloseWindow()}>Save all</button>
			<button onclick={() => ws.discardAndCloseWindow()}>Discard</button>
			<button onclick={() => (ws.question = null)}>Cancel</button>
		</div>
	{:else if ws.question?.kind === 'tab'}
		{@const rel = ws.question.relPath}
		<div class="bar warn" role="alert">
			<span>Unsaved changes in {rel}.</span>
			<button class="primary" onclick={() => void ws.saveAndCloseTab(rel)}>Save</button>
			<button onclick={() => ws.closeTab(rel)}>Discard</button>
			<button onclick={() => (ws.question = null)}>Cancel</button>
		</div>
	{/if}

	{#if active}
		{#if active.conflict}
			<div class="bar warn" role="alert">
				<span>{active.name} changed on disk since you opened it.</span>
				<button class="primary" onclick={() => void active.overwrite()}>Overwrite</button>
				<button onclick={() => void active.reload()}>Reload first</button>
			</div>
		{:else if active.disk === 'changed'}
			<div class="bar" role="status">
				<span>Changed on disk</span>
				<button onclick={() => void active.reload()}>Reload</button>
				<button onclick={() => active.keepMine()}>Keep mine</button>
			</div>
		{:else if active.disk === 'deleted'}
			<div class="bar" role="status"><span>Deleted on disk — saving recreates it.</span></div>
		{:else if active.disk === 'new'}
			<div class="bar" role="status"><span>Not on disk yet — saving creates it.</span></div>
		{/if}
		{#if active.error}
			<p class="error">{active.error}</p>
		{/if}
		<div class="pane">
			{#if active.loaded && !active.failed}
				{#key active.relPath}
					<CodeEditor
						value={active.draft}
						label={active.relPath}
						onchange={(v) => active.edit(v)}
						onsave={() => void active.save()}
					/>
				{/key}
			{/if}
		</div>
		<div class="status">
			<span class="path" title={root}>{active.relPath}</span>
			{#if !active.live}
				<span
					class="unwatched"
					title="Changes made outside this window won't show until the file is reopened. Saving still checks for them."
					>Live reload unavailable</span
				>
			{/if}
			<button
				disabled={!active.canSave}
				onclick={() => void active.save()}
				title={isMac ? '⌘+S' : 'Ctrl+S'}>Save</button
			>
		</div>
	{:else}
		<p class="empty">Opening…</p>
	{/if}
</div>

<style>
	.editor-window {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: var(--bg-primary);
	}
	.strip {
		display: flex;
		gap: 2px;
		padding: 4px 6px 0;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		overflow-x: auto;
		flex: 0 0 auto;
	}
	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: 6px 6px 0 0;
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
	}
	.tab:hover {
		color: var(--text-primary);
	}
	.tab.active {
		background: var(--bg-primary);
		color: var(--text-primary);
		border-color: var(--border);
	}
	.dot {
		color: var(--accent);
		font-size: 0.6rem;
	}
	.icon {
		appearance: none;
		background: none;
		border: 0;
		color: inherit;
		opacity: 0.6;
		cursor: pointer;
		padding: 0 2px;
		border-radius: 3px;
		line-height: 1;
	}
	.icon:hover:not(:disabled) {
		opacity: 1;
		background: var(--bg-secondary);
	}
	.icon:disabled {
		opacity: 0.25;
		cursor: default;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		font-size: 0.85rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		flex: 0 0 auto;
	}
	.bar span {
		margin-right: auto;
	}
	.bar.warn {
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-secondary));
	}
	.pane {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 6px;
	}
	.pane :global(.code-editor) {
		flex: 1;
	}
	.unwatched {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px 8px;
		flex: 0 0 auto;
	}
	.path {
		margin-right: auto;
		font-size: 0.8rem;
		color: var(--text-secondary);
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.error {
		color: var(--danger, #ef4444);
		font-size: 0.85rem;
		margin: 6px 10px 0;
	}
	.empty {
		color: var(--text-secondary);
		padding: 16px;
	}
</style>
