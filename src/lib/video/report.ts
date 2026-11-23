/**
 * What the video tools tell the model: an episode's clips and a project's cut,
 * as short lines it can act on.
 */
import { getSettings } from '#lib/stores/settings.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';
import type { Format } from '#lib/ipc/gen/Format.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';
import type { SummaryItem } from '#lib/ipc/gen/SummaryItem.ts';
import type { AudioItem } from '#lib/ipc/gen/AudioItem.ts';
import type { CutResult } from '#lib/ipc/gen/CutResult.ts';
import type { TimelineTranscript } from '#lib/ipc/gen/TimelineTranscript.ts';
import { plural } from '#lib/utils/format.ts';

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
	if (s.videoIntroPath.trim()) lines.push(`Intro (Settings → Video editing): ${s.videoIntroPath}`);
	if (s.videoOutroPath.trim()) lines.push(`Outro (Settings → Video editing): ${s.videoOutroPath}`);
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

/** The most gain loudness evening adds, as `MAX_GAIN` in `loudness.rs`. */
const MAX_GAIN_DB = 20;

/** A clip's gain ranges, as the summary line says them. */
function rangeParts(i: SummaryItem): string[] {
	return (i.gainRanges ?? []).map((r) => {
		const what = r.gainDb <= -60 ? 'muted' : `${r.gainDb > 0 ? '+' : ''}${r.gainDb} dB`;
		return `${what} ${formatTime(r.fromSecs)}–${formatTime(r.toSecs)} of the clip`;
	});
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
	if (i.gainDb != null) {
		const limited = i.limited ? ', peaks limited' : '';
		// The most loudness evening adds (MAX_GAIN in loudness.rs).
		const most = i.gainDb >= MAX_GAIN_DB - 0.05 ? ', the most allowed' : '';
		parts.push(`gain ${i.gainDb > 0 ? '+' : ''}${i.gainDb} dB${most}${limited}`);
	}
	if (i.fit?.mode === 'fill') parts.push('fills the frame');
	if (i.fit?.mode === 'crop') {
		const pct = (n: number) => `${Math.round(n * 100)}%`;
		const f = i.fit;
		parts.push(`cropped to ${pct(f.w)}×${pct(f.h)} at ${pct(f.x)}, ${pct(f.y)}`);
	}
	if (i.speed != null && i.speed !== 1) parts.push(`at ${i.speed}× speed`);
	parts.push(...rangeParts(i));
	if (!i.hasVideo) parts.push('sound only');
	if (!i.hasAudio) parts.push('no sound');
	if (i.effects > 0) parts.push(`${plural(i.effects, 'effect')} added in the editor`);
	return parts.join(' · ');
}

/** `1. A1 · ep010/voice.wav · at 0:03.0 · 0:12.0 long · gain +2 dB`. */
export function audioLine(a: AudioItem): string {
	const parts = [
		`${a.index}. ${a.track} · ${a.path}`,
		`at ${formatTime(a.startSecs)}`,
		`${formatTime(a.durationSecs)} long`,
		`file ${formatTime(a.sourceInSecs)}–${formatTime(a.sourceOutSecs)}`
	];
	if (a.gainDb != null) {
		const limited = a.limited ? ', peaks limited' : '';
		parts.push(`gain ${a.gainDb > 0 ? '+' : ''}${a.gainDb} dB${limited}`);
	}
	if (a.lufs != null) parts.push(`set to ${a.lufs} LUFS`);
	return parts.join(' · ');
}

/** Each project format's editor, as the user knows it. */
export const EDITOR_NAMES: Record<Format, string> = { shotcut: 'Shotcut', kdenlive: 'Kdenlive' };

export function summaryReport(p: ProjectSummary): string {
	const fps = Number.isInteger(p.fps) ? p.fps : p.fps.toFixed(2);
	const lines = [
		`${p.project} · ${p.width}×${p.height} @ ${fps} fps · ${formatDuration(p.totalSecs)} long · ${EDITOR_NAMES[p.editor]} ${p.editorVersion || '?'}`
	];
	if (p.readOnly) lines.push(p.readOnly);
	if (p.items.length === 0) lines.push('The main track (V1/A1) is empty.');
	else lines.push('Main track (V1/A1), in order:');
	for (const i of p.items) lines.push(itemLine(i));
	if (p.audio.length > 0) {
		lines.push("Audio tracks, under the picture (video_cut's audio), in time order:");
		for (const a of p.audio) lines.push(audioLine(a));
	}
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

/** What to do when the project is open in its editor while Haruspex changes it. */
export function editorOpenNote(editor: Format): string {
	const name = EDITOR_NAMES[editor];
	return `If this project is open in ${name}, close it without saving and reopen it, or ${name} will overwrite these changes.`;
}

export function cutReport(r: CutResult): string {
	const lines = [`${r.created ? 'Made' : 'Saved'} ${r.summary.project}.`, summaryReport(r.summary)];
	if (r.notes.length) lines.push(...r.notes);
	lines.push(editorOpenNote(r.summary.editor));
	return lines.join('\n');
}

/** How the clips with no transcript are named: their numbers, with their files when known. */
function untranscribedNote(t: TimelineTranscript, items: SummaryItem[]): string {
	const named = t.untranscribed.map((i) => {
		const path = items.find((x) => x.index === i)?.path;
		return path ? `${i} (${path})` : String(i);
	});
	return named.length === 1
		? `Clip ${named[0]} has no transcript yet.`
		: `Clips ${named.join(', ')} have no transcript yet.`;
}

/**
 * The cut's speech from `from` (s, in the video's time), `[h:mm:ss] text`, as
 * long as it fits in `cap`. `items`, the project's main track, names the clips
 * with no transcript.
 */
export function timelineTranscriptReport(
	t: TimelineTranscript,
	opts: { from?: number; items?: SummaryItem[]; cap?: number } = {}
): string {
	const { from = 0, items = [], cap = 12_000 } = opts;
	const lines = [
		from > 0
			? `The cut's speech from ${formatTime(from)}, in the video's time:`
			: `The cut's speech, in the video's time:`
	];
	let used = 0;
	for (const l of t.lines) {
		if (l.start < from - 0.05) continue;
		const source = l.audio ? ` (audio ${l.index})` : '';
		const line = `[${formatDuration(l.start)}]${source} ${l.text}`;
		if (used + line.length > cap) {
			// Say where the rest starts, so it isn't read as speech that isn't there.
			const at = formatTime(l.start);
			lines.push(
				`… (cut here to fit; the rest starts at ${at}: ask again with transcript_from: "${at}")`
			);
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	if (t.lines.length === 0) lines.push('(nothing transcribed yet: use video_transcribe)');
	if (t.untranscribed.length > 0) lines.push(untranscribedNote(t, items));
	if (t.untranscribedAudio.length > 0) {
		const n = t.untranscribedAudio;
		lines.push(
			`Audio-track item${n.length === 1 ? '' : 's'} ${n.join(', ')} ${n.length === 1 ? 'has' : 'have'} no transcript yet.`
		);
	}
	return lines.join('\n');
}
