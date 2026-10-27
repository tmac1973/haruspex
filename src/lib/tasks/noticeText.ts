/**
 * What an owner is told when its background task ends: the user-role
 * message its notice turn starts with, so the model can report and check
 * the result without being asked.
 */
import type { RenderCheck } from '#lib/ipc/gen/RenderCheck.ts';
import { formatDuration } from '#lib/video/report.ts';
import { renderResult, uploadResult, type BackgroundTask } from '#lib/tasks/types.ts';

function megabytes(bytes: number): string {
	return bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GB`
		: `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function describeCheck(c: RenderCheck): string {
	const parts = [formatDuration(c.durationSecs), megabytes(c.sizeBytes)];
	if (c.width) parts.push(`${c.width}×${c.height}`);
	if (c.loudness) parts.push(`${c.loudness.lufs.toFixed(1)} LUFS`);
	const problems = c.problems.length ? `Problems: ${c.problems.join(' ')}` : 'No problems.';
	return `${parts.join(', ')}. ${problems}`;
}

const OPENING = /^(Video (render|upload)|Background task ".*") (finished|failed|cancelled)/;

/** Whether a user-role message is a notice this module wrote. */
export function isTaskNotice(text: string): boolean {
	return OPENING.test(text);
}

function videoNotice(t: BackgroundTask): string {
	const what = t.kind === 'youtube_upload' ? 'upload' : 'render';
	const render = renderResult(t);
	const upload = uploadResult(t);
	if (render) {
		return (
			`Video render finished: ${render.path}. ` +
			(render.check ? describeCheck(render.check) : 'It could not be checked.')
		);
	}
	if (upload) {
		return (
			`Video upload finished: ${upload.url} (${upload.visibility}). YouTube Studio: ${upload.studioUrl}. ` +
			(upload.problems.length ? upload.problems.join(' ') : 'Everything was set.')
		);
	}
	if (t.state === 'failed') {
		return `Video ${what} failed: ${t.error ?? 'it stopped.'}${t.logTail ? `\n--- melt said ---\n${t.logTail}` : ''}`;
	}
	if (t.state === 'cancelled') {
		return what === 'upload'
			? 'Video upload cancelled. YouTube keeps nothing of it.'
			: 'Video render cancelled. Nothing was saved.';
	}
	return '';
}

/** The notice for an ended task; empty for one that hasn't ended. */
export function noticeFor(t: BackgroundTask): { text: string; images: string[] } {
	if (t.kind === 'video_render' || t.kind === 'youtube_upload') {
		return { text: videoNotice(t), images: [] };
	}
	// The generation kinds say more once they run (plan phases 06–08).
	const name = `Background task "${t.label}"`;
	const text =
		t.state === 'done'
			? `${name} finished.`
			: t.state === 'failed'
				? `${name} failed: ${t.error ?? 'it stopped.'}`
				: t.state === 'cancelled'
					? `${name} cancelled.`
					: '';
	return { text, images: [] };
}

/** Several notices as one turn's message, blank lines between. */
export function joinNotices(tasks: BackgroundTask[]): { text: string; images: string[] } {
	const parts = tasks.map(noticeFor).filter((n) => n.text);
	return {
		text: parts.map((n) => n.text).join('\n\n'),
		images: parts.flatMap((n) => n.images)
	};
}
