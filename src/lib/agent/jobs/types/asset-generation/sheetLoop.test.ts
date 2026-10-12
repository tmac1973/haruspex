/**
 * `runSheet` on its own: the cut is scripted per round (`assignCells` is
 * replaced), and the Rust normalize/check commands answer from the piece's
 * bytes, so each test says exactly what every cell held.
 *
 * A piece's bytes are `[quality, paletteDistance, tag]`: quality 1 passes the
 * check, 0 fails `entropy`, 2 fails `entropy` and `alpha_low`. The tag shows
 * which piece ended up written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '#lib/assets/spec/types.ts';
import type { CheckReport } from '#lib/ipc/gen/CheckReport.ts';
import type { ImageResult } from '#lib/image/types.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import type { CellResult, SheetPlan } from './sheets';
import type { EntryOutcome, SheetOutcome } from './types';
import type { GenerateDeps } from './generate';
import type { AssetJudgement } from './tools';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const cut = vi.hoisted(() => ({ rounds: [] as CellResult[][], sizes: [] as number[] }));
vi.mock('#lib/agent/jobs/types/asset-generation/sheets.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./sheets')>()),
	assignCells: (_pieces: unknown, n: number) => {
		cut.sizes.push(n);
		const cells = cut.rounds.shift();
		if (!cells) throw new Error('no cells scripted for this round');
		return cells;
	}
}));

import { runSheet, MAY_BE_JOINED, joinedHint, type SheetLoopContext } from './sheetLoop';

function profile(): NormalizeProfile {
	return { palette_size: 16, palette: [], background: { color: 0 } } as unknown as NormalizeProfile;
}

function specOf(n: number, over: Partial<AssetEntry>[] = []): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art' },
		normalize: profile(),
		entries: Array.from({ length: n }, (_, i) => ({
			id: `e${i}`,
			kind: 'sprite',
			prompt: `thing ${i}`,
			out: `out/e${i}.png`,
			...over[i]
		}))
	} as unknown as AssetSpec;
}

function piece(quality: number, tag: number, paletteDistance = 10) {
	return {
		bytes: [quality, paletteDistance, tag],
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		cx: 0,
		cy: 0,
		area: 1,
		lobes: 1
	};
}

const ok = (tag: number, extra: Partial<CellResult> = {}): CellResult => ({
	status: 'ok',
	piece: piece(1, tag),
	suspect: false,
	...extra
});
const bad = (tag: number, quality = 0, paletteDistance = 10): CellResult => ({
	status: 'ok',
	piece: piece(quality, tag, paletteDistance),
	suspect: false
});
const missing: CellResult = { status: 'missing', suspect: false };
const merged: CellResult = { status: 'merge', suspect: false };

function image(seed: number): ImageResult {
	return { images: [{ bytes: new Uint8Array([seed]) }], meta: { seed } } as unknown as ImageResult;
}

interface Recorded {
	index: number;
	outcome: Omit<EntryOutcome, 'id' | 'durationMs'>;
	report: CheckReport | null;
}

interface Harness {
	ctx: SheetLoopContext;
	recorded: Recorded[];
	requeued: SheetPlan[];
	sheets: SheetOutcome[];
	written: Map<string, number[]>;
	prompts: string[];
	judged: Array<{ id: string; hint?: string }>;
	controller: AbortController;
}

interface Opts {
	n?: number;
	entries?: Partial<AssetEntry>[];
	present?: string[];
	retry?: boolean;
	maxAttempts?: number;
	generate?: (call: number) => Promise<ImageResult>;
	judge?: { enabled?: boolean; vision?: boolean; answer?: (id: string) => AssetJudgement | null };
	writeFails?: boolean;
	pregenerated?: Map<string, ImageResult>;
}

function harness(o: Opts = {}): { h: Harness; plan: SheetPlan } {
	const spec = specOf(o.n ?? 2, o.entries);
	const plan: SheetPlan = { id: 'sheet-1', kind: 'sprite', entries: [...spec.entries] };
	const controller = new AbortController();
	const h: Harness = {
		recorded: [],
		requeued: [],
		sheets: [],
		written: new Map(),
		prompts: [],
		judged: [],
		controller,
		ctx: undefined as unknown as SheetLoopContext
	};
	let calls = 0;
	const deps = {
		maxAttempts: o.maxAttempts ?? 3,
		signal: controller.signal,
		judge: {
			visionSupported: o.judge?.vision ?? true,
			enabled: o.judge?.enabled ?? false,
			judge: async (entry: AssetEntry, _img: Uint8Array, hint?: string) => {
				h.judged.push({ id: entry.id, hint });
				return o.judge?.answer ? o.judge.answer(entry.id) : { ok: true, reason: '' };
			}
		},
		generate: async (req: { prompt: string }) => {
			h.prompts.push(req.prompt);
			calls++;
			return o.generate ? o.generate(calls) : image(100 + calls);
		},
		exists: async (p: string) => (o.present ?? []).includes(p),
		writeBytes: async (p: string, bytes: Uint8Array) => {
			if (o.writeFails) throw new Error('disk full');
			h.written.set(p, Array.from(bytes));
		},
		onSheet: (s: SheetOutcome) => h.sheets.push({ ...s }),
		pregenerated: o.pregenerated
	} as unknown as GenerateDeps;
	h.ctx = {
		spec,
		deps,
		profile: profile(),
		retry: o.retry ?? false,
		record: (index, _started, outcome, report) => h.recorded.push({ index, outcome, report }),
		requeue: (p) => h.requeued.push(p)
	};
	return { h, plan };
}

function outcomeOf(h: Harness, index: number) {
	const r = h.recorded.filter((x) => x.index === index);
	expect(r).toHaveLength(1);
	return r[0];
}

beforeEach(() => {
	cut.rounds = [];
	cut.sizes = [];
	invoke.mockReset();
	invoke.mockImplementation(
		invokeRouter({
			image_split_sheet: { pieces: [], keyed: false, palette: [0x112233ff] },
			image_normalize: (args) => {
				const bytes = args?.bytes as number[];
				return {
					bytes,
					stats: { alpha: 0.5, entropy: bytes[0], palette_distance: bytes[1] / 100 }
				};
			},
			image_check: (args) => {
				const stats = args?.stats as { entropy: number; palette_distance: number };
				const failed =
					stats.entropy === 1 ? [] : stats.entropy === 0 ? ['entropy'] : ['entropy', 'alpha_low'];
				return { passed: failed.length === 0, stats, failed };
			}
		})
	);
});

describe('runSheet', () => {
	it('writes every subject a clean sheet delivers, from one generation', async () => {
		const { h, plan } = harness();
		cut.rounds = [[ok(1), ok(2)]];
		await runSheet(plan, h.ctx);

		expect(h.prompts).toHaveLength(1);
		expect(h.written.get('out/e0.png')).toEqual([1, 10, 1]);
		expect(h.written.get('out/e1.png')).toEqual([1, 10, 2]);
		for (const i of [0, 1]) {
			const r = outcomeOf(h, i);
			expect(r.outcome).toEqual({ status: 'done', attempts: 1, seed: 101, degraded: [] });
			expect(r.report?.passed).toBe(true);
		}
		expect(h.sheets).toEqual([
			{
				id: 'sheet-1',
				round: 1,
				subjects: ['e0', 'e1'],
				exact: true,
				keyed: false,
				missing: 0,
				merged: 0,
				rejected: 0,
				seed: 101
			}
		]);
	});

	it("normalizes each piece against the sheet's own palette", async () => {
		const { h, plan } = harness({ n: 1 });
		cut.rounds = [[ok(1)]];
		await runSheet(plan, h.ctx);
		const [norm] = invokeCalls(invoke, 'image_normalize');
		expect((norm?.profile as NormalizeProfile).palette).toEqual([0x112233ff]);
	});

	it('skips an entry already on disk and fails one whose path escapes the folder', async () => {
		const { h, plan } = harness({
			n: 3,
			entries: [{}, { out: '../outside.png' }, {}],
			present: ['out/e0.png']
		});
		cut.rounds = [[ok(9)]];
		await runSheet(plan, h.ctx);

		expect(outcomeOf(h, 0).outcome.status).toBe('skipped');
		expect(outcomeOf(h, 1).outcome).toMatchObject({ status: 'failed', attempts: 0 });
		expect(outcomeOf(h, 1).outcome.reason).toContain('escapes the working directory');
		expect(outcomeOf(h, 2).outcome.status).toBe('done');
		expect([...h.written.keys()]).toEqual(['out/e2.png']);
		expect(h.sheets[0].subjects).toEqual(['e2']);
	});

	it('regenerates an existing file on the retry pass', async () => {
		const { h, plan } = harness({ n: 1, present: ['out/e0.png'], retry: true });
		cut.rounds = [[ok(4)]];
		await runSheet(plan, h.ctx);
		expect(outcomeOf(h, 0).outcome.status).toBe('done');
	});

	it('does nothing when every entry is already on disk', async () => {
		const { h, plan } = harness({ present: ['out/e0.png', 'out/e1.png'] });
		await runSheet(plan, h.ctx);
		expect(h.prompts).toEqual([]);
		expect(h.sheets).toEqual([]);
	});

	it('sends only the failed subjects round again, padded with finished ones', async () => {
		const { h, plan } = harness();
		// Round 2 asks for e1 and pads with e0; the pad's cell is dropped unread.
		cut.rounds = [
			[ok(1), missing],
			[ok(3), ok(99)]
		];
		await runSheet(plan, h.ctx);

		expect(cut.sizes).toEqual([2, 2]);
		expect(h.sheets.map((s) => [s.round, s.subjects, s.missing, s.exact])).toEqual([
			[1, ['e0', 'e1'], 1, false],
			[2, ['e1'], 0, true]
		]);
		expect(outcomeOf(h, 0).outcome).toMatchObject({ status: 'done', attempts: 1, seed: 101 });
		expect(outcomeOf(h, 1).outcome).toMatchObject({ status: 'done', attempts: 2, seed: 102 });
		// e0 kept its first cut; the pad drawn in round 2 was not written over it.
		expect(h.written.get('out/e0.png')).toEqual([1, 10, 1]);
		expect(h.written.get('out/e1.png')).toEqual([1, 10, 3]);
	});

	it('records a subject never delivered as unresolved, with nothing kept', async () => {
		const { h, plan } = harness({ n: 1, maxAttempts: 2 });
		cut.rounds = [[missing], [merged]];
		await runSheet(plan, h.ctx);

		const r = outcomeOf(h, 0);
		expect(r.outcome).toMatchObject({ status: 'unresolved', attempts: 2, seed: 102 });
		expect(r.outcome.reason).toMatch(/touching a neighbour/);
		expect(r.outcome.kept).toBeUndefined();
		expect(h.written.size).toBe(0);
		expect(h.sheets.map((s) => [s.missing, s.merged, s.rejected])).toEqual([
			[1, 0, 0],
			[0, 1, 0]
		]);
	});

	it('keeps the best rejected cut when the budget runs out', async () => {
		const { h, plan } = harness({ n: 1, maxAttempts: 3 });
		cut.rounds = [[bad(1, 2)], [bad(2, 0, 30)], [bad(3, 0, 50)]];
		await runSheet(plan, h.ctx);

		const r = outcomeOf(h, 0);
		expect(r.outcome).toMatchObject({ status: 'unresolved', attempts: 3, kept: true });
		expect(r.outcome.reason).toMatch(/too little detail/);
		// Fewest failures, then lowest palette distance: round 2.
		expect(r.report?.failed).toEqual(['entropy']);
		expect(r.report?.stats.palette_distance).toBeCloseTo(0.3);
		expect(h.written.get('out/e0.png')).toEqual([0, 30, 2]);
		expect(h.sheets.map((s) => s.rejected)).toEqual([1, 1, 1]);
	});

	it('records unresolved without kept when writing the best cut fails', async () => {
		const { h, plan } = harness({ n: 1, maxAttempts: 1, writeFails: true });
		cut.rounds = [[bad(1)]];
		await runSheet(plan, h.ctx);
		expect(outcomeOf(h, 0).outcome).toMatchObject({ status: 'unresolved', attempts: 1 });
		expect(outcomeOf(h, 0).outcome.kept).toBeUndefined();
	});

	it('fails an entry whose passing piece cannot be written, without retrying it', async () => {
		const { h, plan } = harness({ n: 1, writeFails: true });
		cut.rounds = [[ok(1)]];
		await runSheet(plan, h.ctx);
		expect(outcomeOf(h, 0).outcome).toMatchObject({
			status: 'failed',
			attempts: 1,
			seed: 101,
			reason: 'disk full'
		});
		expect(h.prompts).toHaveLength(1);
	});

	it('counts a piece normalization rejects and tries it again', async () => {
		const { h, plan } = harness({ n: 1 });
		const route = invoke.getMockImplementation()!;
		let first = true;
		invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'image_normalize' && first) {
				first = false;
				throw new Error('not a PNG');
			}
			return route(cmd, args);
		});
		cut.rounds = [[ok(1)], [ok(2)]];
		await runSheet(plan, h.ctx);
		expect(h.sheets.map((s) => s.rejected)).toEqual([1, 0]);
		expect(outcomeOf(h, 0).outcome).toMatchObject({ status: 'done', attempts: 2 });
	});

	it("retries a cut the judge turns down, and reports the judge's reason", async () => {
		const { h, plan } = harness({
			n: 1,
			maxAttempts: 2,
			judge: { enabled: true, answer: () => ({ ok: false, reason: 'that is a sword' }) }
		});
		cut.rounds = [[ok(1)], [ok(2)]];
		await runSheet(plan, h.ctx);
		expect(h.judged).toHaveLength(2);
		expect(outcomeOf(h, 0).outcome).toMatchObject({
			status: 'unresolved',
			reason: 'that is a sword',
			kept: true
		});
	});

	it('shows a suspect piece to the judge even with the judge off', async () => {
		const { h, plan } = harness({ n: 1, judge: { enabled: false } });
		cut.rounds = [[ok(1, { suspect: true })]];
		await runSheet(plan, h.ctx);
		expect(h.judged).toEqual([{ id: 'e0', hint: undefined }]);
		expect(outcomeOf(h, 0).outcome.degraded).toEqual([]);
	});

	it('flags a joined-looking piece nobody judged, and hints the judge when it looks', async () => {
		const off = harness({ n: 1, judge: { enabled: false } });
		cut.rounds = [[ok(1, { why: 'lobes' })]];
		await runSheet(off.plan, off.h.ctx);
		expect(off.h.judged).toEqual([]);
		expect(outcomeOf(off.h, 0).outcome).toMatchObject({
			status: 'done',
			degraded: [MAY_BE_JOINED]
		});

		const on = harness({ n: 1, judge: { enabled: true } });
		cut.rounds = [[ok(1, { why: 'size' })]];
		await runSheet(on.plan, on.h.ctx);
		expect(on.h.judged).toEqual([{ id: 'e0', hint: joinedHint('e0') }]);
		expect(outcomeOf(on.h, 0).outcome.degraded).toEqual([]);
	});

	it('writes a piece the judge could not look at, and says so', async () => {
		const { h, plan } = harness({
			n: 1,
			judge: {
				enabled: true,
				answer: () => {
					throw new Error('model unloaded.');
				}
			}
		});
		cut.rounds = [[ok(1)]];
		await runSheet(plan, h.ctx);
		expect(outcomeOf(h, 0).outcome).toMatchObject({
			status: 'done',
			degraded: ['not checked by the judge — model unloaded']
		});
	});

	it('hands the sheet back once when the backend is briefly unreachable', async () => {
		const { h, plan } = harness({
			generate: () => Promise.reject(new ImageBackendError('unreachable', 'down'))
		});
		await runSheet(plan, h.ctx);
		expect(h.recorded).toEqual([]);
		expect(h.requeued).toEqual([{ ...plan, entries: plan.entries }]);
	});

	it('fails every pending entry on the retry pass instead of handing it back again', async () => {
		const { h, plan } = harness({
			retry: true,
			generate: () => Promise.reject(new ImageBackendError('unreachable', 'still down'))
		});
		await runSheet(plan, h.ctx);
		expect(h.requeued).toEqual([]);
		for (const i of [0, 1]) {
			expect(outcomeOf(h, i).outcome).toEqual({
				status: 'failed',
				attempts: 1,
				seed: null,
				degraded: [],
				reason: 'still down'
			});
		}
	});

	it('fails a later round without requeueing, carrying the best report so far', async () => {
		const { h, plan } = harness({
			n: 1,
			generate: (call) =>
				call === 1
					? Promise.resolve(image(7))
					: Promise.reject(new ImageBackendError('unreachable', 'gone'))
		});
		cut.rounds = [[bad(1)]];
		await runSheet(plan, h.ctx);
		expect(h.requeued).toEqual([]);
		const r = outcomeOf(h, 0);
		expect(r.outcome).toMatchObject({ status: 'failed', attempts: 2, reason: 'gone' });
		expect(r.report?.failed).toEqual(['entropy']);
	});

	it('rethrows a cancellation from the backend', async () => {
		const { h, plan } = harness({
			generate: () => Promise.reject(new ImageBackendError('cancelled', 'stopped'))
		});
		await expect(runSheet(plan, h.ctx)).rejects.toThrow('stopped');
		expect(h.recorded).toEqual([]);
	});

	it('stops before generating when the run is already cancelled', async () => {
		const { h, plan } = harness();
		h.controller.abort();
		await expect(runSheet(plan, h.ctx)).rejects.toMatchObject({ name: 'AbortError' });
		expect(h.prompts).toEqual([]);
	});

	it('uses the pregenerated anchor sheet as round one, unpadded', async () => {
		const { h, plan } = harness({ pregenerated: new Map([['sheet-1', image(55)]]) });
		cut.rounds = [[ok(1), ok(2)]];
		await runSheet(plan, h.ctx);
		expect(h.prompts).toEqual([]);
		expect(outcomeOf(h, 0).outcome.seed).toBe(55);
		expect(cut.sizes).toEqual([2]);
	});

	it('generates afresh when part of the anchor sheet is already on disk', async () => {
		const { h, plan } = harness({
			present: ['out/e0.png'],
			pregenerated: new Map([['sheet-1', image(55)]])
		});
		cut.rounds = [[ok(1), ok(99)]];
		await runSheet(plan, h.ctx);
		expect(h.prompts).toHaveLength(1);
		expect(outcomeOf(h, 1).outcome.seed).toBe(101);
	});
});
