/**
 * The Generate stage: the clip plan, one clip at a time, on the video
 * instance.
 *
 * A continuation starts from the true last frame of the clip before it (a
 * still taken from that clip's file), a re-anchor ends on its section's
 * re-anchor still, and a transition runs from one section's last frame to
 * the picture the next one starts from. Each clip is saved into the episode
 * folder as soon as it is made, and the progress file says so, with the
 * server's job handle while one is in flight: a run that stopped carries on
 * from the next clip not made, and follows a job Haruspex closed on.
 */
import type {
	VideoGenerateOptions,
	VideoJobHandle,
	VideoProgress,
	VideoRequest,
	VideoResult,
	VideoStartImage
} from '#lib/videogen/types.ts';
import type {
	ClipPlan,
	EndRef,
	GenerateItem,
	PlanItem,
	StartRef
} from '#lib/sequence/spec/plan.ts';
import type { ClipProgress } from '#lib/sequence/spec/progress.ts';
import { GENERATED_DIR } from '#lib/sequence/spec/paths.ts';
import { estimateRun } from '#lib/sequence/spec/estimate.ts';
import { firstFrameId, reanchorId } from '#lib/sequence/spec/progress.ts';
import { errMessage } from '#lib/utils/error.ts';

type ClipOpts = Pick<VideoGenerateOptions, 'onHandle' | 'onProgress'>;

/** What the stage reaches outside itself for. Paths are relative to the episode folder. */
export interface GenerateDeps {
	generate(req: VideoRequest, opts: ClipOpts): Promise<VideoResult>;
	/** Follow a job an earlier run sent; throws when the server no longer has it. */
	resume(handle: VideoJobHandle, req: VideoRequest, opts: ClipOpts): Promise<VideoResult>;
	/** A picture in the episode folder, put in the image cache for a request. */
	cacheImage(rel: string): Promise<VideoStartImage>;
	/** A sound in the episode folder, put in the audio cache for a speaking window. */
	cacheAudio(rel: string): Promise<{ name: string; hash: string }>;
	/** A frame of a clip as a PNG: its last, or the one at `atSecs`. */
	still(clip: string, out: string, at: 'first' | 'last' | number): Promise<void>;
	/** A finished clip, from the cache into the episode folder. */
	saveClip(hash: string, rel: string): Promise<void>;
	exists(rel: string): Promise<boolean>;
	/** Write the progress file as it is now. */
	saveProgress(): Promise<void>;
	/** Say where the stage is, for the step's output while it runs. */
	status(text: string): void;
	/**
	 * Attended: a section's first clip is made; go on, stop, or make it
	 * again (with a note for the prompt, which the caller writes into the spec).
	 */
	ask?(item: GenerateItem, made: VideoResult): Promise<'continue' | 'stop' | { redo: string }>;
	/**
	 * With a vision model: does the clip continue the picture it started
	 * from, and keep its section's look? Null when it could not tell.
	 */
	check?(
		item: GenerateItem,
		clip: string,
		against: { start: string | null; keyframe: string | null }
	): Promise<{ ok: boolean; problem?: string } | null>;
	seed(): number;
	now(): number;
	/** Wait, as when the server could not start the model; rejects when the run is cancelled. */
	pause(ms: number): Promise<void>;
	signal?: AbortSignal;
}

export interface GenerateRun {
	plan: ClipPlan;
	/** Each item's key, from `itemKeys`. */
	keys: Record<string, string>;
	/** The progress file's clips, updated as the stage goes. */
	clips: Record<string, ClipProgress>;
	/** Each still's file, by its progress id (`snow`, `snow-r6`, `phone-first`). */
	stills: Record<string, string>;
}

/** How the stage ended. */
export type GenerateOutcome =
	| { kind: 'done'; made: number; kept: number; secsPerClip: number | null }
	/** Attended: the user asked for a section's first clip again, with a note. */
	| { kind: 'redo'; section: string; note: string };

export const STILLS_DIR = '.haruspex/stills';

