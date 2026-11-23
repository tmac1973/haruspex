/**
 * Vision checks on seams and drift: with a model that can see, each clip is
 * put on one contact sheet beside the picture it started from and its
 * section's keyframe, and the model answers two questions through a forced
 * `submit_clip_check` call. Generate makes a failing clip once more (see
 * `makeChecked`); the Check stage lists what still failed.
 */
import { invoke } from '@tauri-apps/api/core';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { ContactSheet } from '#lib/ipc/gen/ContactSheet.ts';
import type { SheetImage } from '#lib/ipc/gen/SheetImage.ts';
import { videoSettings } from '#lib/video/args.ts';
import type { ClipPlan, GenerateItem } from '#lib/sequence/spec/plan.ts';
import type { ClipProgress } from '#lib/sequence/spec/progress.ts';
import {
	SUBMIT_CLIP_CHECK_TOOL,
	parseClipCheck,
	type ClipCheck
} from '#lib/agent/jobs/types/video-sequence/tools.ts';
import { checkPrompt } from '#lib/agent/jobs/types/video-sequence/prompts.ts';
import type { RunFiles } from '#lib/agent/jobs/types/video-sequence/files.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
import type { GenerateDeps } from '#lib/agent/jobs/types/video-sequence/generate.ts';

/** Moments of a clip to look at: its first, middle and last frames. */
export function checkTimes(frames: number, fps: number): [number, number, number] {
	const secs = frames / fps;
	return [0, secs / 2, Math.max(0, secs - 2 / fps)];
}

/** The check, for a run whose model can see; undefined when checks are off. */
export function clipChecker(
	ctx: JobRunContext,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	fps: number
): GenerateDeps['check'] {
	if (!cfg.vision_checks || !ctx.visionSupported()) return undefined;
	return async (item, clip, given) => {
		// A speaking window doesn't start on its portrait (S2V takes it as the
		// person, not a frame), so it is checked against it as the section's look only.
		const against = item.audio ? { start: null, keyframe: given.start ?? given.keyframe } : given;
		const images: SheetImage[] = [];
		if (against.start) images.push({ path: files.path(against.start), label: 'start' });
		if (against.keyframe) images.push({ path: files.path(against.keyframe), label: 'keyframe' });
		const sheet = await invoke<ContactSheet>('video_frames', {
			workingDir: ctx.job.working_dir,
			episode: cfg.episode_dir,
			request: {
				path: files.path(clip),
				times: checkTimes(item.frames, item.fps ?? fps),
				everySecs: null,
				timelineTimes: null,
				project: null,
				images
			},
			settings: videoSettings()
		});
		return judge(ctx, sheet, item, against);
	};
}

async function judge(
	ctx: JobRunContext,
	sheet: ContactSheet,
	item: GenerateItem,
	against: { start: string | null; keyframe: string | null }
): Promise<ClipCheck | null> {
	const n = (label: string) => sheet.tiles.find((t) => t.label === label)?.n ?? null;
	const frames = sheet.tiles.filter((t) => !t.label).map((t) => t.n);
	if (frames.length < 3) return null;
	let verdict: ClipCheck | null = null;
	await ctx.runJobTurn({
		turnKind: 'sequence.check',
		userMessage: checkPrompt({
			prompt: item.prompt,
			start: against.start ? n('start') : null,
			keyframe: against.keyframe ? n('keyframe') : null,
			frames: [frames[0], frames[1], frames[2]]
		}),
		history: [
			{ role: 'user', content: [{ type: 'image_url', image_url: { url: sheet.dataUrl } }] }
		],
		contextSize: ctx.contextSize(),
		visionSupported: true,
		toolAllowlist: [SUBMIT_CLIP_CHECK_TOOL],
		forceFinalTool: SUBMIT_CLIP_CHECK_TOOL,
		maxIterations: 1,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_CLIP_CHECK_TOOL) verdict = parseClipCheck(call.arguments);
		}
	});
	return verdict;
}

/** The clips whose check still failed, in plan order. */
export function flaggedClips(
	plan: ClipPlan,
	clips: Record<string, ClipProgress>
): { id: string; problem: string }[] {
	return plan.items.flatMap((i) => {
		const check = clips[i.id]?.check;
		return check && !check.ok ? [{ id: i.id, problem: check.problem ?? 'It does not match.' }] : [];
	});
}

/**
 * The clips to make again with `ids`: each, and every clip that continues
 * from it, since a new clip ends on a different frame.
 */
export function withFollowers(plan: ClipPlan, ids: string[]): string[] {
	const out = new Set(ids);
	// Until nothing more is added: a transition comes before the clip it ends on.
	for (let grew = true; grew;) {
		grew = false;
		for (const item of plan.items) {
			if (item.kind !== 'generate' || out.has(item.id)) continue;
			const from = item.start.kind === 'lastFrameOf' ? item.start.id : null;
			const to = item.end?.kind === 'firstFrameOf' ? item.end.id : null;
			if ((from && out.has(from)) || (to && out.has(to))) {
				out.add(item.id);
				grew = true;
			}
		}
	}
	return plan.items.map((i) => i.id).filter((id) => out.has(id));
}

/** One line per flagged clip, for the Check step and the report. */
export function flaggedSummary(flagged: { id: string; problem: string }[]): string {
	if (flagged.length === 0) return 'Every clip passed its check.';
	return [
		`${flagged.length} clip${flagged.length === 1 ? '' : 's'} failed the check twice and ${flagged.length === 1 ? 'was' : 'were'} kept:`,
		...flagged.map((f) => `- ${f.id}: ${f.problem}`)
	].join('\n');
}
