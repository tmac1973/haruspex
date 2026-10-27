/**
 * Running a workflow on ComfyUI: queue it, follow it over the progress socket
 * and the history until it finishes, and download what it saved. Also
 * following a prompt an earlier run of the app queued (`resumePrompt`).
 */
import { sleep } from '#lib/utils/async.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import type { GenerateOptions, ImageJobHandle } from '#lib/image/backend.ts';
import type { ComfyGraph } from '#lib/image/comfyui/fieldMap.ts';
import * as api from '#lib/image/comfyui/client.ts';

/**
 * `p`, unless `signal` aborts first: then `onAbort` runs and this rejects as
 * cancelled at once, while `p` carries on.
 */
function untilAborted<T>(
	p: Promise<T>,
	signal: AbortSignal | undefined,
	onAbort: () => void
): Promise<T> {
	if (!signal) return p;
	const cancelled = () => new ImageBackendError('cancelled', 'Generation cancelled.');
	if (signal.aborted) {
		onAbort();
		return Promise.reject(cancelled());
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort();
			reject(cancelled());
		};
		signal.addEventListener('abort', abort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener('abort', abort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener('abort', abort);
				reject(e);
			}
		);
	});
}

/**
 * Queue `graph`, follow it to the end and download what `outputNode` saved.
 * A cancel removes the prompt from the server's queue. `handleOf` makes the
 * reference `opts.onHandle` hears once the server has the prompt.
 */
export async function run(
	cfg: api.ClientConfig,
	graph: ComfyGraph,
	outputNode: string,
	clientId: string,
	opts: GenerateOptions,
	handleOf?: (promptId: string) => ImageJobHandle
): Promise<Uint8Array[]> {
	const started = Date.now();
	let socketAlive = true;
	const closeSocket = api.subscribe(
		cfg,
		clientId,
		(p) => opts.onProgress?.(p),
		() => {
			socketAlive = false;
		},
		(id) => graph[id]?.class_type
	);

	let promptId: string | null = null;
	try {
		// Not given the abort signal: a submit cut short can leave the prompt
		// queued with its id lost, and it would then run anyway. A cancel
		// during submit settles at once; the prompt is removed once submit
		// says what it was.
		const submitting = api.submit(cfg, graph, clientId);
		promptId = await untilAborted(submitting, opts.signal, () => {
			submitting.then(
				(id) => api.cancelPrompt(cfg, id),
				() => {}
			);
		});
		if (handleOf) opts.onHandle?.(handleOf(promptId));
		return await awaitPrompt(cfg, promptId, outputNode, opts, started, () => socketAlive);
	} catch (e) {
		if (opts.signal?.aborted) {
			// In the background: the generation settles as cancelled now.
			if (promptId) void api.cancelPrompt(cfg, promptId);
			throw new ImageBackendError('cancelled', 'Generation cancelled.');
		}
		throw e;
	} finally {
		closeSocket();
	}
}

/** Poll a queued prompt's history until it finishes, then download what `outputNode` saved. */
async function awaitPrompt(
	cfg: api.ClientConfig,
	promptId: string,
	outputNode: string,
	opts: GenerateOptions,
	started: number,
	socketAlive: () => boolean
): Promise<Uint8Array[]> {
	const deadline = started + api.GENERATION_TIMEOUT_MS;
	let images: api.HistoryImage[] | null = null;
	while (images === null) {
		if (opts.signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
		if (Date.now() > deadline) {
			throw new ImageBackendError(
				'timeout',
				`The image backend did not finish within ${api.GENERATION_TIMEOUT_MS / 1000}s.`
			);
		}
		await sleep(api.HISTORY_POLL_MS);
		if (!socketAlive()) opts.onProgress?.({ phase: 'running' });
		images = await api.history(cfg, promptId, outputNode, opts.signal);
	}

	opts.onProgress?.({ phase: 'downloading' });
	return await Promise.all(images.map((i) => api.view(cfg, i, opts.signal)));
}

/** A prompt an earlier run sent, followed to its end on the server it went to. */
export async function resumePrompt(
	base: api.ClientConfig,
	handle: ImageJobHandle,
	opts: GenerateOptions
): Promise<Uint8Array[]> {
	const cfg = { ...base, baseUrl: handle.baseUrl };
	const outputNode = handle.extra?.outputNode ?? '';
	const clientId = handle.extra?.clientId ?? '';
	// Neither waiting, running nor in the history: the server has lost it
	// (restarted, or its history was cleared).
	const [queue, done] = await Promise.all([
		api.queueState(cfg),
		api.history(cfg, handle.id, outputNode, opts.signal).catch(() => null)
	]);
	if (!done && queue && ![...queue.running, ...queue.pending].includes(handle.id)) {
		throw new ImageBackendError('rejected', 'ComfyUI no longer has this job.', { status: 404 });
	}
	let socketAlive = !!clientId;
	const closeSocket = clientId
		? api.subscribe(
				cfg,
				clientId,
				(p) => opts.onProgress?.(p),
				() => {
					socketAlive = false;
				},
				() => undefined
			)
		: () => {};
	try {
		return await awaitPrompt(cfg, handle.id, outputNode, opts, Date.now(), () => socketAlive);
	} catch (e) {
		if (opts.signal?.aborted) {
			void api.cancelPrompt(cfg, handle.id);
			throw new ImageBackendError('cancelled', 'Generation cancelled.');
		}
		throw e;
	} finally {
		closeSocket();
	}
}
