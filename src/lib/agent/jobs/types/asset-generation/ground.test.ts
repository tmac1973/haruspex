import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { blendReason, groundOf } from './ground';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

const tone = { lightness: 0.22, target: 0.47, targetGrey: 0x5c5c5cff };

describe('blendReason', () => {
	it('is null when the sprites show up', () => {
		expect(blendReason({ ground: 0.5, sprites: [0.2], blending: 0, ok: true, tone })).toBeNull();
	});

	it('gives the recipe writer the numbers and the way to go', () => {
		const why = blendReason({
			ground: 0.19,
			sprites: [0.22, 0.25, 0.6],
			blending: 2,
			ok: false,
			tone
		});
		expect(why).toContain('its lightness is 0.19');
		expect(why).toContain('2 of 3 sprites are about as light (theirs: 0.22, 0.25, 0.60)');
		expect(why).toContain('clearly lighter, around #5c5c5c');
	});
});

describe('groundOf', () => {
	beforeEach(() => tauri.invoke.mockReset());

	const piece = (id: number, area: number) => ({
		bytes: [id],
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		cx: 0,
		cy: 0,
		area,
		lobes: 1
	});

	it('keeps the largest sprites and drops specks', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				image_split_sheet: {
					pieces: [piece(1, 10), piece(2, 1000), piece(3, 20), piece(4, 500)],
					keyed: false,
					palette: []
				},
				texture_sprite_tone: tone
			})
		);
		const g = await groundOf(new Uint8Array([1]), {
			alpha_threshold: null,
			background: { color: 0xff00ffff, tolerance: 40, auto_detect: false }
		} as never);
		expect(g?.sprites.map((s) => s[0])).toEqual([2, 4]);
		expect(g?.tone).toEqual(tone);
	});

	it('is null when there is nothing to cut', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ image_split_sheet: { pieces: [], keyed: false, palette: [] } })
		);
		expect(await groundOf(new Uint8Array([1]), { background: {} } as never)).toBeNull();
	});
});
