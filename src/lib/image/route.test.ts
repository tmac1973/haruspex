import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageBackend } from './backend';
import { ImageBackendError, type ImageBackendCapabilities, type ImageModelEntry } from './types';

const state = vi.hoisted(() => ({
	entries: [] as ImageModelEntry[],
	saved: [] as string[],
	backends: {} as Record<string, ImageBackend>
}));
vi.mock('#lib/image/entries.ts', () => ({
	imageEntries: () => state.entries.filter((e) => !e.disabled),
	allImageEntries: () => state.entries,
	saveImageCaps: (id: string) => state.saved.push(id)
}));
vi.mock('#lib/image/registry.ts', () => ({
	backendForEntry: (e: ImageModelEntry) => state.backends[e.id]
}));

import { capableEntries, needOf, routeImage, upscaleNeed, type ImageNeed } from './route';

const base: ImageBackendCapabilities = {
	transparency: false,
	seamlessTiling: false,
	loras: false,
	maxLoras: 0
};
const DRAWS: ImageBackendCapabilities = { ...base, transparency: true };
const EDITS_4: ImageBackendCapabilities = { ...base, edit: true, maxEditImages: 4 };
const EDITS_3: ImageBackendCapabilities = { ...base, edit: true, maxEditImages: 3, upscale: true };

function entry(id: string, caps: ImageBackendCapabilities | null): ImageModelEntry {
	return {
		id,
		name: id,
		backend: 'llama-toolchest',
		url: `http://${id}:3000`,
		keyId: null,
		model: id,
		options: {},
		caps,
		capsAt: null,
		renamed: false
	};
}

/** A backend that answers as `caps` say, or not at all. */
function backend(caps: ImageBackendCapabilities, how: 'ok' | 'down' | 'refuses' = 'ok') {
	return {
		kind: 'llama-toolchest',
		probe: async () =>
			how === 'down' ? { ok: false, detail: 'Can’t reach it.' } : { ok: true, detail: 'ok' },
		capabilities: async () => caps,
		generate: async () => {
			if (how === 'refuses') throw new ImageBackendError('rejected', 'bad prompt');
			throw new Error('not used');
		}
	} as ImageBackend;
}

const draw: ImageNeed = needOf({ prompt: 'x', width: 8, height: 8, seed: null });
const edit = (n: number): ImageNeed => ({ ...draw, op: 'edit', pictures: n });
/** Which entry the router settles on. */
const ranOn = (need: ImageNeed, named?: string) =>
	routeImage(need, async (e) => e.id, { named }).then((r) => r.value);

beforeEach(() => {
	state.entries = [entry('A', DRAWS), entry('B', EDITS_4), entry('C', EDITS_3)];
	state.backends = { A: backend(DRAWS), B: backend(EDITS_4), C: backend(EDITS_3) };
	state.saved = [];
});

