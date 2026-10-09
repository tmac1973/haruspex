/**
 * The tabs of one editor window: which files are open, which is in front,
 * and the questions closing them asks. The window page
 * (`routes/editor/+page.svelte`) wires this to Tauri; the rules live here
 * so they can be tested without a window.
 */

import { EditorDocument, type EditorIO } from './document.svelte.ts';

export type CloseQuestion = { kind: 'tab'; relPath: string } | { kind: 'window' } | null;

export interface WorkspaceHooks {
	/** Close the window for real: nothing unsaved is left, or the user said so. */
	closeWindow(): void;
}

export class EditorWorkspace {
	/** The folder. Set once: from the URL, or from the first open. */
	root = $state('');
	private readonly io: EditorIO;
	private readonly hooks: WorkspaceHooks;

	tabs = $state<EditorDocument[]>([]);
	activePath = $state<string | null>(null);
	/** Unsaved changes stand in the way of a close: ask what to do. */
	question = $state<CloseQuestion>(null);

	constructor(root: string, io: EditorIO, hooks: WorkspaceHooks) {
		this.root = root;
		this.io = io;
		this.hooks = hooks;
	}

	get active(): EditorDocument | undefined {
		return this.tabs.find((t) => t.relPath === this.activePath);
	}

	get dirtyTabs(): EditorDocument[] {
		return this.tabs.filter((t) => t.dirty);
	}

	tab(relPath: string): EditorDocument | undefined {
		return this.tabs.find((t) => t.relPath === relPath);
	}

	/**
	 * Show `files`: a tab for each one not open yet, and the first in front.
	 * Resolves once the new tabs have loaded.
	 */
	async open(files: string[]): Promise<void> {
		const added: EditorDocument[] = [];
		for (const f of files) {
			if (this.tab(f)) continue;
			const doc = new EditorDocument(this.root, f, this.io);
			added.push(doc);
		}
		if (added.length > 0) this.tabs = [...this.tabs, ...added];
		if (files.length > 0) this.activePath = files[0];
		await Promise.all(added.map((d) => d.load()));
	}

	select(relPath: string): void {
		if (this.tab(relPath)) this.activePath = relPath;
	}

	/** A change event from the watcher, by resolved path. */
	diskChanged(path: string, hash: string | null): void {
		for (const t of this.tabs) {
			if (t.path === path) void t.diskChanged(hash);
		}
	}

	/** Ctrl/⌘+W or ×: close now, or ask first when it has unsaved changes. */
	requestCloseTab(relPath = this.activePath): void {
		const doc = relPath ? this.tab(relPath) : undefined;
		if (!doc) return;
		if (doc.dirty) {
			this.activePath = doc.relPath;
			this.question = { kind: 'tab', relPath: doc.relPath };
			return;
		}
		this.closeTab(doc.relPath);
	}

	/** Save the tab in question, then close it. Stays open if the save didn't. */
	async saveAndCloseTab(relPath: string): Promise<void> {
		const doc = this.tab(relPath);
		if (!doc) return;
		this.question = null;
		if (await doc.save()) this.closeTab(relPath);
	}

	closeTab(relPath: string): void {
		const i = this.tabs.findIndex((t) => t.relPath === relPath);
		if (i < 0) return;
		this.tabs[i].close();
		const next = this.tabs.filter((t) => t.relPath !== relPath);
		this.tabs = next;
		if (this.question?.kind === 'tab' && this.question.relPath === relPath) this.question = null;
		if (this.activePath === relPath) {
			this.activePath = next[Math.min(i, next.length - 1)]?.relPath ?? null;
		}
		if (next.length === 0) this.hooks.closeWindow();
	}

	/**
	 * The window's close button. True when it may close now; otherwise the
	 * question is up and the window stays.
	 */
	requestCloseWindow(): boolean {
		if (this.dirtyTabs.length === 0) return true;
		this.question = { kind: 'window' };
		return false;
	}

	/** Save every unsaved tab, then close. Stops at the first that won't save. */
	async saveAllAndCloseWindow(): Promise<void> {
		this.question = null;
		for (const doc of this.dirtyTabs) {
			if (!(await doc.save())) {
				this.activePath = doc.relPath;
				return;
			}
		}
		this.hooks.closeWindow();
	}

	discardAndCloseWindow(): void {
		this.question = null;
		this.hooks.closeWindow();
	}

	/** Every tab is going: stop their watches. */
	closeAll(): void {
		for (const t of this.tabs) t.close();
	}
}
