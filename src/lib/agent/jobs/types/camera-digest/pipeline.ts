/**
 * Camera digest: summarise what the cameras' ambient logs recorded over a
 * period. Two stages.
 *
 * - Gather (no model): the chosen cameras set to Allow, and their log entries
 *   for the period. A camera set to Ask is skipped with a note; jobs never use
 *   one.
 * - Summarise: one model turn, given the entries as text, writes a summary
 *   and a few highlights. Its tools are `camera_log` (to look further) and,
 *   when the job asks for one and the model can see, `camera_snapshot`. Both
 *   pass through the camera gate, which refuses an Ask camera to a job.
 *
 * Entries camera alerts flagged Unusual or Urgent, and not dismissed, lead
 * the prompt and the result. With Email the result on, the summary goes to
 * the addresses in Settings → Cameras → Alerts.
 *
 * An empty period ends with "Nothing was logged." and no model turn, and no email.
 */
import { invoke } from '@tauri-apps/api/core';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import type { JobRunSummary } from '#lib/stores/jobRuns.svelte.ts';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted
} from '#lib/stores/jobRuns.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage, normalizeAbort } from '#lib/utils/error.ts';
import { parseModelJson } from '#lib/agent/jobs/cardResult.ts';
import { jobBackendOverride } from '#lib/agent/jobs/jobBackend.ts';
import { NOT_LOCAL } from '#lib/agent/tools/_cameraGate.ts';
import { cameraDataAllowed } from '#lib/camera/trust.ts';
import { renderCameraLog, stamp } from '#lib/camera/log.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { sendAlert } from '#lib/camera/alertDispatch.ts';
import { MAX_ATTACHMENTS_PER_EMAIL } from '#lib/camera/alertConfig.ts';
import type { JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import {
	parseCameraDigestConfig,
	type CameraDigestConfig
} from '#lib/agent/jobs/types/camera-digest/config.ts';

/** Entries read from each camera's log, newest first. */
export const PER_CAMERA = 200;
/** Flagged entries per camera that always reach the prompt. */
export const FLAGGED_PER_CAMERA = 50;
const DAY = 24 * 3_600_000;
/** Tool rounds the summary turn may take: a few log searches and pictures. */
const MAX_ITERATIONS = 8;

const GATHER = 0;
const SUMMARISE = 1;

export const NOTHING_LOGGED = 'Nothing was logged.';
export const NO_VISION = "Snapshot skipped: the model can't see images.";

export function planCameraDigestSteps(): PlannedStep[] {
	return [
		{ authored: 'Gather', deepResearch: false, description: 'Reads the camera log.' },
		{ authored: 'Summarise', deepResearch: false, description: 'Writes what happened.' }
	];
}

export interface Highlight {
	time: string;
	camera: string;
	text: string;
}

/** The run's stored result. */
export interface CameraDigestResult {
	summary: string;
	highlights: Highlight[];
	/** The flagged entries the summary covered, in time order. */
	flagged?: Highlight[];
}

/** Whether camera alerts flagged an entry and it wasn't dismissed. */
export function isFlagged(e: CameraEvent): boolean {
	return (e.alertLevel === 'unusual' || e.alertLevel === 'urgent') && e.dismissedAt === null;
}

/**
 * Split entries (newest first) into the flagged ones, up to
 * `FLAGGED_PER_CAMERA` a camera, and the rest.
 */
export function splitFlagged(events: CameraEvent[]): {
	flagged: CameraEvent[];
	rest: CameraEvent[];
} {
	const count = new Map<string, number>();
	const flagged: CameraEvent[] = [];
	const rest: CameraEvent[] = [];
	for (const e of events) {
		const n = count.get(e.cameraId) ?? 0;
		if (isFlagged(e) && n < FLAGGED_PER_CAMERA) {
			count.set(e.cameraId, n + 1);
			flagged.push(e);
		} else {
			rest.push(e);
		}
	}
	return { flagged, rest };
}

/**
 * The cameras the job may read, and a note for each it can't: removed, or set
 * to Ask. No cameras chosen means every camera set to Allow.
 */
export function resolveDigestCameras(
	config: CameraDigestConfig,
	cameras: readonly CameraConfig[] = getSettings().cameras
): { cameras: CameraConfig[]; notes: string[] } {
	if (config.cameras.length === 0) {
		return { cameras: cameras.filter((c) => c.permission === 'allow'), notes: [] };
	}
	const out: CameraConfig[] = [];
	const notes: string[] = [];
	for (const id of config.cameras) {
		const camera = cameras.find((c) => c.id === id);
		if (!camera) {
			notes.push('- A camera this job reads was removed in Settings → Cameras.');
		} else if (camera.permission !== 'allow') {
			notes.push(`- Skipped ${camera.name}: set to Ask (Settings → Cameras)`);
		} else {
			out.push(camera);
		}
	}
	return { cameras: out, notes };
}

/** When this job last finished a run, as epoch ms; null when it never has. */
async function lastSucceededAt(jobId: number, runId: number): Promise<number | null> {
	try {
		const runs = await invoke<JobRunSummary[]>('db_list_job_runs', { jobId });
		const last = runs.find((r) => r.id !== runId && r.status === 'succeeded');
		return last ? (last.started_at ?? last.queued_at) : null;
	} catch {
		return null;
	}
}

/** The period's start, as epoch ms. */
export function periodStart(
	period: CameraDigestConfig['period'],
	lastRun: number | null,
	now = new Date()
): number {
	if (period === 'today') {
		return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	}
	if (period === 'since_last_run' && lastRun !== null && lastRun < now.getTime()) return lastRun;
	return now.getTime() - DAY;
}

/** The tools the summary turn is given. */
export function digestToolAllowlist(includeSnapshot: boolean, vision: boolean): string[] {
	return includeSnapshot && vision ? ['camera_log', 'camera_snapshot'] : ['camera_log'];
}

const SYSTEM_PROMPT =
	"You summarise what a person's home cameras logged. Each entry is one time something moved or someone spoke: what was said, and a one-line caption of what was seen. Some entries were flagged Unusual or Urgent, with why. Report only what the entries and pictures show; never guess who someone is. Answer with JSON only.";

export function summaryPrompt(opts: {
	cameras: CameraConfig[];
	since: number;
	until: number;
	log: string;
	count: number;
	omitted: number;
	focus: string;
	snapshot: boolean;
	/** The flagged entries as log lines, oldest first; empty for none. */
	flagged?: string;
}): string {
	const names = opts.cameras.map((c) => c.name).join(', ');
	const lines: string[] = [];
	if (opts.flagged) {
		lines.push('Flagged entries (Unusual or Urgent), oldest first:', '', opts.flagged, '');
	}
	lines.push(
		`Camera log for ${names}, from ${stamp(new Date(opts.since))} to ${stamp(new Date(opts.until))} (local time). ${opts.count} ${opts.count === 1 ? 'entry' : 'entries'}, oldest first:`,
		'',
		opts.log
	);
	if (opts.omitted > 0) {
		lines.push('', `${opts.omitted} older entries were left out; camera_log can search them.`);
	}
	if (opts.snapshot) {
		lines.push('', `Take one picture from each of these cameras with camera_snapshot: ${names}.`);
	}
	lines.push('');
	if (opts.focus.trim()) lines.push(`Focus: ${opts.focus.trim()}`, '');
	lines.push(
		opts.flagged
			? 'Start the summary with the flagged entries: what happened and why each was flagged. Then summarise the rest in a short paragraph, and pick the moments worth knowing about.'
			: 'Summarise what happened in a short paragraph, then pick the moments worth knowing about.',
		'Reply with only a JSON object: {"summary":"…","flagged":[{"time":"03:10","camera":"Kitchen","text":"…"}],"highlights":[{"time":"14:03","camera":"Kitchen","text":"…"}]}. "flagged" has one item per flagged entry, in time order, and is empty when none were flagged. At most 8 highlights, in time order; none if nothing stands out.'
	);
	return lines.join('\n');
}

/** Check the model's reply. Throws with a message the model can act on. */
export function parseDigest(text: string): CameraDigestResult {
	const raw = parseModelJson(text) as Record<string, unknown>;
	if (typeof raw !== 'object' || raw === null || typeof raw.summary !== 'string') {
		throw new Error('The reply must be an object with a "summary" string.');
	}
	const highlights = readHighlights(raw.highlights, 'highlights', 'Highlight', 8);
	const flagged = readHighlights(raw.flagged, 'flagged', 'Flagged entry', 50);
	return { summary: raw.summary.trim(), highlights, ...(flagged.length ? { flagged } : {}) };
}

function readHighlights(value: unknown, key: string, label: string, max: number): Highlight[] {
	const list = value ?? [];
	if (!Array.isArray(list)) throw new Error(`"${key}" must be an array.`);
	return list.slice(0, max).map((h, i) => {
		const item = (h ?? {}) as Record<string, unknown>;
		for (const field of ['time', 'camera', 'text']) {
			if (typeof item[field] !== 'string') {
				throw new Error(`${label} ${i + 1}'s "${field}" must be a string.`);
			}
		}
		return { time: item.time as string, camera: item.camera as string, text: item.text as string };
	});
}

/**
 * The entries the prompt can hold, oldest first: the newest that fit in
 * about half the context (four characters to a token), and how many older
 * ones were left out.
 */
function fitEntries(
	events: CameraEvent[],
	contextSize: number
): { events: CameraEvent[]; omitted: number } {
	const budget = Math.max(contextSize, 2048) * 2;
	let used = 0;
	let kept = 0;
	for (const e of events) {
		used += renderCameraLog([e]).length + 1;
		if (used > budget) break;
		kept++;
	}
	return { events: events.slice(0, kept).reverse(), omitted: events.length - kept };
}

interface Gathered {
	cameras: CameraConfig[];
	notes: string[];
	since: number;
	until: number;
	/** Newest first. */
	events: CameraEvent[];
}

/** The Gather stage: the cameras the job may read, and their entries for the period. */
async function gather(ctx: JobRunContext, config: CameraDigestConfig): Promise<Gathered> {
	const { job, runId } = ctx;
	// The same model check the camera tools make on this job's turns.
	if (!cameraDataAllowed(resolveBackendDescriptor(jobBackendOverride(job)))) {
		throw new Error(NOT_LOCAL);
	}
	const { cameras, notes } = resolveDigestCameras(config);
	if (cameras.length === 0) {
		throw new Error(
			[...notes, 'No camera to read: set one to Allow in Settings → Cameras.'].join('\n')
		);
	}
	const until = Date.now();
	const lastRun = config.period === 'since_last_run' ? await lastSucceededAt(job.id, runId) : null;
	const since = periodStart(config.period, lastRun, new Date(until));
	const perCamera = await Promise.all(
		cameras.map((c) =>
			invoke<CameraEvent[]>('camera_events_list', {
				cameraId: c.id,
				since,
				until,
				limit: PER_CAMERA
			})
		)
	);
	perCamera.forEach((events, i) => notes.push(`- ${cameras[i].name}: ${events.length} entries`));
	const events = perCamera.flat().sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
	return { cameras, notes, since, until, events };
}

/** The Summarise stage's model turn, asked once more when its reply doesn't parse. */
async function summarise(
	ctx: JobRunContext,
	config: CameraDigestConfig,
	{ cameras, since, until, events }: Gathered
): Promise<CameraDigestResult> {
	const vision = ctx.visionSupported();
	const { flagged, rest } = splitFlagged(events);
	const fitted = fitEntries(rest, ctx.contextSize());
	const prompt = summaryPrompt({
		flagged: renderCameraLog([...flagged].reverse()),
		cameras,
		since,
		until,
		log: renderCameraLog(fitted.events),
		count: fitted.events.length,
		omitted: fitted.omitted,
		focus: config.focus,
		snapshot: config.include_snapshot && vision
	});
	const turn = {
		systemPrompt: SYSTEM_PROMPT,
		contextSize: ctx.contextSize(),
		maxIterations: MAX_ITERATIONS,
		visionSupported: vision,
		toolAllowlist: digestToolAllowlist(config.include_snapshot, vision),
		turnKind: 'camera_digest.summarise',
		...ctx.buildStreamCallbacks(SUMMARISE)
	};
	let message = prompt;
	for (let attempt = 0; ; attempt++) {
		const { finalText } = await ctx.runJobTurn({ ...turn, userMessage: message });
		try {
			return parseDigest(finalText);
		} catch (e) {
			if (attempt > 0) throw e;
			message = `${prompt}\n\nYour last reply could not be used: ${(e as Error).message} Reply again with only the JSON object.`;
		}
	}
}

/** The digest as lines of text: the summary, flagged entries, then highlights. */
export function digestLines(digest: CameraDigestResult): string[] {
	const item = (h: Highlight) => `- ${h.time} · ${h.camera} — ${h.text}`;
	const lines = [digest.summary];
	if (digest.flagged?.length) lines.push('', 'Flagged:', ...digest.flagged.map(item));
	if (digest.highlights.length) {
		if (digest.flagged?.length) lines.push('', 'Highlights:');
		lines.push(...digest.highlights.map(item));
	}
	return lines;
}

/**
 * Email the digest to the alert addresses, with the pictures of the first
 * flagged entries; why it wasn't sent, or null when it was.
 */
async function emailDigest(digest: CameraDigestResult, gathered: Gathered): Promise<string | null> {
	const flaggedIds = splitFlagged(gathered.events)
		.flagged.sort((a, b) => a.startedAt - b.startedAt)
		.slice(0, MAX_ATTACHMENTS_PER_EMAIL)
		.map((e) => e.id);
	try {
		await sendAlert({
			kind: 'digest',
			lines: [
				`Camera digest for ${gathered.cameras.map((c) => c.name).join(', ')}.`,
				'',
				...digestLines(digest)
			],
			eventIds: flaggedIds
		});
		return null;
	} catch (e) {
		const msg = errMessage(e);
		return msg.startsWith('Email not sent') ? msg : `Email not sent: ${msg}`;
	}
}

export async function runCameraDigestPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId } = ctx;
	const config = parseCameraDigestConfig(job.type_config);
	void markRunStarted(runId, Date.now());

	const start = (step: number) => {
		const startedAt = Date.now();
		ctx.patchStep(step, { status: 'running', startedAt });
		ctx.setCurrentStepIndex(step);
		void markRunStepStarted(runId, step, startedAt, ctx.stepAuthored(step));
	};
	const finish = (
		step: number,
		status: 'succeeded' | 'failed' | 'cancelled',
		output: string | null,
		error: string | null
	) => {
		const finishedAt = Date.now();
		ctx.patchStep(step, { status, output: output ?? '', error, finishedAt });
		void markRunStepFinished(runId, step, status, output, error, finishedAt);
	};

	let step = GATHER;
	try {
		start(GATHER);
		const gathered = await gather(ctx, config);
		finish(GATHER, 'succeeded', gathered.notes.join('\n'), null);

		step = SUMMARISE;
		start(SUMMARISE);
		if (gathered.events.length === 0) {
			await ctx.setResult({ summary: NOTHING_LOGGED, highlights: [] });
			finish(SUMMARISE, 'succeeded', NOTHING_LOGGED, null);
			ctx.finalizeRun('succeeded', null);
			return;
		}
		const digest = await summarise(ctx, config, gathered);
		await ctx.setResult(digest);
		const lines = digestLines(digest);
		if (config.include_snapshot && !ctx.visionSupported()) lines.push('', NO_VISION);
		if (config.email_result) {
			const failed = await emailDigest(digest, gathered);
			if (failed) lines.push('', failed);
		}
		finish(SUMMARISE, 'succeeded', lines.join('\n'), null);
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		finish(step, aborted ? 'cancelled' : 'failed', null, msg);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
	} finally {
		ctx.onSettled();
	}
}
