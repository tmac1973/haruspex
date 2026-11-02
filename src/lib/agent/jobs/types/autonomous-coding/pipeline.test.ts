import { describe, it, expect } from 'vitest';
import {
	applyStepCommit,
	capOutput,
	checkAssignedItem,
	commitTitle,
	formatCommandChange,
	phaseBuildShortfall,
	phaseTurnBudget,
	toChecklist
} from './pipeline';
import type { TaskItem } from './loopState';

/**
 * The pure decisions inside the loop: what an iteration's report is worth,
 * whether a phase build turn built anything, and how big its budget is. The
 * stage-by-stage behaviour is driven through the whole pipeline in
 * `pipeline.stages.test.ts` and `pipeline.loop.test.ts`.
 */

describe('checkAssignedItem', () => {
	it('keeps a report for the assigned item as it is', () => {
		expect(checkAssignedItem({ itemId: '03', status: 'done', note: 'ok' }, '03')).toEqual({
			status: 'done',
			note: 'ok'
		});
	});

	it('fails a "done" for some other item, keeping the original note', () => {
		const r = checkAssignedItem({ itemId: '05', status: 'done', note: 'did 05' }, '03');
		expect(r.status).toBe('failed');
		expect(r.note).toContain('"05" instead of the assigned item 03');
		expect(r.note).toContain('Original note: did 05');
	});
});

describe('applyStepCommit', () => {
	const commit = { changed: true, unsigned: false, commitSkipped: false };

	it('fails a "done" that changed nothing', () => {
		const r = applyStepCommit('all good', { ...commit, changed: false });
		expect(r.status).toBe('failed');
		expect(r.note).toMatch(/^Claimed done but changed nothing.*Original note: all good$/);
	});

	it('keeps a "done" that committed, and says when the commit is unsigned or skipped', () => {
		expect(applyStepCommit('n', commit)).toEqual({ status: 'done', note: 'n' });

		const unsigned = applyStepCommit('n', { ...commit, unsigned: true });
		expect(unsigned.status).toBe('done');
		expect(unsigned.note).toContain('commit made UNSIGNED');

		const skipped = applyStepCommit('n', { ...commit, commitSkipped: true });
		expect(skipped.status).toBe('done');
		expect(skipped.note).toContain('commit SKIPPED');
	});
});

describe('phaseBuildShortfall', () => {
	it('counts a write outside the plan dir, or a dirty tree, as having built', () => {
		expect(phaseBuildShortfall('Built it.', 1, false, 'plan/x/')).toBeNull();
		expect(phaseBuildShortfall('Built it.', 0, true, 'plan/x/')).toBeNull();
		// Git off: dirty is null, and the turn's own writes are the evidence.
		expect(phaseBuildShortfall('Built it.', 2, null, 'plan/x/')).toBeNull();
	});

	it('refuses a turn that changed nothing, whatever it says', () => {
		expect(phaseBuildShortfall('Phase complete.', 0, false, 'plan/x/')).toBe(
			'the turn changed nothing outside plan/x/'
		);
		expect(phaseBuildShortfall('Phase complete.', 0, null, 'plan/x/')).toBe(
			'the turn changed nothing outside plan/x/'
		);
	});

	it('believes a turn that opens by saying it did not build the phase', () => {
		for (const note of [
			'NOT IMPLEMENTED — ran out of budget',
			'** Stuck on the linker',
			'Nothing was written this turn',
			'No code written.',
			'Blocked: missing dependency'
		]) {
			expect(phaseBuildShortfall(note, 3, true, 'plan/x/'), note).toBe(
				'the turn reported that it did not implement the phase'
			);
		}
	});

	it('does not trip on those words in the middle of a summary of real work', () => {
		expect(
			phaseBuildShortfall('Replaced the `not implemented` macro with code.', 1, true, 'plan/x/')
		).toBeNull();
		expect(phaseBuildShortfall('Unblocked the parser.', 1, true, 'plan/x/')).toBeNull();
	});
});

describe('phaseTurnBudget', () => {
	it('grows with the items still to do', () => {
		expect(phaseTurnBudget(200, 1)).toBe(60);
		expect(phaseTurnBudget(200, 5)).toBe(140);
	});

	it('stops at twice one coding turn’s budget', () => {
		expect(phaseTurnBudget(200, 30)).toBe(400);
		expect(phaseTurnBudget(50, 10)).toBe(100);
	});
});

describe('formatCommandChange', () => {
	it('is null when the command is the same', () => {
		expect(formatCommandChange('npm test', 'npm test')).toBeNull();
		expect(formatCommandChange(null, null)).toBeNull();
	});

	it('shows both sides, naming a missing command', () => {
		expect(formatCommandChange('npm test', 'npm run test')).toBe(
			'- phase verification: `npm test` → `npm run test`'
		);
		expect(formatCommandChange('npm test', null)).toBe(
			'- phase verification: `npm test` → `(none)`'
		);
	});
});

describe('commitTitle', () => {
	it('strips what would break out of `git commit -m "…"`', () => {
		expect(commitTitle('Add "quoted" `cmd` $HOME \\ path\nnext')).toBe(
			'Add quoted cmd HOME  pathnext'
		);
	});

	it('bounds the length, and never leaves the title empty', () => {
		expect(commitTitle('x'.repeat(100))).toHaveLength(60);
		expect(commitTitle('"$`')).toBe('coding step');
	});
});

describe('capOutput', () => {
	it('keeps the front of a long output and says where the rest is', () => {
		expect(capOutput('short')).toBe('short');
		const long = `summary line\n${'x'.repeat(40_000)}`;
		const capped = capOutput(long);
		expect(capped.startsWith('summary line\n')).toBe(true);
		expect(capped.length).toBeLessThan(31_000);
		expect(capped).toContain('the full log lives in PROGRESS-coding.md');
	});
});

describe('toChecklist', () => {
	const item = (over: Partial<TaskItem>): TaskItem => ({
		id: '01',
		title: 'One',
		description: '',
		status: 'todo',
		attempts: 0,
		...over
	});

	it('shows the running item’s next attempt and a blocked item’s count', () => {
		const list = toChecklist(
			[
				item({ id: '01', status: 'done' }),
				item({ id: '02', attempts: 1 }),
				item({ id: '03', status: 'blocked', attempts: 3 }),
				item({ id: '04' })
			],
			'02',
			3
		);
		expect(list).toEqual([
			{ label: '01. One', status: 'done', detail: undefined },
			{ label: '02. One', status: 'running', detail: 'attempt 2/3' },
			{ label: '03. One', status: 'blocked', detail: 'blocked after 3 attempt(s)' },
			{ label: '04. One', status: 'todo', detail: undefined }
		]);
	});
});
