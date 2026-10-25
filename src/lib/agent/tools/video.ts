/**
 * The `video_*` tools: reading an episode's clips and (in later phases)
 * cutting, rendering and uploading them.
 *
 * Offered in Chat and the Code tab only, with someone there, a working folder,
 * and ffmpeg, ffprobe and melt found (`#lib/video/binaries.ts`). The working
 * folder is the boundary: usually a series folder with one subfolder per
 * episode, so `episode` names a subfolder, or is empty when the working
 * folder is the episode itself.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';

/** `12:03`, or `1:02:03` past an hour. */
export function formatDuration(secs: number): string {
	const total = Math.max(0, Math.round(secs));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
	return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function formatFps(num: number, den: number): string {
	if (!num || !den) return '?';
	const fps = num / den;
	return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

/** One line per clip: `ep010/raw/obs.mp4 · 32:23 · 1920×1080 @ 60 · h264 · aac 2ch`. */
export function clipLine(c: ClipInfo): string {
	const parts = [c.path, formatDuration(c.durationSecs)];
	if (c.video) {
		const turned = Math.abs(c.video.rotation) === 90 || Math.abs(c.video.rotation) === 270;
		const size = `${c.video.width}×${c.video.height}`;
		parts.push(`${size} @ ${formatFps(c.video.fpsNum, c.video.fpsDen)}`);
		parts.push(c.video.codec);
		if (turned) parts.push(`rotated ${c.video.rotation}°`);
	} else {
		parts.push('sound only');
	}
	if (c.audio.length === 0) parts.push('no sound');
	else {
		const a = c.audio[0];
		parts.push(`${a.codec} ${a.channels}ch`);
		if (c.audio.length > 1) parts.push(`${c.audio.length} audio tracks`);
	}
	return parts.join(' · ');
}

/** What differs between the clips, which decides how a render treats them. */
export function mixNotes(clips: ClipInfo[]): string[] {
	const video = clips.flatMap((c) => (c.video ? [c.video] : []));
	const notes: string[] = [];
	const sizes = new Set(video.map((v) => `${v.width}×${v.height}`));
	const rates = new Set(video.map((v) => formatFps(v.fpsNum, v.fpsDen)));
	const codecs = new Set(video.map((v) => v.codec));
	if (sizes.size > 1 || rates.size > 1 || codecs.size > 1) {
		notes.push(
			'Mixed sources (different size, frame rate or codec): a render scales them to the project format.'
		);
	}
	if (clips.some((c) => c.video && c.audio.length === 0)) {
		notes.push('Some clips have no sound.');
	}
	return notes;
}

export function probeReport(episode: string, probe: EpisodeProbe): string {
	const s = getSettings();
	const where = episode.trim() || 'the working folder';
	const lines: string[] = [];
	if (probe.clips.length === 0) {
		lines.push(`No video or audio files in ${where}.`);
	} else {
		lines.push(`${probe.clips.length} clips in ${where}:`);
		for (const c of probe.clips) lines.push(`- ${clipLine(c)}`);
		const total = probe.clips.reduce((n, c) => n + c.durationSecs, 0);
		lines.push(`Total: ${formatDuration(total)}.`);
		lines.push(...mixNotes(probe.clips));
	}
	if (probe.unreadable.length > 0) {
		lines.push('Could not read:', ...probe.unreadable.map((u) => `- ${u}`));
	}
	if (s.videoIntroPath.trim()) lines.push(`Intro (Settings → Video): ${s.videoIntroPath}`);
	if (s.videoOutroPath.trim()) lines.push(`Outro (Settings → Video): ${s.videoOutroPath}`);
	const candidates = probe.introCandidates.filter((p) => !probe.clips.some((c) => c.path === p));
	if (candidates.length > 0) {
		lines.push(`Possible intro/outro files: ${candidates.join(', ')}`);
	}
	return lines.join('\n');
}

function episodeArg(args: Record<string, unknown>): string {
	return typeof args.episode === 'string' ? args.episode : '';
}

async function probe(args: Record<string, unknown>, ctx: ToolContext) {
	const episode = episodeArg(args);
	try {
		const result = await invoke<EpisodeProbe>('video_probe_folder', {
			workingDir: ctx.workingDir,
			episode,
			overrides: videoOverrides()
		});
		return toolResult(probeReport(episode, result));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

const EPISODE_PARAM = {
	type: 'string',
	description:
		'The episode folder, relative to the working folder (e.g. "ep012"). Empty when the working folder is the episode.'
};

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_probe',
			description:
				"List an episode's video and audio clips with length, size, frame rate and codecs. Looks in the folder and one level of subfolders.",
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM }
			}
		}
	},
	displayLabel: (args) => `Looking at clips in ${episodeArg(args) || 'the folder'}`,
	execute: probe
});
