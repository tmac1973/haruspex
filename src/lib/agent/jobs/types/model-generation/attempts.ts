/**
 * Every judged attempt at one entry's stage, kept on disk, with the best one
 * put forward.
 *
 * A model's later attempt is not always better than its first: it can trade
 * one problem for three. So each time the files are judged (after a batch
 * that ran `check_3d`, and when a turn ends) the stage's own file, its GLB,
 * its sheets and its problems are copied to `attempts/<stage>-NN/`. The
 * entry's main files are the best attempt so far: a done one over one that
 * isn't, then one that built over one that didn't, then the fewest problems,
 * and on a tie the earlier. When the stage
 * ends, the best attempt's source is put back if a later one replaced it,
 * so the source and the GLB beside it always match.
 */

import {
	modelLoadIo,
	writeModelBytes,
	writeSheetPng,
	type ModelDisk
} from '#lib/agent/jobs/types/model-generation/io.ts';
import { judgeModel, type ModelStage, type ModelVerdict } from '#lib/glb/verdict.ts';
import type { LoadIo } from '#lib/helpers/three/load.ts';
import { modelFiles, slugify } from '#lib/models3d/spec/paths.ts';
import type { ModelEntry } from '#lib/models3d/spec/types.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { normalizeAbort } from '#lib/utils/error.ts';

export async function sha256(bytes: Uint8Array): Promise<string> {
	// A fresh buffer: `digest` refuses a view onto a shared one.
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return bytesToBase64(new Uint8Array(digest));
}

/** One judged attempt: its number and what kept it from done. */
export interface Attempt {
	n: number;
	done: boolean;
	problems: string[];
	warnings: string[];
	/** Whether it is now the entry's best, so its files are the main ones. */
	kept: boolean;
	verdict: ModelVerdict;
}

interface Best {
	n: number;
	done: boolean;
	built: boolean;
	problems: string[];
	source: Uint8Array;
	hash: string;
}

/** What ranks an attempt: done, whether it built, and its problems. */
export interface Rank {
	done: boolean;
	built: boolean;
	problems: string[];
}

/** Whether `a` should replace `b` as the best: done, then built, then fewer problems. */
export function better(a: Rank, b: Rank | null): boolean {
	if (!b) return true;
	if (a.done !== b.done) return a.done;
	if (a.built !== b.built) return a.built;
	return a.problems.length < b.problems.length;
}

/** The folder one attempt is copied to, under the entry's own. */
export function attemptDir(entry: Pick<ModelEntry, 'dir'>, stage: ModelStage, n: number): string {
	const dir = entry.dir.endsWith('/') ? entry.dir : `${entry.dir}/`;
	return `${dir}attempts/${stage}-${String(n).padStart(2, '0')}/`;
}

export interface AttemptsInput {
	workdir: string;
	/** The run's scope for the files it makes (`ModelDisk`). */
	scope: string | null;
	entry: ModelEntry;
	stage: ModelStage;
	/** Attempts already numbered for this stage (a rebuild after review goes on from there). */
	start: number;
	signal: AbortSignal;
	io?: LoadIo;
}

export class Attempts {
	count: number;
	private best: Best | null = null;
	private last: { hash: string; attempt: Attempt } | null = null;
	private readonly files: ReturnType<typeof modelFiles>;
	private readonly io: LoadIo;
	private readonly disk: ModelDisk;

	constructor(private readonly input: AttemptsInput) {
		this.count = input.start;
		this.disk = { workdir: input.workdir, scope: input.scope };
		this.files = modelFiles(input.entry);
		this.io = input.io ?? modelLoadIo(input.workdir);
	}

	/** The file this stage writes: the build module, or the animation module. */
	private get sourcePath(): string {
		return this.input.stage === 'create' ? this.files.build : this.files.anim;
	}

	/** The best attempt's number, or null before any was judged. */
	get kept(): number | null {
		return this.best?.n ?? null;
	}

