/**
 * One file open in an editor: what is on disk, what is in the editor, and
 * what to tell the user when the two part ways.
 *
 * Shared by the Jobs review modal (`FileEditorModal`, plain reads and
 * writes) and the Code tab's editor windows (watched reads, saves that check
 * nothing changed underneath). The difference lives in the `EditorIO` each
 * one passes; the dirty tracking and the reload rules live here once.
 */

import type { EditorSave } from '#lib/ipc/gen/EditorSave.ts';

/** A file as read: `content` null when it isn't on disk. */
export interface LoadedFile {
	/** The resolved path change events name it by; null when untracked. */
	path: string | null;
	content: string | null;
	/** Content hash; null when missing, or when the IO doesn't hash. */
	hash: string | null;
}

export interface EditorIO {
	read(workdir: string, relPath: string): Promise<LoadedFile>;
	/**
	 * Write `content`. Unless `force`, an IO that tracks hashes refuses with
	 * `conflict` when the file on disk is no longer `expectedHash`.
	 */
	write(
		workdir: string,
		relPath: string,
		content: string,
		expectedHash: string | null,
		force: boolean
	): Promise<EditorSave>;
	/** Stop watching: the tab closed. */
	release?(path: string): void;
}

/**
 * What the bar above the editor says about the disk.
 * - `same`: nothing to say.
 * - `changed`: it changed while you had unsaved edits (Reload / Keep mine).
 * - `deleted`: it was deleted; saving recreates it.
 * - `new`: it didn't exist when opened; saving creates it.
 */
export type DiskState = 'same' | 'changed' | 'deleted' | 'new';

export class EditorDocument {
	readonly workdir: string;
	readonly relPath: string;
	private readonly io: EditorIO;

	/** The resolved path, once read (watched IO only). */
	path = $state<string | null>(null);
	/** What is on disk, as last read or saved. */
	baseline = $state('');
	/** What is in the editor. */
	draft = $state('');
	/** The hash of `baseline` on disk; null when not on disk. */
	hash = $state<string | null>(null);
	loaded = $state(false);
	/** The read failed (binary, too large, outside the folder). */
	failed = $state(false);
	error = $state('');
	disk = $state<DiskState>('same');
	/** A save found the file changed on disk: Overwrite or Reload first. */
	conflict = $state(false);
	/** The hash the disk reported last, for Keep mine. */
	private diskHash: string | null = null;

	constructor(workdir: string, relPath: string, io: EditorIO) {
		this.workdir = workdir;
		this.relPath = relPath;
		this.io = io;
	}

	get dirty(): boolean {
		return this.loaded && this.draft !== this.baseline;
	}

	/** Dirty, or not on disk: saving does something. */
	get canSave(): boolean {
		return this.loaded && !this.failed && (this.dirty || this.missing);
	}

	get missing(): boolean {
		return this.disk === 'deleted' || this.disk === 'new';
	}

	get name(): string {
		return this.relPath.split('/').pop() || this.relPath;
	}

	async load(): Promise<void> {
		try {
			const file = await this.io.read(this.workdir, this.relPath);
			this.path = file.path;
			this.take(file);
			if (file.content === null) this.disk = 'new';
		} catch (e) {
			this.error = `Could not open ${this.relPath}: ${String(e)}`;
			this.failed = true;
			this.baseline = '';
			this.draft = '';
		}
		this.loaded = true;
	}

	/** The editor's text changed. */
	edit(text: string): void {
		this.draft = text;
	}

	/**
	 * Save the draft. False when it didn't: an error, or (unless `force`) the
	 * file changed on disk since it was loaded, which sets `conflict`.
	 */
	async save(force = false): Promise<boolean> {
		if (!this.loaded) return true;
		if (!this.dirty && !this.missing && !force) return true;
		const content = this.draft;
		let res: EditorSave;
		try {
			res = await this.io.write(this.workdir, this.relPath, content, this.hash, force);
		} catch (e) {
			this.error = `Could not save ${this.relPath}: ${String(e)}`;
			return false;
		}
		if (res.status === 'conflict') {
			this.diskHash = res.hash;
			this.conflict = true;
			return false;
		}
		this.baseline = content;
		this.hash = res.hash;
		this.disk = 'same';
		this.conflict = false;
		this.error = '';
		return true;
	}

	/**
	 * The watcher says the file on disk is now `hash` (null: deleted). A
	 * clean file reloads silently; a dirty one keeps its edits and says so.
	 */
	async diskChanged(hash: string | null): Promise<void> {
		if (!this.loaded || this.failed) return;
		if (hash === this.hash && !this.missing) return;
		this.diskHash = hash;
		if (hash === null) {
			this.hash = null;
			this.disk = 'deleted';
			return;
		}
		if (this.dirty) {
			this.disk = 'changed';
			return;
		}
		const before = this.draft;
		let file: LoadedFile;
		try {
			file = await this.io.read(this.workdir, this.relPath);
		} catch (e) {
			this.error = `Could not reload ${this.relPath}: ${String(e)}`;
			return;
		}
		// Typed into while the read was in flight: that is a dirty file now.
		if (this.draft !== before) {
			this.diskHash = file.hash;
			this.disk = file.content === null ? 'deleted' : 'changed';
			if (file.content === null) this.hash = null;
			return;
		}
		this.take(file);
		this.disk = file.content === null ? 'deleted' : 'same';
	}

	/** Reload (the bar) or Reload first (the conflict): disk wins. */
	async reload(): Promise<void> {
		try {
			const file = await this.io.read(this.workdir, this.relPath);
			this.take(file);
			this.disk = file.content === null ? 'deleted' : 'same';
			this.conflict = false;
			this.error = '';
		} catch (e) {
			this.error = `Could not reload ${this.relPath}: ${String(e)}`;
		}
	}

	/** Keep mine: the edits stay, and the next save replaces what is on disk. */
	keepMine(): void {
		this.hash = this.diskHash;
		this.disk = this.diskHash === null ? 'deleted' : 'same';
	}

	/** Overwrite (the conflict): save over whatever is on disk. */
	overwrite(): Promise<boolean> {
		return this.save(true);
	}

	/** The tab closed. */
	close(): void {
		if (this.path) this.io.release?.(this.path);
	}

	private take(file: LoadedFile): void {
		const text = file.content ?? '';
		this.hash = file.hash;
		this.diskHash = file.hash;
		this.baseline = text;
		this.draft = text;
		this.error = '';
	}
}
