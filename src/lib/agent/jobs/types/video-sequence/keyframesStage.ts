/**
 * The Keyframes stage in a run: `makeKeyframes` with the image backend and
 * the episode's files behind it, the progress file kept up to date, and, in
 * Attended runs, a stop to look at the stills before any video is made. A
 * still is minutes; a section of video is hours.
 */
import { invoke } from '@tauri-apps/api/core';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { askUserQuestion } from '#lib/stores/userQuestion.svelte.ts';
import { registerLocalImage } from '#lib/images/resolve.svelte.ts';
import type { ViewerImage } from '#lib/stores/imageViewer.svelte.ts';
import { capableEntries, needOf, routedImageBackend } from '#lib/image/route.ts';
import { resolveImageBackend } from '#lib/image/backend.ts';
import { videoSettings } from '#lib/video/args.ts';
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import { mergeProgress, stillKeys } from '#lib/sequence/spec/progress.ts';
import type { StepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import { KEYFRAMES } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import {
	readProgress,
	writeProgress,
	type RunFiles
} from '#lib/agent/jobs/types/video-sequence/files.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
import {
	makeKeyframes,
	stillsSummary,
	type KeyframeDeps,
	type Still
} from '#lib/agent/jobs/types/video-sequence/keyframes.ts';

/** How many sections the checkpoint lets the user remake before it stops offering. */
const MAX_REDOS = 5;

/** Whether some image model can edit a picture with a prompt. */
function canEdit(): boolean {
	const probe = needOf({
		prompt: '',
		width: 1,
		height: 1,
		seed: null,
		edit: { images: [{ name: 'x.png', hash: '' }] }
	});
	return capableEntries(probe).length > 0;
}

function depsFor(
	ctx: JobRunContext,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	draws: boolean,
	keyframes: boolean
): KeyframeDeps {
	const backend = routedImageBackend();
	return {
		draws,
		keyframes: draws && keyframes,
		canEdit: draws && canEdit(),
		generate: (req) => backend.generate(req, { signal: ctx.abort.signal }),
		fit: async (bytes, width, height) =>
			new Uint8Array(
				await invoke<number[]>('image_fit_cover', { bytes: Array.from(bytes), width, height })
			),
		write: (rel, bytes) => files.writeBytes(rel, bytes),
		read: (rel) => files.readBytes(rel),
		exists: (rel) => files.exists(rel),
		firstFrame: async (clip, atSecs, out) => {
			await invoke('video_still_extract', {
				workingDir: ctx.job.working_dir,
				episode: cfg.episode_dir,
				request: {
					path: files.path(clip),
					videoHash: null,
					which: 'time',
					atSecs,
					out: files.path(out)
				},
				settings: videoSettings()
			});
		},
		signal: ctx.abort.signal
	};
}

/** Each still as a picture the question and the viewer can show, at the video's size. */
async function pictures(
	stills: Still[],
	files: RunFiles,
	size: { width: number; height: number }
): Promise<ViewerImage[]> {
	const out: ViewerImage[] = [];
	for (const s of stills) {
		const bytes = await files.readBytes(s.file);
		if (!bytes) continue;
		const hash = await invoke<string>('image_store_bytes', {
			bytes: Array.from(bytes),
			mime: 'image/png',
			...size
		});
		const url = registerLocalImage(hash, { mime: 'image/png', ...size });
		const label = s.n ? `${s.section}, clip ${s.n}` : s.section;
		if (url) out.push({ src: url, alt: label });
	}
	return out;
}

/** The pictures as markdown, for the run view. */
function picturesMarkdown(pics: ViewerImage[]): string {
	return pics.map((p) => `![${p.alt}](${p.src})`).join('\n\n');
}

/** Make the run's stills; returns them for the Generate stage. */
export async function keyframesStage(
	ctx: JobRunContext,
	steps: StepMarkers,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	/** `draws`: generated sections open on stills (portraits are drawn either way). */
	run: { spec: SequenceSpec; plan: ClipPlan; draws: boolean; attended: boolean }
): Promise<Still[]> {
	steps.start(KEYFRAMES);
	steps.abortIfCancelled();
	const progress = mergeProgress(await readProgress(files), run.spec, run.plan);
	const keys = stillKeys(run.spec, run.plan);
	const backend = resolveImageBackend().kind !== 'none';
	const deps = depsFor(ctx, cfg, files, backend, run.draws);
	const make = async (redo?: { section: string; note: string }) => {
		const stills = await makeKeyframes(
			{ spec: run.spec, plan: run.plan, keys, done: progress.keyframes, redo },
			deps
		);
		await writeProgress(files, progress);
		return stills;
	};
	let stills = await make();
	const shown = stills.filter((s) => s.how !== 'reused');
	if (run.attended && shown.some((s) => s.how !== 'user')) {
		stills = await checkpoint(ctx, files, run.spec, stills, make, {
			width: run.plan.width,
			height: run.plan.height
		});
	}
	const size = { width: run.plan.width, height: run.plan.height };
	const pics = await pictures(
		stills.filter((s) => s.how !== 'reused'),
		files,
		size
	);
	steps.succeed(
		KEYFRAMES,
		[stillsSummary(stills), picturesMarkdown(pics)].filter(Boolean).join('\n\n')
	);
	return stills;
}

async function checkpoint(
	ctx: JobRunContext,
	files: RunFiles,
	spec: SequenceSpec,
	first: Still[],
	make: (redo: { section: string; note: string }) => Promise<Still[]>,
	size: { width: number; height: number }
): Promise<Still[]> {
	let stills = first;
	const remakeable = spec.sections.filter((s) => s.kind === 'generated' && !s.start_image);
	for (let round = 0; ; round++) {
		const more = round < MAX_REDOS && remakeable.length > 0;
		const answer = await askUserQuestion(
			{
				runId: ctx.runId,
				question: 'Every clip starts from these stills. Approve them?',
				// A list, not markdown pictures in the body: a long sequence has
				// dozens of stills, and full-width pictures would bury the options.
				images: await pictures(
					stills.filter((s) => s.how !== 'reused'),
					files,
					size
				),
				options: [
					{ label: 'Approve', description: 'Make the video from them.', recommended: true },
					...(more
						? [{ label: 'Redo one', description: 'Pick a section next, and say what to change.' }]
						: []),
					{ label: 'Stop', description: 'End the run.' }
				]
			},
			ctx.abort.signal
		);
		const choice = answer.kind === 'selected' ? answer.labels[0] : 'Redo one';
		if (choice === 'Approve') return stills;
		if (choice !== 'Redo one' || !more) throw new DOMException('Aborted', 'AbortError');
		const firstNote = answer.kind === 'freeText' ? answer.text : (answer.note ?? '');
		const which = await askUserQuestion(
			{
				runId: ctx.runId,
				question: 'Which section’s still should be made again?',
				body: 'Add what to change in the box, if anything.',
				options: remakeable.map((s) => ({ label: s.id, description: '' }))
			},
			ctx.abort.signal
		);
		const section =
			which.kind === 'selected'
				? which.labels[0]
				: remakeable.find((s) => which.text.includes(s.id))?.id;
		if (!section) continue;
		const note = [firstNote, which.kind === 'selected' ? (which.note ?? '') : which.text]
			.map((n) => n.trim())
			.filter((n) => n && n !== section)
			.join(' ');
		stills = await make({ section, note });
	}
}
