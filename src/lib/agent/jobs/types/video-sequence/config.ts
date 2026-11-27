/**
 * The Video sequence job's `type_config`: plain JSON, so a chat's
 * `propose_job` can draft one and nothing in it depends on a run.
 */
import { DEFAULT_REANCHOR } from '#lib/sequence/spec/types.ts';
import { SPEC_FILE } from '#lib/sequence/spec/paths.ts';
import { videoEntries } from '#lib/videogen/entries.ts';

export type SequenceRunMode = 'attended' | 'unattended';
export type SequenceEditor = '' | 'shotcut' | 'kdenlive';
/**
 * How a generated section's first clip starts: `still` opens it on a
 * keyframe from the image backend, `prompt` makes it from its prompt alone
 * (text to video). Later clips of a section start from the last frame of the
 * one before either way, and a section's own start_image always wins.
 */
export type SectionStart = 'still' | 'prompt';

export interface VideoSequenceConfig {
	/** The episode folder, relative to the job's working folder; '' is the folder itself. */
	episode_dir: string;
	/** What the video is, in a line or a paragraph. */
	brief: string;
	run_mode: SequenceRunMode;
	/**
	 * A video model's id in Settings → Video generation; '' is Automatic, the
	 * first that can make the job's clips.
	 */
	video_model_id: string;
	/**
	 * A video model that makes someone speak (Wan2.2 S2V), for speaking
	 * sections: its id, '' for Automatic (the first that can), or `none`.
	 */
	speaking_model_id: string;
	section_start: SectionStart;
	/** Check each seam with a vision model, when the job's model can see. */
	vision_checks: boolean;
	/** What the spec turn writes into `reanchor_every`; the spec's own value wins. */
	reanchor_every: number;
	/** The project's editor; '' is Settings → Video editing → Editor. */
	editor: SequenceEditor;
}

export const MAX_REANCHOR = 30;

export function configDefaults(): VideoSequenceConfig {
	return {
		episode_dir: '',
		brief: '',
		run_mode: 'attended',
		video_model_id: '',
		speaking_model_id: '',
		section_start: 'still',
		vision_checks: true,
		reanchor_every: DEFAULT_REANCHOR,
		editor: ''
	};
}

const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);

/**
 * A model id, or one from a config saved before the video model list: an
 * instance id then, which is the toolchest entry running it, or kept as it is
 * so the job shows it as missing.
 */
function modelId(saved: unknown, oldInstance: unknown): string {
	if (typeof saved === 'string') return saved.trim();
	const instance = text(oldInstance);
	if (!instance) return '';
	const entry = videoEntries().find(
		(e) => e.backend === 'llama-toolchest' && e.model.trim() === instance
	);
	return entry?.id ?? instance;
}

/** `section_start`, or from `image_keyframes` in a config saved before it. */
function sectionStart(o: Record<string, unknown>): SectionStart {
	if (o.section_start === 'still' || o.section_start === 'prompt') return o.section_start;
	return o.image_keyframes === false ? 'prompt' : 'still';
}

/**
 * The config from a job's stored JSON, with defaults for what is missing.
 * Anything but `unattended` reads as attended: a malformed config must never
 * make a run stop asking.
 */
export function parseConfig(typeConfig: string | null): VideoSequenceConfig {
	const d = configDefaults();
	let o: Record<string, unknown> = {};
	try {
		const v = typeConfig ? JSON.parse(typeConfig) : {};
		if (v && typeof v === 'object' && !Array.isArray(v)) o = v;
	} catch {
		// A broken config gives the defaults; validate() catches it on save.
	}
	const reanchor = typeof o.reanchor_every === 'number' ? Math.round(o.reanchor_every) : NaN;
	const editor = o.editor === 'shotcut' || o.editor === 'kdenlive' ? o.editor : '';
	return {
		episode_dir: normalizeEpisodeDir(text(o.episode_dir)),
		brief: text(o.brief),
		run_mode: o.run_mode === 'unattended' ? 'unattended' : 'attended',
		video_model_id: modelId(o.video_model_id, o.video_instance_id),
		speaking_model_id: modelId(o.speaking_model_id, o.speaking_instance_id),
		section_start: sectionStart(o),
		vision_checks: typeof o.vision_checks === 'boolean' ? o.vision_checks : d.vision_checks,
		reanchor_every:
			Number.isFinite(reanchor) && reanchor >= 0 && reanchor <= MAX_REANCHOR
				? reanchor
				: d.reanchor_every,
		editor
	};
}

export function configToJson(c: VideoSequenceConfig): string {
	return JSON.stringify({
		episode_dir: normalizeEpisodeDir(c.episode_dir),
		brief: c.brief.trim(),
		run_mode: c.run_mode,
		video_model_id: c.video_model_id.trim() || undefined,
		speaking_model_id: c.speaking_model_id.trim() || undefined,
		section_start: c.section_start,
		vision_checks: c.vision_checks,
		reanchor_every: c.reanchor_every,
		editor: c.editor || undefined
	});
}

/** `ep1/`, `./ep1` and `ep1` are one folder; forward slashes. */
export function normalizeEpisodeDir(dir: string): string {
	return dir
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/, '')
		.replace(/\/+$/, '');
}

/** A path inside the episode folder, relative to the working folder. */
export function inEpisode(c: Pick<VideoSequenceConfig, 'episode_dir'>, rel: string): string {
	return c.episode_dir ? `${c.episode_dir}/${rel}` : rel;
}

export function specPathFor(c: Pick<VideoSequenceConfig, 'episode_dir'>): string {
	return inEpisode(c, SPEC_FILE);
}

/** Why the config can't be saved, or null. */
export function configProblem(c: VideoSequenceConfig, workingDir: string): string | null {
	if (!workingDir.trim()) {
		return 'A Video sequence job needs a working folder: the series or episode folder the video goes in.';
	}
	const dir = normalizeEpisodeDir(c.episode_dir);
	if (dir.startsWith('/') || /^[a-z]:/i.test(dir) || dir.split('/').includes('..')) {
		return 'The episode folder must be inside the working folder.';
	}
	if (!c.brief.trim()) return 'Describe the video in the brief.';
	if (
		!Number.isInteger(c.reanchor_every) ||
		c.reanchor_every < 0 ||
		c.reanchor_every > MAX_REANCHOR
	) {
		return `Re-anchor every must be a whole number from 0 (off) to ${MAX_REANCHOR}.`;
	}
	return null;
}