/** Where a generated clip goes in the episode folder. */
export function clipPath(id: string, mime = 'video/webm'): string {
	return `${GENERATED_DIR}/${id}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** How many times a clip waits for a model the server could not start. */
export const START_WAITS = 3;
const START_WAIT_MS = 60_000;

/**
 * Whether a failure is the server not starting the model (another model holds
 * the GPU) rather than the clip itself. Running out of memory while making a
 * clip is the clip's: it fails as one.
 */
export function couldNotStart(message: string): boolean {
	return /starting the backend|not enough VRAM|failed to load the model/i.test(message);
}

/**
 * The order clips are made in: the plan's, except a transition that ends on
 * a generated clip's first frame waits until that clip is made.
 */
export function makeOrder(plan: ClipPlan): GenerateItem[] {
	const items = plan.items.filter((i): i is GenerateItem => i.kind === 'generate');
	const out: GenerateItem[] = [];
	const waiting = new Map<string, GenerateItem[]>();
	for (const item of items) {
		const end = item.end;
		const target =
			end?.kind === 'firstFrameOf' ? plan.items.find((i) => i.id === end.id) : undefined;
		if (target?.kind === 'generate' && !out.some((o) => o.id === target.id)) {
			waiting.set(target.id, [...(waiting.get(target.id) ?? []), item]);
			continue;
		}
		out.push(item);
		out.push(...(waiting.get(item.id) ?? []));
		waiting.delete(item.id);
	}
	return out;
}

function percent(p: VideoProgress): string {
	if (p.phase === 'queued') return p.ahead ? `queued, ${p.ahead} ahead` : 'queued';
	if (p.phase === 'starting') return 'starting the model';
	if (p.phase === 'saving') return 'saving';
	return p.totalSteps ? `${Math.round(((p.step ?? 0) / p.totalSteps) * 100)}%` : 'generating';
}

/** Turns a clip's start or end reference into a PNG in the episode folder. */
function pictures(run: GenerateRun, deps: GenerateDeps) {
	const byId = new Map<string, PlanItem>(run.plan.items.map((i) => [i.id, i]));
	const frameOf = async (id: string, which: 'first' | 'last'): Promise<string> => {
		const item = byId.get(id);
		const out = `${STILLS_DIR}/${id}-${which}.png`;
		if (item?.kind !== 'existing') {
			await deps.still(run.clips[id]?.file ?? clipPath(id), out, which);
			return out;
		}
		const taken = run.stills[firstFrameId(item.section)];
		if (which === 'first' && taken) return taken;
		const lastAt =
			item.out_secs !== undefined ? Math.max(0, item.out_secs - 1 / run.plan.fps) : 'last';
		await deps.still(item.path, out, which === 'first' ? (item.in_secs ?? 0) : lastAt);
		return out;
	};
	const pictureOf = async (ref: StartRef | EndRef | undefined): Promise<string | null> => {
		switch (ref?.kind) {
			case undefined:
			case 'text':
				return null;
			case 'keyframe':
			case 'portrait':
				return run.stills[ref.section] ?? null;
			case 'userImage':
				return ref.path;
			case 'reanchor':
				return run.stills[reanchorId(ref.section, ref.n)] ?? run.stills[ref.section] ?? null;
			case 'startOf':
				return pictureOf(ref.start);
			case 'lastFrameOf':
				return frameOf(ref.id, 'last');
			case 'firstFrameOf':
				return frameOf(ref.id, 'first');
		}
	};
	return pictureOf;
}

/** One clip to make: where it stands, and what to ask the server for. */
interface Job {
	item: GenerateItem;
	key: string;
	/** Where the stage is, for the status line. */
	where: string;
	/** The seed to start with. */
	seed: number;
	/** A job an earlier run left in flight on the server. */
	resume?: VideoJobHandle;
	request: (seed: number) => VideoRequest;
	/** The picture it starts from, for the check. */
	start: string | null;
}

/** Make one clip: follow its job if one is in flight, else make it, once more on a new seed. */
async function makeClip(
	job: Job,
	run: GenerateRun,
	deps: GenerateDeps
): Promise<{ result: VideoResult; seed: number }> {
	const { item, key, where } = job;
	const opts = (seed: number): ClipOpts => ({
		onProgress: (p) => deps.status(`${where} — ${percent(p)}`),
		onHandle: (handle) => {
			run.clips[item.id] = { key, status: 'running', handle, seed };
			void deps.saveProgress().catch((e) => console.warn('progress not saved', e));
		}
	});
	if (job.resume) {
		try {
			const result = await deps.resume(job.resume, job.request(job.seed), opts(job.seed));
			return { result, seed: job.seed };
		} catch (e) {
			if (isAbort(e)) throw e;
			// The server no longer has it: make it again.
			run.clips[item.id] = { key, status: 'pending', seed: job.seed };
		}
	}
	let seed = job.seed;
	let waits = 0;
	for (let attempt = 0; ; attempt++) {
		try {
			return { result: await deps.generate(job.request(seed), opts(seed)), seed };
		} catch (e) {
			if (isAbort(e)) throw e;
			const why = errMessage(e);
			// The model couldn't load (another holds the GPU): a new seed won't
			// help. Wait and send the same request again, a few times.
			if (couldNotStart(why)) {
				if (waits >= START_WAITS) {
					run.clips[item.id] = { key, status: 'pending', seed };
					await deps.saveProgress();
					throw new Error(
						`The video server could not start the model for clip ${item.id} after ${START_WAITS + 1} tries: ${why}`,
						{ cause: e }
					);
				}
				waits++;
				attempt--;
				deps.status(`${where} — the server could not start the model; trying again in a minute`);
				await deps.pause(START_WAIT_MS);
				continue;
			}
			if (attempt >= 1) {
				run.clips[item.id] = { key, status: 'failed', seed };
				await deps.saveProgress();
				throw new Error(`Clip ${item.id} failed twice: ${why}`, { cause: e });
			}
			seed = deps.seed();
		}
	}
}

/**
 * Make a clip and keep it; with a check, a clip that fails is made once more
 * on a new seed and checked again. A second failure keeps the newer clip,
 * flagged: a long run never stalls on a judgement.
 */
async function makeChecked(job: Job, run: GenerateRun, deps: GenerateDeps) {
	const keyframe = job.item.join ? null : (run.stills[job.item.section] ?? null);
	const against = { start: job.start, keyframe: keyframe === job.start ? null : keyframe };
	let made = await makeClip(job, run, deps);
	let file = clipPath(job.item.id, made.result.mime);
	await deps.saveClip(made.result.hash, file);
	if (!deps.check) return { ...made, file, check: null };
	let check = await deps.check(job.item, file, against);
	if (check && !check.ok) {
		deps.status(`${job.where} — the check failed (${check.problem}); making it again`);
		made = await makeClip({ ...job, seed: deps.seed(), resume: undefined }, run, deps);
		file = clipPath(job.item.id, made.result.mime);
		await deps.saveClip(made.result.hash, file);
		check = await deps.check(job.item, file, against);
	}
	return { ...made, file, check: check ?? null };
}

/** The seed a clip starts with: a redo's new one, the one it had, the spec's, or a new one. */
function seedFor(
	item: GenerateItem,
	was: ClipProgress | undefined,
	fresh: boolean,
	redo: boolean,
	deps: GenerateDeps
): number {
	// A redo asked for gets a new seed, even where the spec names one.
	if (redo) return deps.seed();
	if (!fresh && was?.seed !== undefined) return was.seed;
	return item.seed ?? deps.seed();
}

/** Run the plan's clips; what was made, or a redo the user asked for. */
export async function runGenerate(run: GenerateRun, deps: GenerateDeps): Promise<GenerateOutcome> {
	const order = makeOrder(run.plan);
	const pictureOf = pictures(run, deps);
	const counts = { made: 0, kept: 0 };
	let secsPerClip: number | null = null;
	const reseed = new Set<string>();

	for (let k = 0; k < order.length; k++) {
		const item = order[k];
		if (deps.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		const key = run.keys[item.id];
		const was = run.clips[item.id];
		if (was?.status === 'done' && was.key === key && was.file && (await deps.exists(was.file))) {
			counts.kept++;
			continue;
		}
		const where = `clip ${k + 1} of ${order.length} — ${item.join ? `join ${item.join}` : `section ${item.section}`}`;
		deps.status(`${where} — preparing`);
		const job = await prepare(
			item,
			{ key, where, was, redo: reseed.has(item.id) },
			run,
			deps,
			pictureOf
		);
		const began = deps.now();
		const { result, seed, file, check } = await makeChecked(job, run, deps);
		const secs = (deps.now() - began) / 1000;
		run.clips[item.id] = {
			key,
			status: 'done',
			file,
			seed: result.seed ?? seed,
			hasAudio: result.hasAudio,
			secs,
			...(check ? { check } : {})
		};
		await deps.saveProgress();
		counts.made++;
		secsPerClip ??= secs;
		deps.status(progressLine(run, order, k, secsPerClip));
		const asked = await askAfter(item, result, deps);
		if (asked === 'again') {
			reseed.add(item.id);
			delete run.clips[item.id];
			counts.made--;
			k--;
		} else if (asked) {
			return asked;
		}
	}
	return { kind: 'done', ...counts, secsPerClip };
}

/** A clip's request, with its pictures cached once: a missing one is not the model failing. */
async function prepare(
	item: GenerateItem,
	at: { key: string; where: string; was: ClipProgress | undefined; redo: boolean },
	run: GenerateRun,
	deps: GenerateDeps,
	pictureOf: ReturnType<typeof pictures>
): Promise<Job> {
	const start = await pictureOf(item.start);
	const end = await pictureOf(item.end);
	const startImage = start ? await deps.cacheImage(start) : null;
	const endImage = end ? await deps.cacheImage(end) : null;
	// A speaking window: its speech, and the speaking instance's size and rate.
	const audio = item.audio ? await deps.cacheAudio(item.audio.out) : null;
	const size = audio && run.plan.speakingSize ? run.plan.speakingSize : run.plan;
	const fresh = at.redo || at.was?.key !== at.key;
	const inFlight = !fresh && at.was?.status === 'running' ? at.was.handle : undefined;
	return {
		item,
		key: at.key,
		where: at.where,
		seed: seedFor(item, at.was, fresh, at.redo, deps),
		start,
		...(inFlight ? { resume: inFlight } : {}),
		request: (seed) => ({
			title: item.id,
			prompt: item.prompt,
			...(item.negative_prompt ? { negativePrompt: item.negative_prompt } : {}),
			width: size.width,
			height: size.height,
			frames: item.frames,
			fps: item.fps ?? run.plan.fps,
			seed,
			...(startImage ? { startImage } : {}),
			...(endImage ? { endImage } : {}),
			...(audio ? { audio, followAudio: true } : {})
		})
	};
}

function progressLine(run: GenerateRun, order: GenerateItem[], k: number, secs: number): string {
	const left = estimateRun({ ...run.plan, items: order.slice(k + 1) }, secs);
	const time = left.minutes !== null && left.clips ? ` About ${left.minutes} min left.` : '';
	return `${k + 1} of ${order.length} clips made.${time}`;
}

/** Attended, after a section's first clip: null to go on, 'again' for a new seed, or a redo. */
async function askAfter(
	item: GenerateItem,
	result: VideoResult,
	deps: GenerateDeps
): Promise<null | 'again' | GenerateOutcome> {
	if (!deps.ask || !item.id.endsWith('-01') || item.join) return null;
	const answer = await deps.ask(item, result);
	if (answer === 'stop') throw new DOMException('Aborted', 'AbortError');
	if (answer === 'continue') return null;
	const note = answer.redo.trim();
	return note ? { kind: 'redo', section: item.section, note } : 'again';
}
