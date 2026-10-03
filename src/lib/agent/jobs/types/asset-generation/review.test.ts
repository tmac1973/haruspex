import { describe, it, expect, vi } from 'vitest';
import type { AssetSpec } from '$lib/assets/spec/types';
import { amendPrompt, applyNotes, historyPath, regenerateMarked, stamp } from './review';

function spec(): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'pixel art' },
		anchor: { image: 'a.png', recipe: 'a.json' },
		normalize: {} as AssetSpec['normalize'],
		entries: [
			{
				id: 'player',
				kind: 'sprite',
				prompt: 'a hooded adventurer.',
				out: 'assets/generated/sprite/player.png'
			},
			{
				id: 'coin',
				kind: 'sprite',
				prompt: 'a gold coin',
				out: 'assets/generated/sprite/coin.png'
			},
			{ id: 'grass', kind: 'texture', prompt: 'grass', out: 'assets/generated/texture/grass.png' }
		]
	};
}

describe('historyPath', () => {
	it('keeps the file beside itself, in .history, stamped', () => {
		expect(historyPath('assets/generated/sprite/player.png', '20261002-203011')).toBe(
			'assets/generated/sprite/.history/player-20261002-203011.png'
		);
		expect(historyPath('player.png', 'x')).toBe('.history/player-x.png');
	});

	it('stamps without characters a filesystem dislikes', () => {
		expect(stamp(new Date(2026, 9, 2, 20, 30, 11))).toBe('20261002-203011');
	});
});

describe('notes', () => {
	it('are appended to the prompt, once, tidily', () => {
		expect(amendPrompt('a hooded adventurer.', 'no coin, hands empty.')).toBe(
			'a hooded adventurer, no coin, hands empty'
		);
		expect(amendPrompt('a coin', '  ')).toBe('a coin');
		expect(amendPrompt('a coin', undefined)).toBe('a coin');
	});

	it('change only the marked assets', () => {
		const out = applyNotes(spec(), [{ id: 'player', note: 'no coin' }]);
		expect(out.entries.map((e) => e.prompt)).toEqual([
			'a hooded adventurer, no coin',
			'a gold coin',
			'grass'
		]);
	});
});

describe('regenerateMarked', () => {
	function deps(onDisk: string[]) {
		const order: string[] = [];
		return {
			order,
			d: {
				exists: vi.fn(async (rel: string) => onDisk.includes(rel)),
				move: vi.fn(async (from: string, to: string) => void order.push(`move ${from} -> ${to}`)),
				writeSpec: vi.fn(async (s: AssetSpec) => void order.push(`spec ${s.entries[0].prompt}`)),
				run: vi.fn(async () => (order.push('run'), 42)),
				now: () => new Date(2026, 9, 2, 20, 30, 11)
			}
		};
	}

	it('saves the note, moves the file aside, then starts the run', async () => {
		const { d, order } = deps(['assets/generated/sprite/player.png']);
		const r = await regenerateMarked(spec(), [{ id: 'player', note: 'no coin' }], d);
		expect(order).toEqual([
			'spec a hooded adventurer, no coin',
			'move assets/generated/sprite/player.png -> assets/generated/sprite/.history/player-20261002-203011.png',
			'run'
		]);
		expect(r).toMatchObject({ amended: ['player'], runId: 42 });
	});

	it('leaves the spec alone when there are no notes, and skips files already gone', async () => {
		const { d } = deps(['assets/generated/sprite/coin.png']);
		const r = await regenerateMarked(spec(), [{ id: 'player' }, { id: 'coin' }, { id: 'nope' }], d);
		expect(d.writeSpec).not.toHaveBeenCalled();
		expect(r.moved.map((m) => m.from)).toEqual(['assets/generated/sprite/coin.png']);
		expect(d.run).toHaveBeenCalledTimes(1);
	});

	it('moves nothing when saving the note fails', async () => {
		const { d } = deps(['assets/generated/sprite/player.png']);
		d.writeSpec.mockRejectedValueOnce(new Error('disk full'));
		await expect(regenerateMarked(spec(), [{ id: 'player', note: 'x' }], d)).rejects.toThrow();
		expect(d.move).not.toHaveBeenCalled();
		expect(d.run).not.toHaveBeenCalled();
	});
});
