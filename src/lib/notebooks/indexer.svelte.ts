/**
 * Keeps notebook semantic search current: with Settings → Notebooks →
 * Semantic search on and the model downloaded, cards whose text changed are
 * embedded a few at a time, 5 seconds after a change and at startup.
 */
import * as api from '#lib/notebooks/api.ts';
import { onNotebookChanged } from '#lib/stores/notebooks.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';

const DELAY_MS = 5000;
const BATCH = 16;

let pending = $state(0);
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Cards waiting to be indexed, as last counted. */
export const getIndexPending = () => pending;

/** Index what changed, a batch at a time, until nothing waits. */
export async function indexNow(): Promise<void> {
	if (running || !getSettings().notebooks?.semanticSearch) return;
	running = true;
	try {
		const status = await api.semanticStatus();
		pending = status.pending;
		if (!status.model_present) return;
		while (pending > 0 && getSettings().notebooks?.semanticSearch) {
			pending = await api.embedPending(BATCH);
			// Give the rest of the app a turn between batches.
			await new Promise((r) => setTimeout(r, 50));
		}
	} catch (e) {
		console.warn('notebook indexing failed', e);
	} finally {
		running = false;
	}
}

/** Index a little after a change, so a burst of edits is one pass. */
export function scheduleIndex(delayMs = DELAY_MS): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		void indexNow();
	}, delayMs);
}

/** Start at app start (the root layout). */
export function startNotebookIndexer(): () => void {
	if (started) return () => {};
	started = true;
	const off = onNotebookChanged(() => scheduleIndex());
	scheduleIndex(DELAY_MS);
	return () => {
		off();
		if (timer) clearTimeout(timer);
		started = false;
	};
}
