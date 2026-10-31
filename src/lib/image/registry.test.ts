import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImageBackend } from './backend';
import type { ImageBackendKind, ImageModelEntry } from './types';

beforeEach(() => {
	vi.resetModules();
});

function fake(kind: ImageBackendKind, marker = 'a'): ImageBackend {
	return {
		kind,
		capabilities: async () => ({
			transparency: false,
			seamlessTiling: false,
			loras: false,
			maxLoras: 0
		}),
		probe: async () => ({ ok: true, detail: marker }),
		generate: async () => {
			throw new Error('not used');
		}
	};
}

describe('image backend registry', () => {
	it('registers and looks up a backend by kind', async () => {
		const { registerImageBackend, getImageBackend } = await import('./registry');
		const b = fake('comfyui');
		registerImageBackend(b);
		expect(getImageBackend('comfyui')).toBe(b);
	});

	it('returns undefined for a kind nothing registered', async () => {
		const { getImageBackend } = await import('./registry');
		expect(getImageBackend('local')).toBeUndefined();
	});

	it('re-registering a kind replaces rather than duplicates', async () => {
		// The barrel is module-cached and may be imported more than once; a
		// duplicate registration has to be idempotent.
		const { registerImageBackend, getImageBackend, listImageBackends } = await import('./registry');
		registerImageBackend(fake('comfyui', 'first'));
		registerImageBackend(fake('comfyui', 'second'));
		expect((await getImageBackend('comfyui')!.probe()).detail).toBe('second');
		expect(listImageBackends()).toHaveLength(1);
	});

	it('lists in registration order', async () => {
		const { registerImageBackend, listImageBackends } = await import('./registry');
		registerImageBackend(fake('comfyui'));
		registerImageBackend(fake('local'));
		expect(listImageBackends().map((b) => b.kind)).toEqual(['comfyui', 'local']);
	});
});

describe('backends built per entry', () => {
	const entry = (id: string, url: string): ImageModelEntry => ({
		id,
		name: id,
		backend: 'comfyui',
		url,
		keyId: null,
		model: 'm.safetensors',
		options: {},
		caps: null,
		capsAt: null,
		renamed: false
	});

	/** A factory whose backends say which server they were built for. */
	function byServer(built: string[]) {
		return (e: ImageModelEntry): ImageBackend => {
			built.push(e.url);
			return {
				...fake('comfyui', e.url),
				generate: async (_req, opts) => {
					opts?.onHandle?.({
						backend: 'comfyui',
						baseUrl: e.url,
						id: 'p1',
						seed: 1,
						model: e.model,
						width: 8,
						height: 8
					});
					return {
						images: [],
						meta: {
							seed: 1,
							model: e.model,
							backend: 'comfyui',
							sampler: { name: 's', steps: 1, cfg: 1 },
							loras: [],
							durationMs: 0
						}
					};
				}
			};
		};
	}

	it('builds one per entry, so two servers of one kind work side by side', async () => {
		const { registerImageBackendKind, backendForEntry } = await import('./registry');
		const built: string[] = [];
		registerImageBackendKind('comfyui', byServer(built));
		const a = backendForEntry(entry('a', 'http://one:8188'))!;
		const b = backendForEntry(entry('b', 'http://two:8188'))!;
		expect((await a.probe()).detail).toBe('http://one:8188');
		expect((await b.probe()).detail).toBe('http://two:8188');
		expect(built).toEqual(['http://one:8188', 'http://two:8188']);
	});

	it('keeps an entry’s backend until its config changes', async () => {
		const { registerImageBackendKind, backendForEntry } = await import('./registry');
		const built: string[] = [];
		registerImageBackendKind('comfyui', byServer(built));
		const first = backendForEntry(entry('a', 'http://one:8188'));
		expect(backendForEntry({ ...entry('a', 'http://one:8188'), name: 'renamed' })).toBe(first);
		expect(backendForEntry(entry('a', 'http://moved:8188'))).not.toBe(first);
		expect(built).toEqual(['http://one:8188', 'http://moved:8188']);
	});

	it('says which entry made a result and sent a job', async () => {
		const { registerImageBackendKind, backendForEntry } = await import('./registry');
		registerImageBackendKind('comfyui', byServer([]));
		const onHandle = vi.fn();
		const result = await backendForEntry(entry('a', 'http://one:8188'))!.generate(
			{ prompt: 'x', width: 8, height: 8, seed: null },
			{ onHandle }
		);
		expect(result.meta.entryId).toBe('a');
		expect(onHandle).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'a', id: 'p1' }));
	});
});