describe('routeImage', () => {
	it('goes to the first entry that can do the job', async () => {
		expect(await ranOn(draw)).toBe('A');
		expect(await ranOn(edit(2))).toBe('B');
		expect(await ranOn(edit(4))).toBe('B');
		// A toolchest model's own upscaler isn't used: those are in Settings → Image generation → Upscalers.
		await expect(ranOn(upscaleNeed())).rejects.toThrow('Settings → Image generation → Upscalers');
		state.entries = state.entries.map((e) => (e.id === 'C' ? { ...e, backend: 'comfyui' } : e));
		expect(await ranOn(upscaleNeed())).toBe('C');
	});

	it('refuses an edit no entry can take, before asking any server', async () => {
		await expect(ranOn(edit(5))).rejects.toThrow('This model combines at most 4 pictures');
		expect(state.saved).toEqual([]);
	});

	it('prefers one that can also do what is wanted, even later in the list', async () => {
		state.entries = [entry('B', EDITS_4), entry('A', DRAWS)];
		expect(await ranOn({ ...draw, transparent: true })).toBe('A');
		expect(await ranOn(draw)).toBe('B');
	});

	it('passes over one that doesn’t answer, and keeps what the one that ran said', async () => {
		state.backends.B = backend(EDITS_4, 'down');
		expect(await ranOn(edit(2))).toBe('C');
		expect(state.saved).toEqual(['C']);
	});

	it('does not try another when one refuses the request', async () => {
		state.backends.B = backend(EDITS_4, 'refuses');
		const tried: string[] = [];
		await expect(
			routeImage(edit(2), (e, b) => {
				tried.push(e.id);
				return b.generate({ prompt: 'x', width: 8, height: 8, seed: null });
			})
		).rejects.toThrow('bad prompt');
		expect(tried).toEqual(['B']);
	});

	it('names every model that didn’t answer when none did', async () => {
		state.backends.B = backend(EDITS_4, 'down');
		state.backends.C = backend(EDITS_3, 'down');
		await expect(ranOn(edit(2))).rejects.toMatchObject({
			kind: 'unreachable',
			message: 'No image model answered: B (b:3000): Can’t reach it.; C (c:3000): Can’t reach it..'
		});
	});

	describe('a model the server could not start', () => {
		const VRAM =
			'llama-toolchest refused /v1/images/edits: not enough VRAM on GPU 0: needs 18.5 GiB, but only 5.1 GiB is left';
		/** Run on each entry's backend, B refusing for want of VRAM. */
		const generate = (named?: string) =>
			routeImage(
				edit(2),
				async (e) => {
					if (e.id === 'B') throw new ImageBackendError('rejected', VRAM);
					return e.id;
				},
				{ named }
			).then((r) => r.value);

		it('tries the next when no model was named', async () => {
			expect(await generate()).toBe('C');
		});

		it('lists it and why when none could', async () => {
			state.backends.C = backend(EDITS_3, 'down');
			await expect(generate()).rejects.toMatchObject({
				message: `No image model answered: B (b:3000): ${VRAM}; C (c:3000): Can’t reach it..`
			});
		});

		it('still fails a named model as itself', async () => {
			await expect(generate('B')).rejects.toMatchObject({ kind: 'rejected', message: VRAM });
		});
	});

	it('tries an entry no probe has answered for after the known ones, and judges it live', async () => {
		state.entries = [entry('U', null), entry('A', DRAWS)];
		state.backends.U = backend(EDITS_4);
		expect(capableEntries(edit(2)).map((e) => e.id)).toEqual(['U']);
		expect(await ranOn(edit(2))).toBe('U');
		expect(await ranOn(draw)).toBe('A');
		state.backends.U = backend(DRAWS);
		await expect(ranOn(edit(2))).rejects.toThrow(/can't edit pictures/);
	});

	it('runs a named entry, refuses one that can’t, and says who can', async () => {
		expect(await ranOn(edit(2), 'C')).toBe('C');
		expect(await ranOn(edit(2), ' c ')).toBe('C');
		await expect(ranOn(edit(2), 'A')).rejects.toThrow("A can't edit pictures. B, C can.");
		await expect(ranOn(draw, 'nobody')).rejects.toThrow(
			'There is no image model called "nobody". The models are: A, B, C.'
		);
	});

	it('says a named model is turned off rather than missing (#1352)', async () => {
		state.entries = [{ ...entry('Ming', DRAWS), disabled: true }, entry('A', DRAWS)];
		await expect(ranOn(draw, 'ming')).rejects.toThrow(
			'Ming is turned off in Settings → Image generation. The models on are: A.'
		);
	});

	it('says who can when only the probe finds a named entry can’t', async () => {
		state.entries = [entry('A', null), entry('B', EDITS_4), entry('C', EDITS_3)];
		await expect(ranOn(edit(2), 'A')).rejects.toMatchObject({
			kind: 'rejected',
			message: "A can't edit pictures. B, C can."
		});
	});

	it('doesn’t move a named entry that doesn’t answer onto another', async () => {
		state.backends.B = backend(EDITS_4, 'down');
		await expect(ranOn(edit(2), 'B')).rejects.toMatchObject({
			kind: 'unreachable',
			message: "B isn't ready: Can’t reach it."
		});
	});

	it('tries a background task’s own entry first, even once it is gone from the list', async () => {
		const gone = entry('G', EDITS_4);
		state.backends.G = backend(EDITS_4);
		expect((await routeImage(edit(2), async (e) => e.id, { prefer: gone })).value).toBe('G');
		state.backends.G = backend(EDITS_4, 'down');
		expect((await routeImage(edit(2), async (e) => e.id, { prefer: gone })).value).toBe('B');
	});

	it('says image generation isn’t set up when the list is empty', async () => {
		state.entries = [];
		await expect(ranOn(draw)).rejects.toThrow(/Settings → Image generation/);
	});
});
