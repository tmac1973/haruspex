/**
 * Editor windows: where a file opened from the Code tab goes.
 *
 * One window per project folder, holding a tab per file. Opening a file
 * focuses its tab when some editor window already has it, adds a tab to the
 * folder's window otherwise, and opens that window when there isn't one yet.
 * "Move to new window" splits a tab off into a window of its own.
 *
 * A window that is still loading can't hear events, so files for it wait
 * here until it says `editor://ready`.
 *
 * The Jobs review checkpoint keeps its modal (`editWorkdirFiles`): it waits
 * for the user to finish, which a window can't.
 */

import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** Main → editor window: show these files. */
export const OPEN_EVENT = 'editor://open';
/** Editor window → anyone: loaded and listening. */
export const READY_EVENT = 'editor://ready';

export interface OpenPayload {
	/** The folder, for a window whose URL lost it. */
	root: string;
	files: string[];
}
export interface ReadyPayload {
	label: string;
}

/** A short, stable key for a folder: FNV-1a of its path. */
export function folderKey(root: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < root.length; i++) {
		h ^= root.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** The folder's own window. */
export function folderLabel(root: string): string {
	return `editor-${folderKey(root)}`;
}

export function isEditorLabel(label: string): boolean {
	return label.startsWith('editor-');
}

export function folderName(root: string): string {
	return (
		root
			.replace(/[\\/]+$/, '')
			.split(/[\\/]/)
			.pop() || root
	);
}

/** `<file> — <folder> — Haruspex Editor`. */
export function editorTitle(file: string | null, root: string): string {
	const name = file ? file.split('/').pop() || file : null;
	return [name, folderName(root), 'Haruspex Editor'].filter(Boolean).join(' — ');
}

export function editorUrl(root: string): string {
	return `/editor?root=${encodeURIComponent(root)}`;
}

/** Where one window's worth of files went. */
export interface WindowOpen {
	label: string;
	/** A new window, rather than one already open. */
	created: boolean;
	/** Files that were already open there: their tabs were focused. */
	focused: string[];
	/** Files given a new tab. */
	added: string[];
}

export interface WindowApi {
	/** For each file, a window that has it open. */
	findOpen(root: string, files: string[]): Promise<(string | null)[]>;
	exists(label: string): Promise<boolean>;
	create(label: string, root: string): Promise<void>;
	send(label: string, root: string, files: string[]): Promise<void>;
	raise(label: string): Promise<void>;
	/** Call `cb(label)` whenever an editor window reports ready. */
	onReady(cb: (label: string) => void): void;
}

/**
 * Routes opens to windows. One per JS context; the window API is injected
 * so the rules can be tested without Tauri.
 */
export class EditorRouter {
	/** Created windows that haven't said ready, and the files they're owed. */
	private waiting = new Map<string, { root: string; files: string[] }>();
	private listening = false;

	constructor(private api: WindowApi) {}

	/**
	 * Open `files` (relative to `root`, already checked to be inside it).
	 * `newWindow` opens them in a window of their own.
	 */
	async open(root: string, files: string[], newWindow = false): Promise<WindowOpen[]> {
		if (newWindow) {
			const label = `${folderLabel(root)}-${Date.now().toString(36)}`;
			await this.start(label, root, files);
			return [{ label, created: true, focused: [], added: files }];
		}
		const found = await this.api.findOpen(root, files).catch(() => files.map(() => null));
		const byWindow = new Map<string, WindowOpen>();
		const home = folderLabel(root);
		for (const [i, file] of files.entries()) {
			const label = found[i] ?? home;
			let entry = byWindow.get(label);
			if (!entry) {
				entry = { label, created: false, focused: [], added: [] };
				byWindow.set(label, entry);
			}
			(found[i] ? entry.focused : entry.added).push(file);
		}
		const results = [...byWindow.values()];
		for (const r of results) {
			const all = [...r.focused, ...r.added];
			const owed = this.waiting.get(r.label);
			if (owed) {
				owed.files.push(...all);
			} else if (await this.api.exists(r.label)) {
				await this.api.send(r.label, root, all);
				await this.api.raise(r.label);
			} else {
				r.created = true;
				await this.start(r.label, root, all);
			}
		}
		return results;
	}

	/** A window reported ready: hand it what it is owed. */
	async ready(label: string): Promise<void> {
		const owed = this.waiting.get(label);
		if (!owed) return;
		this.waiting.delete(label);
		await this.api.send(label, owed.root, owed.files);
	}

	private async start(label: string, root: string, files: string[]): Promise<void> {
		if (!this.listening) {
			this.listening = true;
			this.api.onReady((l) => void this.ready(l));
		}
		this.waiting.set(label, { root, files: [...files] });
		try {
			await this.api.create(label, root);
		} catch (e) {
			this.waiting.delete(label);
			throw e;
		}
	}
}

/** One sentence for the tool result and the toast. */
export function describeOpens(root: string, opens: WindowOpen[]): string {
	const folder = folderName(root);
	const list = (fs: string[]) => fs.join(', ');
	return opens
		.map((o) => {
			const parts: string[] = [];
			if (o.added.length > 0) {
				parts.push(
					o.created
						? `Opened ${list(o.added)} in a new editor window for ${folder}.`
						: `Opened ${list(o.added)} in the editor window for ${folder}, as new tabs.`
				);
			}
			if (o.focused.length > 0) {
				parts.push(`${list(o.focused)} already had a tab; it is in front now.`);
			}
			return parts.join(' ');
		})
		.join(' ');
}

// ---- Window geometry, per folder ------------------------------------------

export interface Geometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

const GEOMETRY_KEY = 'haruspex.editorWindow.';

export function loadGeometry(root: string): Geometry | null {
	try {
		const raw = localStorage.getItem(GEOMETRY_KEY + folderKey(root));
		if (!raw) return null;
		const g = JSON.parse(raw) as Geometry;
		return [g.x, g.y, g.width, g.height].every((n) => Number.isFinite(n)) && g.width > 200
			? g
			: null;
	} catch {
		return null;
	}
}

export function saveGeometry(root: string, g: Geometry): void {
	try {
		localStorage.setItem(GEOMETRY_KEY + folderKey(root), JSON.stringify(g));
	} catch {
		// Not worth failing a close over.
	}
}

// ---- The real windows ------------------------------------------------------

const tauriApi: WindowApi = {
	findOpen: (root, files) =>
		invoke<(string | null)[]>('editor_find_open', { workdir: root, relPaths: files }),
	exists: async (label) => (await WebviewWindow.getByLabel(label)) !== null,
	async create(label, root) {
		const g = label === folderLabel(root) ? loadGeometry(root) : null;
		const w = new WebviewWindow(label, {
			url: editorUrl(root),
			title: editorTitle(null, root),
			width: g?.width ?? 960,
			height: g?.height ?? 720,
			...(g ? { x: g.x, y: g.y } : { center: true })
		});
		w.once('tauri://error', (e) => console.error('editor window error', e));
	},
	send: (label, root, files) => emitTo(label, OPEN_EVENT, { root, files } satisfies OpenPayload),
	async raise(label) {
		const w = await WebviewWindow.getByLabel(label);
		if (!w) return;
		await w.unminimize().catch(() => {});
		await w.setFocus().catch(() => {});
	},
	onReady(cb) {
		void listen<ReadyPayload>(READY_EVENT, (e) => cb(e.payload.label));
	}
};

let router: EditorRouter | null = null;

/** Open files in editor windows. See `EditorRouter.open`. */
export function openInEditorWindows(
	root: string,
	files: string[],
	newWindow = false
): Promise<WindowOpen[]> {
	router ??= new EditorRouter(tauriApi);
	return router.open(root, files, newWindow);
}
