/**
 * What the video tools tell the model: an episode's clips and a project's cut,
 * as short lines it can act on.
 */
import { getSettings } from '#lib/stores/settings.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';
import type { SummaryItem } from '#lib/ipc/gen/SummaryItem.ts';
import type { CutResult } from '#lib/ipc/gen/CutResult.ts';
import type { TimelineTranscript } from '#lib/ipc/gen/TimelineTranscript.ts';

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

/** `1:02.5`: minutes, seconds and a tenth, precise enough to trim by. */
export function formatTime(secs: number): string {
	const tenths = Math.max(0, Math.round(secs * 10));
	const m = Math.floor(tenths / 600);
	const s = (tenths % 600) / 10;
	return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** `2. ep010/raw/a.mp4 · at 0:05.0 · 2:00.0 long · clip 0:10.0–2:10.0`. */
export function itemLine(i: SummaryItem): string {
	const parts = [
		`${i.index}. ${i.path}`,
		`at ${formatTime(i.startSecs)}`,
		`${formatTime(i.durationSecs)} long`,
		`clip ${formatTime(i.sourceInSecs)}–${formatTime(i.sourceOutSecs)}`
	];
	if (i.crossfadeInSecs != null) parts.push(`crossfades in over ${i.crossfadeInSecs.toFixed(1)} s`);
	if (i.gainDb != null) parts.push(`gain ${i.gainDb > 0 ? '+' : ''}${i.gainDb} dB`);
	if (!i.hasVideo) parts.push('sound only');
	if (!i.hasAudio) parts.push('no sound');
	if (i.effects > 0) parts.push(`${plural(i.effects, 'effect')} added in Kdenlive`);
	return parts.join(' · ');
}

export function summaryReport(p: ProjectSummary): string {
	const fps = Number.isInteger(p.fps) ? p.fps : p.fps.toFixed(2);
	const lines = [
		`${p.project} · ${p.width}×${p.height} @ ${fps} fps · ${formatDuration(p.totalSecs)} long · Kdenlive ${p.kdenliveVersion || '?'}`
	];
	if (p.readOnly) lines.push(p.readOnly);
	if (p.items.length === 0) lines.push('The main track (V1/A1) is empty.');
	else lines.push('Main track (V1/A1), in order:');
	for (const i of p.items) lines.push(itemLine(i));
	if (p.otherClips.length > 0) {
		lines.push('On other tracks (not edited by these tools):');
		for (const c of p.otherClips) {
			lines.push(`- ${c.track}: ${c.path} ${formatTime(c.startSecs)}–${formatTime(c.endSecs)}`);
		}
	}
	const extras: string[] = [];
	if (p.mixes > 0) extras.push(`${plural(p.mixes, 'crossfade')} on the main track`);
	if (p.guides > 0) extras.push(plural(p.guides, 'guide'));
	if (extras.length) lines.push(extras.join(' · '));
	return lines.join('\n');
}

const KDENLIVE_OPEN =
	'If this project is open in Kdenlive, close it without saving and reopen it, or Kdenlive will overwrite these changes.';

export function cutReport(r: CutResult): string {
	const lines = [`${r.created ? 'Made' : 'Saved'} ${r.summary.project}.`, summaryReport(r.summary)];
	if (r.notes.length) lines.push(...r.notes);
	lines.push(KDENLIVE_OPEN);
	return lines.join('\n');
}

/** The cut's speech, `[h:mm:ss] text`, as long as it fits in `cap`. */
export function timelineTranscriptReport(t: TimelineTranscript, cap = 12_000): string {
	const lines = [`The cut's speech, in the video's time:`];
	let used = 0;
	for (const l of t.lines) {
		const line = `[${formatDuration(l.start)}] ${l.text}`;
		if (used + line.length > cap) {
			lines.push('… (cut here to fit)');
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	if (t.lines.length === 0) lines.push('(nothing transcribed yet: use video_transcribe)');
	if (t.untranscribed.length > 0) {
		lines.push(`Clips ${t.untranscribed.join(', ')} have no transcript yet.`);
	}
	return lines.join('\n');
}
