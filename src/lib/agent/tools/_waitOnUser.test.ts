import { describe, it, expect, vi } from 'vitest';
import { waitOnUser } from './_helpers';

// A tool that stops to ask the user gives its turn's slot back first
// (`waitOnUser`), so other turns use the model while the prompt is up. The
// guard below fails a tool module that asks without it.

const sources = import.meta.glob(['./*.ts', '!./*.test.ts'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** Calls that put a prompt in front of the user. */
const ASKS =
	/\b(askCommandApproval|askApproval|askMcpApproval|askSkillApproval|askMemoryApproval|askYoutubeUpload|askEmailReview|askUserQuestion)\(|ctx\.askUser!?\(/;

/** Each line of `text` matching `re`, as a 0-based index. */
function linesMatching(text: string, re: RegExp): number[] {
	return text.split('\n').flatMap((line, i) => (re.test(line) ? [i] : []));
}

/** Whether `needle` is on line `i` or one of the `before` lines above it. */
function nearAbove(lines: string[], i: number, needle: string, before: number): boolean {
	return lines.slice(Math.max(0, i - before), i + 1).some((l) => l.includes(needle));
}

describe('tools that wait on the user', () => {
	it('found the tool modules', () => {
		expect(Object.keys(sources).length).toBeGreaterThan(20);
	});

	for (const [file, text] of Object.entries(sources)) {
		const lines = text.split('\n');
		const asks = linesMatching(text, ASKS).filter((i) => !lines[i].trim().startsWith('import'));
		if (asks.length) {
			it(`${file} gives the slot back before it asks`, () => {
				for (const i of asks) {
					expect(nearAbove(lines, i, 'waitOnUser(', 1), `${file}:${i + 1}`).toBe(true);
				}
			});
		}
	}

	it('user-question.ts asks through waitOnUser', () => {
		const text = sources['./user-question.ts'];
		const lines = text.split('\n');
		const asks = linesMatching(text, /\bask\(/);
		expect(asks.length).toBeGreaterThan(0);
		for (const i of asks) expect(nearAbove(lines, i, 'waitOnUser(', 2)).toBe(true);
	});

	it('fs-write.ts releases before the overwrite prompt', () => {
		const text = sources['./fs-write.ts'];
		const lines = text.split('\n');
		const asks = linesMatching(text, /askFileConflict\(/).filter(
			(i) => !lines[i].includes('import(')
		);
		expect(asks.length).toBeGreaterThan(0);
		for (const i of asks) expect(nearAbove(lines, i, 'releaseSlot', 1)).toBe(true);
	});

	it('every overwrite-prompting write passes the release on', () => {
		// `fsWriteWithConflictCheck` hands its caller's `opts` through, so its
		// callers are the ones checked.
		const callers = /(resolveWritePathInteractive|fsWriteWithConflictCheck)\(/;
		for (const [file, text] of Object.entries(sources)) {
			const lines = text.split('\n');
			for (const i of linesMatching(text, callers)) {
				if (/function (resolveWritePathInteractive|fsWriteWithConflictCheck)/.test(lines[i]))
					continue;
				if (lines[i].trim().startsWith('import')) continue;
				// Inside `fsWriteWithConflictCheck`, forwarding the options it was given.
				if (lines[i].includes('filesWrittenThisTurn, opts)')) continue;
				const call = lines.slice(i, i + 8).join('\n');
				expect(
					call.includes('writeOptions(ctx)') || call.includes('releaseSlot'),
					`${file}:${i + 1}`
				).toBe(true);
			}
		}
	});
});

describe('waitOnUser', () => {
	it('gives the slot back before it asks', async () => {
		const order: string[] = [];
		const releaseSlot = vi.fn(() => order.push('release'));
		const answer = await waitOnUser({ releaseSlot }, async () => {
			order.push('ask');
			return 'yes';
		});
		expect(answer).toBe('yes');
		expect(order).toEqual(['release', 'ask']);
	});

	it('just asks with no slot to give back', async () => {
		await expect(waitOnUser({}, async () => 'yes')).resolves.toBe('yes');
	});
});
