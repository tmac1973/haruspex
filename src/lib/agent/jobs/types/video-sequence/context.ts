/**
 * What the spec turn is told, and what the validator checks against: the
 * clips and pictures in the episode folder, the video instance's limits and
 * what it can do, and which backends are set up.
 */
import { invoke } from '@tauri-apps/api/core';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';
import { fitClip } from '#lib/videogen/fit.ts';
import {
	capabilityWords,
	othersCan,
	pickSpeakingModel,
	pickVideoModel,
	type PickedModel
} from '#lib/agent/jobs/types/video-sequence/pick.ts';
import { projectFormat } from '#lib/sequence/spec/format.ts';
import { speakingFormat } from '#lib/sequence/spec/speaking.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { resolveImageBackend } from '#lib/image/backend.ts';
import { resolveMusicBackend } from '#lib/music/backend.ts';
import type { ValidateContext } from '#lib/sequence/spec/validate.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';

const IMAGE = /\.(png|jpe?g|webp)$/i;

export interface EpisodeClip {
	/** Relative to the episode folder. */
	path: string;
	secs: number;
	width: number | null;
	height: number | null;
	sound: boolean;
}

export interface SpecContext {
	video: PickedModel;
	/** The model speaking sections use, when there is one. */
	speaking: PickedModel | null;
	/** The job leaves the video model to Automatic, so a clip it can't make may go to another. */
	automatic: boolean;
	validate: ValidateContext;
	clips: EpisodeClip[];
	images: string[];
	/** The whole context as the model reads it. */
	text: string;
}

interface Listing {
	entries: { name: string; is_dir: boolean }[];
}

/** `path` without the episode folder in front, or null when it isn't inside. */
function withinEpisode(episodeDir: string, path: string): string | null {
	if (!episodeDir) return path;
	const prefix = `${episodeDir}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Pictures in the episode folder and one level of subfolders. */
async function listImages(workdir: string, episodeDir: string): Promise<string[]> {
	const list = async (rel: string) => {
		try {
			return (await invoke<Listing>('fs_list_dir', { workdir, relPath: rel || '.' })).entries;
		} catch {
			return [];
		}
	};
	const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
	const out: string[] = [];
	for (const e of await list(episodeDir)) {
		if (e.name.startsWith('.')) continue;
		if (!e.is_dir) {
			if (IMAGE.test(e.name)) out.push(e.name);
			continue;
		}
		if (e.name === 'renders') continue;
		for (const inner of await list(join(episodeDir, e.name))) {
			if (!inner.is_dir && IMAGE.test(inner.name)) out.push(`${e.name}/${inner.name}`);
		}
	}
	return out.sort();
}

async function listClips(workdir: string, episodeDir: string): Promise<EpisodeClip[]> {
	const probe = await invoke<EpisodeProbe>('video_probe_folder', {
		workingDir: workdir,
		episode: episodeDir,
		overrides: videoOverrides()
	});
	return probe.clips.flatMap((c) => {
		const path = withinEpisode(episodeDir, c.path);
		if (path === null) return [];
		return [
			{
				path,
				secs: c.durationSecs,
				width: c.video?.width ?? null,
				height: c.video?.height ?? null,
				sound: c.audio.length > 0
			}
		];
	});
}

/** The video model as the spec turn needs to know it. */
function instanceText(model: PickedModel): string {
	const { limits, frameStep } = model.caps;
	const longest = fitClip(limits, model.entry.name, { seconds: 1e6, portrait: false }, frameStep);
	const can = (c: string) => capabilityWords(model.caps).includes(c);
	const lines = [
		`Video model: ${model.entry.name}, ${longest.width}×${longest.height} at ${longest.fps} fps.`,
		`Its longest clip is ${(longest.frames / longest.fps).toFixed(1)} s; longer sections are made of several clips, each continuing from the last.`,
		can('start_image') ? 'It can start a clip from a picture.' : 'It cannot start from a picture.',
		can('end_image')
			? 'It can end a clip on a picture, so transitions between sections work.'
			: 'It cannot end a clip on a picture: use cuts or crossfades, not transitions.',
		can('text') ? 'It can make a clip from a prompt alone.' : 'It needs a picture to start from.'
	];
	return lines.join('\n');
}

/** What the model is told about speaking sections. */
function speakingText(speaking: PickedModel | null): string {
	if (!speaking) return 'There is no speaking model: no speaking sections.';
	const f = speakingFormat(speaking.caps.limits);
	return `Speaking sections (a person in a portrait saying lines) use ${speaking.entry.name}: one clip per stretch of speech, up to ${f.secs.toFixed(1)} s each at ${f.fps} fps. Give each line a short id.`;
}

/** Everything the spec turn and the validator need, for `cfg` in `workdir`. */
export async function buildSpecContext(
	workdir: string,
	cfg: VideoSequenceConfig,
	signal?: AbortSignal
): Promise<SpecContext> {
	const video = await pickVideoModel(cfg, signal);
	const speaking = await pickSpeakingModel(cfg, signal);
	const automatic = !cfg.video_model_id;
	const limits = video.caps.limits;
	const [clips, images] = await Promise.all([
		listClips(workdir, cfg.episode_dir),
		listImages(workdir, cfg.episode_dir)
	]);
	const imageBackend = cfg.image_keyframes && resolveImageBackend().kind !== 'none';
	const musicBackend = resolveMusicBackend().kind !== 'none';
	const validate: ValidateContext = {
		instance: video.entry.name,
		limits,
		capabilities: capabilityWords(video.caps),
		...(automatic ? { othersCan: othersCan(video) } : {}),
		imageBackend,
		musicBackend,
		files: new Set([...clips.map((c) => c.path), ...images]),
		...(speaking
			? {
					speaking: {
						instance: speaking.entry.name,
						limits: speaking.caps.limits,
						capabilities: capabilityWords(speaking.caps)
					},
					projectFps: projectFormat(
						fitClip(limits, video.entry.name, { portrait: false }, video.caps.frameStep),
						{},
						getSettings().videoPreset
					).fps
				}
			: {})
	};
	const clipLines = clips.map((c) => {
		const size = c.width && c.height ? `, ${c.width}×${c.height}` : '';
		return `- ${c.path}: ${c.secs.toFixed(1)} s${size}${c.sound ? '' : ', no sound'}`;
	});
	const text = [
		instanceText(video),
		imageBackend
			? 'Each generated section opens on a keyframe still the image backend makes, unless it has a start_image.'
			: 'There are no keyframes: a generated section opens from its start_image, or from its prompt alone.',
		musicBackend ? 'Music generation is set up.' : 'There is no music generation: no music beds.',
		speakingText(speaking),
		`Re-anchor every ${cfg.reanchor_every} clips unless the brief says otherwise.`,
		clipLines.length
			? `Clips in the episode folder, which can be existing sections:\n${clipLines.join('\n')}`
			: 'There are no clips in the episode folder.',
		images.length
			? `Pictures in the episode folder, which can be start images:\n${images.map((p) => `- ${p}`).join('\n')}`
			: 'There are no pictures in the episode folder.'
	].join('\n\n');
	return { video, speaking, automatic, validate, clips, images, text };
}
