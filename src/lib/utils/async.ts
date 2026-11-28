/**
 * Async timing helpers shared across the app.
 */

/**
 * Resolve after `ms` milliseconds, or as soon as `signal` aborts. Replaces the
 * inline `new Promise((r) => setTimeout(r, ms))` idiom. An abort resolves
 * rather than rejects: the caller checks `signal.aborted` and says what was
 * cancelled in its own words.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/**
 * `sleep`, but an AbortError once `signal` aborts, before or during the
 * wait: for a loop that must stop when its run is cancelled, not go round
 * once more.
 */
export async function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
	await sleep(ms, signal);
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
