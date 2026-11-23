import { describe, it, expect, vi } from 'vitest';
import { joinWindows, speakLines, speechMap, type SpeechDeps } from './speech';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { emptyProgress } from '#lib/sequence/spec/progress.ts';
import { LTX, S2V_10S, presenterSpec } from '#lib/testing/sequenceSpecs.ts';

function deps(lengths: Record<string, number> = {}) {
	const files = new Set<string>();
	let n = 0;
	const d = {
		speak: vi.fn(async (text: string) => ({ hash: `take-${++n}`, secs: lengths[text] ?? 3 })),
		save: vi.fn(async (_h: string, rel: string) => {
			files.add(rel);
		}),
		exists: vi.fn(async (rel: string) => files.has(rel)),
		silences: vi.fn(async () => [{ start: 1, end: 1.2 }]),
		join: vi.fn(async (_p: unknown, out: string) => {
			files.add(out);
		}),
		saveProgress: vi.fn(async () => {}),
		status: vi.fn()
	} satisfies SpeechDeps;
	return { d, files };
}

describe('the Speech stage', () => {
	it('speaks each line into its file, with its length and pauses', async () => {
		const { d } = deps({ 'Then they jump.': 1.4 });
		const progress = emptyProgress('x');
		expect(await speakLines(presenterSpec(), progress, d)).toBe(3);
		expect(progress.speech?.l3).toEqual({
			file: 'narration/host-line-03.wav',
			secs: 1.4,
			hash: 'take-3',
			text: 'Then they jump.',
			voice: '',
			silences: [{ start: 1, end: 1.2 }]
		});
		expect(d.speak).toHaveBeenCalledWith('They hear a mouse under a metre of snow.', 'Tim');
		expect(d.save).toHaveBeenCalledWith('take-1', 'narration/host-line-01.wav');
	});

	it('speaks nothing on a re-run, and plans the same windows', async () => {
		const { d } = deps();
		const progress = emptyProgress('x');
		await speakLines(presenterSpec(), progress, d);
		const before = planClips(presenterSpec(), LTX, true, {
			limits: S2V_10S,
			speech: speechMap(progress)
		});
		d.speak.mockClear();
		expect(await speakLines(presenterSpec(), progress, d)).toBe(0);
		expect(d.speak).not.toHaveBeenCalled();
		const after = planClips(presenterSpec(), LTX, true, {
			limits: S2V_10S,
			speech: speechMap(progress)
		});
		expect(after).toEqual(before);
	});

	it('speaks a changed line again, rejoins its window and changes that window only', async () => {
		const { d } = deps({ 'Foxes hunt by sound.': 4, 'Then they jump.': 9 });
		const progress = emptyProgress('x');
		const spec = presenterSpec();
		await speakLines(spec, progress, d);
		const plan = (s: typeof spec) =>
			planClips(s, LTX, true, { limits: S2V_10S, speech: speechMap(progress) });
		const first = plan(spec);
		expect(await joinWindows(first, progress, d)).toBe(2);
		expect(await joinWindows(first, progress, d)).toBe(0);
		const changed = presenterSpec();
		const host = changed.sections[1];
		if (host.kind !== 'speaking') throw new Error('no host');
		host.lines[2].voice = 'Narrator';
		expect(await speakLines(changed, progress, d)).toBe(1);
		const second = plan(changed);
		const win = (p: typeof first, id: string) => p.items.find((i) => i.id === id);
		expect(win(second, 'host-01')).toEqual(win(first, 'host-01'));
		expect(win(second, 'host-02')).not.toEqual(win(first, 'host-02'));
		expect(await joinWindows(second, progress, d)).toBe(1);
	});
});
