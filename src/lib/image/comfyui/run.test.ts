import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import { resumePrompt } from './run';

const api = vi.hoisted(() => ({
	GENERATION_TIMEOUT_MS: 60_000,
	HISTORY_POLL_MS: 1,
	queueState: vi.fn(),
	history: vi.fn(),
	view: vi.fn(),
	subscribe: vi.fn(),
	cancelPrompt: vi.fn()
}));

vi.mock('#lib/image/comfyui/client.ts', () => api);
vi.mock('#lib/utils/async.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/utils/async.ts')>()),
	sleep: () => Promise.resolve()
}));

const cfg = { baseUrl: 'http://configured:8188', apiKey: '' };

function handle(extra: Record<string, string> = { outputNode: '9', clientId: 'c1' }) {
	return {
		backend: 'comfyui',
		baseUrl: 'http://box:8188',
		id: 'p1',
		seed: 7,
		model: 'm',
		width: 8,
		height: 8,
		extra
	} as ImageJobHandle;
}

const image = { filename: 'out.png', subfolder: '', type: 'output' };
const closeSocket = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	api.queueState.mockResolvedValue({ running: ['p1'], pending: [] });
	api.history.mockResolvedValue(null);
	api.view.mockResolvedValue(new Uint8Array([1, 2, 3]));
	api.subscribe.mockReturnValue(closeSocket);
	api.cancelPrompt.mockResolvedValue(undefined);
});

describe('resumePrompt', () => {
	it('follows the prompt on the server it went to and downloads the result', async () => {
		api.history
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce([image]);
		const onProgress = vi.fn();

		const images = await resumePrompt(cfg, handle(), { onProgress });

		expect(images).toEqual([new Uint8Array([1, 2, 3])]);
		expect(api.queueState.mock.calls[0][0].baseUrl).toBe('http://box:8188');
		expect(api.history).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: 'http://box:8188' }),
			'p1',
			'9',
			undefined
		);
		expect(api.subscribe.mock.calls[0][1]).toBe('c1');
		expect(onProgress).toHaveBeenCalledWith({ phase: 'downloading' });
		// The socket is alive, so polling leaves progress to it.
		expect(onProgress).not.toHaveBeenCalledWith({ phase: 'running' });
		expect(closeSocket).toHaveBeenCalledOnce();
	});

	it('says so when the server has lost the job', async () => {
		api.queueState.mockResolvedValue({ running: ['other'], pending: ['another'] });
		api.history.mockRejectedValue(new Error('404'));

		await expect(resumePrompt(cfg, handle(), {})).rejects.toMatchObject({
			name: 'ImageBackendError',
			kind: 'rejected',
			status: 404
		});
		expect(api.subscribe).not.toHaveBeenCalled();
	});

	it('downloads a job that finished while the app was closed, even if the queue is empty', async () => {
		api.queueState.mockResolvedValue({ running: [], pending: [] });
		api.history.mockResolvedValue([image]);

		await expect(resumePrompt(cfg, handle(), {})).resolves.toHaveLength(1);
	});

	it('keeps waiting when the queue cannot be read', async () => {
		api.queueState.mockResolvedValue(null);
		api.history.mockResolvedValueOnce(null).mockResolvedValueOnce([image]);

		await expect(resumePrompt(cfg, handle(), {})).resolves.toHaveLength(1);
	});

	it('cancels the prompt on the server when aborted while waiting', async () => {
		const abort = new AbortController();
		api.history
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(async () => {
				abort.abort();
				return null;
			})
			.mockResolvedValue(null);

		await expect(resumePrompt(cfg, handle(), { signal: abort.signal })).rejects.toMatchObject({
			kind: 'cancelled'
		});
		expect(api.cancelPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: 'http://box:8188' }),
			'p1'
		);
		expect(api.view).not.toHaveBeenCalled();
		expect(closeSocket).toHaveBeenCalledOnce();
	});

	it('reports progress from polling once the socket closes', async () => {
		api.subscribe.mockImplementation((_cfg, _id, _onProgress, onFailure: () => void) => {
			onFailure();
			return closeSocket;
		});
		api.history.mockResolvedValueOnce(null).mockResolvedValueOnce([image]);
		const onProgress = vi.fn();

		await resumePrompt(cfg, handle(), { onProgress });

		expect(onProgress).toHaveBeenCalledWith({ phase: 'running' });
		expect(closeSocket).toHaveBeenCalledOnce();
	});

	it('polls without a socket when the handle has no client id', async () => {
		api.history.mockResolvedValueOnce(null).mockResolvedValueOnce([image]);
		const onProgress = vi.fn();

		await resumePrompt(cfg, handle({ outputNode: '9' }), { onProgress });

		expect(api.subscribe).not.toHaveBeenCalled();
		expect(onProgress).toHaveBeenCalledWith({ phase: 'running' });
	});

	it('passes a server error through without cancelling', async () => {
		api.history.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('500'));

		await expect(resumePrompt(cfg, handle(), {})).rejects.toThrow('500');
		expect(api.cancelPrompt).not.toHaveBeenCalled();
		expect(closeSocket).toHaveBeenCalledOnce();
	});
});
