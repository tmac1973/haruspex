/**
 * A first-in, first-out queue of approval prompts, for a store whose modal
 * shows one request at a time.
 *
 * Several turns can ask at once: two Code sessions, or a Code session and a
 * Shell tab, each run their tools while another waits for the model. A
 * single pending slot turned the second ask into a tool error. Here every ask
 * waits its turn; the modal shows `current()`, and answering it brings up the
 * next one.
 *
 * Aborting an ask (its turn stopped, its session closed) takes it out of the
 * queue, wherever it is, and settles it with `abortResult`, so nobody is
 * shown a question for a turn that has already ended.
 *
 * The queue is module state, and each window (webview) has its own JS
 * context, so each window has its own queue and renders its own modal: a
 * detached Code or Shell window never waits behind the main window's prompts.
 */

interface Entry<Req, Res> {
	request: Req;
	resolve: (result: Res) => void;
	cleanup: () => void;
}

export interface ApprovalQueue<Req, Res> {
	/**
	 * Queue `request` and wait for its answer. When `signal` aborts first, the
	 * request leaves the queue and resolves to `abortResult`.
	 */
	ask(request: Req, opts?: { signal?: AbortSignal; abortResult: Res }): Promise<Res>;
	/** The request the modal shows: the oldest one waiting, or null. */
	current(): Req | null;
	/** How many requests are waiting, the shown one included. */
	size(): number;
	/** Answer the shown request; the next one, if any, takes its place. */
	resolve(result: Res): void;
}

export function createApprovalQueue<Req, Res>(): ApprovalQueue<Req, Res> {
	// Raw: entries are replaced, never mutated, and the abort handler finds
	// its own entry by identity.
	let entries = $state.raw<Entry<Req, Res>[]>([]);

	const remove = (entry: Entry<Req, Res>): boolean => {
		if (!entries.includes(entry)) return false;
		entries = entries.filter((e) => e !== entry);
		entry.cleanup();
		return true;
	};

	return {
		ask(request, opts) {
			return new Promise<Res>((resolve) => {
				const signal = opts?.signal;
				if (signal?.aborted && opts) return resolve(opts.abortResult);
				const onAbort = () => {
					if (opts && remove(entry)) resolve(opts.abortResult);
				};
				const entry: Entry<Req, Res> = {
					request,
					resolve,
					cleanup: () => signal?.removeEventListener('abort', onAbort)
				};
				signal?.addEventListener('abort', onAbort, { once: true });
				entries = [...entries, entry];
			});
		},
		current() {
			return entries[0]?.request ?? null;
		},
		size() {
			return entries.length;
		},
		resolve(result) {
			const head = entries[0];
			if (!head || !remove(head)) return;
			head.resolve(result);
		}
	};
}
