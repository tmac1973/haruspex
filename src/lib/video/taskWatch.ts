/**
 * When a background video task ends, the conversation that started it gets a
 * follow-up turn saying how it went, so the model can report and check the
 * result without being asked.
 *
 * A notice waits here until its owner can take it: a Chat conversation or a
 * Code session, each of which registers a handler and calls `takeVideoNotices`
 * once it is idle. Deliberately free of store imports, like
 * `#lib/shell/backgroundWatch.ts`, so the stores can import it.
 */
import type { VideoTask } from '#lib/ipc/gen/VideoTask.ts';
import type { RenderCheck } from '#lib/ipc/gen/RenderCheck.ts';
import { formatDuration } from '#lib/video/report.ts';

const pending = new Map<string, string[]>();
const handlers = new Map<string, (owner: string) => void>();

/** The owner string a tool records for its turn. */
export function videoOwner(ctx: { conversationId?: string; codeSessionId?: string }): string {
	if (ctx.codeSessionId) return `code:${ctx.codeSessionId}`;
	if (ctx.conversationId) return `chat:${ctx.conversationId}`;
	return '';
}

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

const OPENING = /^Video (render|upload) (finished|failed|cancelled)/;

/** Whether a user-role message is a notice this module wrote. */
export function isVideoNotice(text: string): boolean {
	return OPENING.test(text);
}

/** The follow-up text for a task that ended. */
export function buildVideoNotice(t: VideoTask): string {
	const what = t.kind === 'upload' ? 'upload' : 'render';
	switch (t.state) {
		case 'done':
			return (
				`Video render finished: ${t.path}. ` +
				(t.check ? describeCheck(t.check) : 'It could not be checked.')
			);
		case 'uploaded':
			return (
				`Video upload finished: ${t.url} (${t.visibility}). YouTube Studio: ${t.studioUrl}. ` +
				(t.problems.length ? t.problems.join(' ') : 'Everything was set.')
			);
		case 'failed':
			return `Video ${what} failed: ${t.message}${t.logTail ? `\n--- melt said ---\n${t.logTail}` : ''}`;
		case 'cancelled':
			return what === 'upload'
				? 'Video upload cancelled. YouTube keeps nothing of it.'
				: 'Video render cancelled. Nothing was saved.';
		default:
			return '';
	}
}

/** A handler for an owner's notices; returns its unregister. */
export function setVideoTaskHandler(owner: string, fn: (owner: string) => void): () => void {
	handlers.set(owner, fn);
	return () => {
		if (handlers.get(owner) === fn) handlers.delete(owner);
	};
}

/** Every chat owner (`chat:…`) is handled by the one Chat store. */
export function setChatVideoTaskHandler(fn: (owner: string) => void): () => void {
	return setVideoTaskHandler('chat:*', fn);
}

/** A task ended: keep its notice for its owner and tell the owner. */
export function noteTaskEnded(t: VideoTask): void {
	const text = buildVideoNotice(t);
	if (!text || !t.owner) return;
	pending.set(t.owner, [...(pending.get(t.owner) ?? []), text]);
	(handlers.get(t.owner) ?? (t.owner.startsWith('chat:') ? handlers.get('chat:*') : undefined))?.(
		t.owner
	);
}

/** The notices waiting for an owner, as one turn's text; empty when none. */
export function takeVideoNotices(owner: string): string {
	const list = pending.get(owner) ?? [];
	pending.delete(owner);
	return list.join('\n\n');
}

export function hasVideoNotices(owner: string): boolean {
	return (pending.get(owner)?.length ?? 0) > 0;
}

export function _resetForTests(): void {
	pending.clear();
	handlers.clear();
}
