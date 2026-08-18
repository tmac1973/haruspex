/**
 * What the host can see of what their guests are doing.
 *
 * Deliberately not the chat store, and deliberately not a live mirror of a
 * conversation into the chat tab: the chat store is singleton-shaped (one
 * active conversation, one streaming buffer) and making it per-conversation to
 * watch a guest type would be a rewrite in service of a status panel.
 *
 * This is the cheap version of the same thing — the driver already holds every
 * delta on its way to the guest, so it writes them here too. Anyone who
 * actually wants to read a thread opens it in the sidebar, where it is a normal
 * conversation.
 */

export interface RemoteActivity {
	sessionId: string;
	/** What the guest calls themselves, or null if they skipped the question. */
	label: string | null;
	/** Their current or most recent prompt. */
	prompt: string;
	/** The answer as it is being written. */
	answer: string;
	state: 'waiting' | 'answering' | 'done' | 'failed';
	updatedAt: number;
}

/**
 * Bounded so a long answer does not grow this without limit — the panel shows a
 * few lines, not a transcript.
 */
const MAX_ANSWER_CHARS = 2000;

let activity = $state<RemoteActivity[]>([]);

export function getRemoteActivity(): RemoteActivity[] {
	return activity;
}

export function getActiveRemoteCount(): number {
	return activity.filter((a) => a.state === 'waiting' || a.state === 'answering').length;
}

export function notePrompt(sessionId: string, label: string | null, prompt: string): void {
	const existing = activity.find((a) => a.sessionId === sessionId);
	if (existing) {
		existing.label = label;
		existing.prompt = prompt;
		existing.answer = '';
		existing.state = 'waiting';
		existing.updatedAt = Date.now();
		return;
	}
	activity = [
		...activity,
		{ sessionId, label, prompt, answer: '', state: 'waiting', updatedAt: Date.now() }
	];
}

export function noteAnswer(sessionId: string, answer: string): void {
	const entry = activity.find((a) => a.sessionId === sessionId);
	if (!entry) return;
	// Keep the end, not the beginning: the host is watching it arrive.
	entry.answer = answer.length > MAX_ANSWER_CHARS ? answer.slice(-MAX_ANSWER_CHARS) : answer;
	entry.state = 'answering';
	entry.updatedAt = Date.now();
}

export function noteFinished(sessionId: string, state: 'done' | 'failed', text?: string): void {
	const entry = activity.find((a) => a.sessionId === sessionId);
	if (!entry) return;
	if (text !== undefined) {
		entry.answer = text.length > MAX_ANSWER_CHARS ? text.slice(-MAX_ANSWER_CHARS) : text;
	}
	entry.state = state;
	entry.updatedAt = Date.now();
}

/** Forget a guest entirely — after a disconnect, or when the server stops. */
export function forgetRemoteActivity(sessionId?: string): void {
	activity = sessionId ? activity.filter((a) => a.sessionId !== sessionId) : [];
}
