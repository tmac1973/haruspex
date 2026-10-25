/**
 * The request fields every ACE-Step server takes for a task on a song:
 * ace-server's `/synth` and llama-toolchest's music jobs name them alike.
 * Shared by both backends, which add their own fields around them.
 */

import {
	MUSIC_TASKS,
	type MusicInput,
	type MusicRequest,
	type MusicTask
} from '#lib/music/types.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';

/** The task's fields; none for `text2music`, which is the default. */
export function taskFields(req: MusicRequest): Record<string, unknown> {
	const task = req.task ?? 'text2music';
	if (task === 'text2music') return {};
	const out: Record<string, unknown> = { task_type: task };
	if (req.tracks?.length) out.track = req.tracks.join(' | ');
	if (task === 'cover' && req.coverStrength !== undefined) {
		out.audio_cover_strength = req.coverStrength;
	}
	if (task === 'repaint' || task === 'lego') {
		if (req.repaintStart !== undefined) out.repainting_start = req.repaintStart;
		if (req.repaintEnd !== undefined) out.repainting_end = req.repaintEnd;
	}
	return out;
}

/** True for a task that works on a source song. */
export function onSource(req: MusicRequest): boolean {
	return (req.task ?? 'text2music') !== 'text2music';
}

function upload(field: string, input: MusicInput): UploadFile {
	return {
		field,
		filename: input.name,
		hash: 'hash' in input ? input.hash : null,
		bytes: 'bytes' in input ? input.bytes : null
	};
}

/** The songs to send, as the parts both servers read: `audio` and `ref_audio`. */
export function uploadsOf(req: MusicRequest): UploadFile[] {
	const out: UploadFile[] = [];
	if (req.source) out.push(upload('audio', req.source));
	if (req.reference) out.push(upload('ref_audio', req.reference));
	return out;
}

/** The tasks a server listed, in our order; `text2music` alone when it listed none. */
export function knownTasks(listed: string[]): MusicTask[] {
	const tasks = MUSIC_TASKS.filter((t) => listed.includes(t));
	return tasks.length ? tasks : ['text2music'];
}
