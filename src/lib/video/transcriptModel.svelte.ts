/**
 * The transcript viewer's state: a clip's word-timed transcript from the
 * cache, the word playing now, the words selected, and the edit list
 * (`edits.ts`) kept beside the transcript. Reading and writing go through
 * `TranscriptIO`, the editor's own commands in the app.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';
import type { TranscriptFound } from '#lib/ipc/gen/TranscriptFound.ts';
import type { TranscribeProgress } from '#lib/ipc/gen/TranscribeProgress.ts';
import type { EditorFile } from '#lib/ipc/gen/EditorFile.ts';
import type { Word } from '#lib/ipc/gen/Word.ts';
import { videoSettings } from '#lib/video/args.ts';
import {
	addEdit,
	cutOf,
	emptyEdits,
	parseEdits,
	removeEdit,
	replaceOf,
	stale,
	transcriptHash,
	wordsOf,
	type SpeechEdits
} from '#lib/video/edits.ts';

export interface TranscriptIO {
	find(workdir: string, relPath: string): Promise<TranscriptFound | null>;
	transcribe(
		workdir: string,
		relPath: string,
		progress: (p: TranscribeProgress) => void
	): Promise<void>;
	readText(workdir: string, relPath: string): Promise<string | null>;
	writeText(workdir: string, relPath: string, text: string): Promise<void>;
}

export const appTranscriptIO: TranscriptIO = {
	find: (workdir, relPath) =>
		invoke<TranscriptFound | null>('video_transcript_for', { workingDir: workdir, path: relPath }),
	async transcribe(workdir, relPath, progress) {
		const onProgress = new Channel<TranscribeProgress>();
		onProgress.onmessage = progress;
		await invoke('video_transcribe', {
			workingDir: workdir,
			episode: '',
			clips: [relPath],
			refresh: false,
			settings: videoSettings(),
			job: `viewer-${Date.now()}`,
			onProgress
		});
	},
	async readText(workdir, relPath) {
		const f = await invoke<EditorFile>('editor_read_file', { workdir, relPath });
		void invoke('editor_unwatch_file', { path: f.path }).catch(() => {});
		return f.content;
	},
	async writeText(workdir, relPath, content) {
		await invoke('editor_save_file', {
			workdir,
			relPath,
			content,
			expectedHash: null,
			force: true
		});
	}
};

export class TranscriptModel {
	readonly workdir: string;
	readonly clip: string;
	private readonly io: TranscriptIO;

	transcript = $state.raw<Transcript | null>(null);
	words = $state.raw<Word[]>([]);
	edits = $state.raw<SpeechEdits | null>(null);
	/** An edit list made on an older transcript, shown greyed until discarded. */
	staleEdits = $state.raw<SpeechEdits | null>(null);
	editsPath = $state('');
	loading = $state(true);
	transcribing = $state<string | null>(null);
	error = $state('');
	/** First and last selected word, in order. */
	selection = $state<{ a: number; b: number } | null>(null);
	/** Unsaved changes to the edit list. */
	dirty = $state(false);
	private hash = '';

	constructor(workdir: string, clip: string, io: TranscriptIO = appTranscriptIO) {
		this.workdir = workdir;
		this.clip = clip;
		this.io = io;
	}

	async load(): Promise<void> {
		this.loading = true;
		this.error = '';
		try {
			const found = await this.io.find(this.workdir, this.clip);
			this.transcript = found?.transcript ?? null;
			this.words = found ? wordsOf(found.transcript) : [];
			this.editsPath = found?.editsPath ?? '';
			this.edits = null;
			this.staleEdits = null;
			if (found) await this.loadEdits(found.transcript);
		} catch (e) {
			this.error = String(e);
		}
		this.loading = false;
	}

	private async loadEdits(t: Transcript): Promise<void> {
		this.hash = await transcriptHash(t);
		const text = await this.io.readText(this.workdir, this.editsPath).catch(() => null);
		const saved = text ? parseEdits(text) : null;
		if (saved && stale(saved, this.hash)) this.staleEdits = saved;
		this.edits = saved && !stale(saved, this.hash) ? saved : emptyEdits(this.clip, this.hash);
		this.dirty = false;
	}

	async transcribe(): Promise<void> {
		this.transcribing = 'Starting';
		this.error = '';
		try {
			await this.io.transcribe(this.workdir, this.clip, (p) => {
				this.transcribing = `${Math.round(p.doneSecs)} of ${Math.round(p.totalSecs)} s`;
			});
			await this.load();
		} catch (e) {
			this.error = String(e);
		}
		this.transcribing = null;
	}

	/** The word playing at `t`, or -1. */
	wordAt(t: number): number {
		const w = this.words;
		let lo = 0;
		let hi = w.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (w[mid].start <= t + 1e-3) {
				found = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return found >= 0 && t <= w[found].end + 0.25 ? found : -1;
	}

	/** Select word `i`; with `extend`, from the selection's start to it. */
	select(i: number, extend = false): void {
		const s = this.selection;
		this.selection = extend && s ? { a: Math.min(s.a, i), b: Math.max(s.a, i) } : { a: i, b: i };
	}

	private selected(): number[] {
		const s = this.selection;
		return s ? Array.from({ length: s.b - s.a + 1 }, (_, k) => s.a + k) : [];
	}

	private change(next: SpeechEdits['edits']): void {
		if (!this.edits) return;
		this.edits = { ...this.edits, edits: next };
		this.dirty = true;
	}

	cut(): void {
		const ix = this.selected();
		if (!ix.length || !this.edits) return;
		this.change(addEdit(this.edits.edits, cutOf(this.words, ix), this.words));
		this.selection = null;
	}

	replace(text: string): void {
		const ix = this.selected();
		if (!ix.length || !this.edits || !text.trim()) return;
		this.change(addEdit(this.edits.edits, replaceOf(this.words, ix, text), this.words));
		this.selection = null;
	}

	undo(id: string): void {
		if (this.edits) this.change(removeEdit(this.edits.edits, id));
	}

	setVoice(voice: string): void {
		if (!this.edits) return;
		const next: SpeechEdits = { ...this.edits };
		if (voice) next.voice = voice;
		else delete next.voice;
		this.edits = next;
		this.dirty = true;
	}

	discardStale(): void {
		this.staleEdits = null;
		this.dirty = true;
	}

	async save(): Promise<void> {
		if (!this.edits || !this.editsPath) return;
		await this.io.writeText(
			this.workdir,
			this.editsPath,
			`${JSON.stringify(this.edits, null, '\t')}\n`
		);
		this.dirty = false;
	}
}