	/**
	 * Judge the files as they stand. A source unchanged since the last
	 * attempt gives that attempt back, uncounted; no source gives null. A
	 * checker that throws is a problem for this attempt; a cancel rethrows.
	 */
	async judge(): Promise<Attempt | null> {
		const { entry, stage, signal } = this.input;
		let source: Uint8Array;
		try {
			source = new Uint8Array(await this.io.read(this.sourcePath));
		} catch {
			return null;
		}
		const hash = await sha256(source);
		if (this.last?.hash === hash) return this.last.attempt;

		let verdict: ModelVerdict;
		try {
			verdict = await judgeModel({ entry, files: this.files, stage, io: this.io, signal });
		} catch (e) {
			const { aborted, msg } = normalizeAbort(e);
			if (aborted || signal.aborted) throw new DOMException('Aborted', 'AbortError');
			verdict = {
				done: false,
				problems: [`The check could not run: ${msg}`],
				warnings: [],
				text: '',
				sheetPng: null,
				clipSheets: {},
				glb: null
			};
		}
		const n = ++this.count;
		await this.save(n, source, verdict);
		const rank: Rank = {
			done: verdict.done,
			built: verdict.glb !== null,
			problems: verdict.problems
		};
		const kept = better(rank, this.best);
		if (kept) {
			this.best = { n, ...rank, source, hash };
			await this.putForward(verdict);
		}
		const attempt: Attempt = {
			n,
			done: verdict.done,
			problems: verdict.problems,
			warnings: verdict.warnings,
			kept,
			verdict
		};
		this.last = { hash, attempt };
		return attempt;
	}

	/**
	 * The stage is over: put the best attempt's source back if a later one
	 * replaced it, so it matches the GLB. The best attempt, or null when none
	 * was judged.
	 */
	async finish(): Promise<{ n: number; done: boolean; problems: string[] } | null> {
		const best = this.best;
		if (!best) return null;
		if (this.last?.hash !== best.hash) {
			await writeModelBytes(this.disk, this.sourcePath, best.source);
		}
		return { n: best.n, done: best.done, problems: best.problems };
	}

	/** Copy one attempt to its own folder: its source, GLB, sheets and problems. */
	private async save(n: number, source: Uint8Array, v: ModelVerdict): Promise<void> {
		const { entry, stage } = this.input;
		const dir = attemptDir(entry, stage, n);
		const name = this.sourcePath.slice(this.sourcePath.lastIndexOf('/') + 1);
		await writeModelBytes(this.disk, `${dir}${name}`, source);
		if (v.glb) await writeModelBytes(this.disk, `${dir}${entry.id}.glb`, v.glb);
		if (stage === 'create' && v.sheetPng)
			await writeSheetPng(this.disk, `${dir}sheet.png`, v.sheetPng);
		for (const [clip, png] of Object.entries(v.clipSheets)) {
			await writeSheetPng(this.disk, `${dir}clip-${slugify(clip)}.png`, png);
		}
		const lines = [
			v.done ? 'Done.' : 'Not done.',
			...v.problems.map((p) => `- ${p}`),
			...(v.warnings.length ? ['', 'Warnings:', ...v.warnings.map((w) => `- ${w}`)] : [])
		];
		await writeModelBytes(
			this.disk,
			`${dir}problems.txt`,
			new TextEncoder().encode(lines.join('\n') + '\n')
		);
	}

	/** Make this attempt's GLB and sheets the entry's main ones. */
	private async putForward(v: ModelVerdict): Promise<void> {
		if (v.glb) await writeModelBytes(this.disk, this.files.glb, v.glb);
		if (this.input.stage === 'create' && v.sheetPng) {
			await writeSheetPng(this.disk, this.files.sheet, v.sheetPng);
		}
		for (const [clip, png] of Object.entries(v.clipSheets)) {
			await writeSheetPng(this.disk, this.files.clipSheet(clip), png);
		}
	}
}
