import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { RecallArchive } from '#lib/agent/recallArchive.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const NAME = 'recall_result';

function archiveWith(text: string): RecallArchive {
	const archive = new RecallArchive();
	archive.keep('c1', 'run_command(npm test)', text);
	return archive;
}

const recall = (args: Record<string, unknown>, archive?: RecallArchive) =>
	executeTool(NAME, args, makeToolContext({ recallArchive: archive }));

describe('recall_result', () => {
	const offered = (opts: Parameters<typeof getToolSchemas>[0]) =>
		getToolSchemas(opts).some((s) => s.function.name === NAME);

	it('is offered in Chat, Shell and Code, but not to a job that does not name it', () => {
		for (const mode of [
			{},
			{ shellMode: true },
			{ codeMode: true },
			{ shellMode: true, codeMode: true }
		]) {
			expect(offered({ hasWorkingDir: true, interactive: true, ...mode })).toBe(true);
		}
		expect(offered({ hasWorkingDir: true, toolAllowlist: ['fetch_url'] })).toBe(false);
		expect(offered({ hasWorkingDir: true, toolAllowlist: ['fetch_url', NAME] })).toBe(true);
	});

	const fileOf = (n: number, width = 40) =>
		Array.from(
			{ length: n },
			(_, i) => `${String(i + 1).padStart(4, '0')} ${'x'.repeat(width)}`
		).join('\n');

	it('returns lines from a 1-indexed offset, as fs_read_text counts them', async () => {
		const text = fileOf(900);
		const out = (await recall({ id: 'r1', offset: 587, limit: 3 }, archiveWith(text))).result;
		expect(out).toContain('Result r1 (run_command(npm test)), lines 587–589 of 900:');
		expect(out).toContain('\n\n0587 x');
		expect(out).toContain('0589 x');
		expect(out).not.toContain('0590 x');
		expect(out).toContain('[More: recall_result id="r1" offset=590]');
	});

	it('pages a long result by whole lines', async () => {
		const text = fileOf(900);
		const first = (await recall({ id: 'r1' }, archiveWith(text))).result;
		const m = /lines 1–(\d+) of 900/.exec(first)!;
		const last = Number(m[1]);
		expect(last).toBeGreaterThan(300);
		expect(last).toBeLessThan(900);
		expect(first).toContain(`[More: recall_result id="r1" offset=${last + 1}]`);
		const rest = (await recall({ id: 'r1', offset: last + 1 }, archiveWith(text))).result;
		expect(rest).toContain(`lines ${last + 1}–`);
		expect(rest).toContain(`\n\n${String(last + 1).padStart(4, '0')} x`);
		const tail = (await recall({ id: 'r1', offset: 890 }, archiveWith(text))).result;
		expect(tail.endsWith('0900 ' + 'x'.repeat(40))).toBe(true);
		expect(tail).not.toContain('[More:');
	});

	it('gives the start of a line longer than a page', async () => {
		const out = (await recall({ id: 'r1' }, archiveWith('a'.repeat(40_000)))).result;
		expect(out).toContain('the start of line 1 of 1:');
		expect(out).toContain('narrow it with pattern');
	});

	it('sizes a page to the room the round has, then refuses once it is used', async () => {
		const archive = new RecallArchive();
		archive.keep('c1', 'fs_read_text(a.py)', fileOf(900));
		archive.keep('c2', 'fs_read_text(b.py)', fileOf(900));
		// About 7K characters of room: less than a page.
		archive.startRound(2_000);
		const first = (await recall({ id: 'r1' }, archive)).result;
		expect(first.length).toBeLessThan(7_300);
		expect(first.length).toBeGreaterThan(6_000);
		const refused = (await recall({ id: 'r2' }, archive)).result;
		expect(refused).toMatch(/"error":"Not read: .*Recall \\"r2\\" in a later call/);
		archive.startRound(2_000);
		expect((await recall({ id: 'r2' }, archive)).result).toContain('Result r2');
	});

	it('still gives the first recall of a round a small page when there is no room', async () => {
		const archive = archiveWith(fileOf(900));
		archive.startRound(0);
		const out = (await recall({ id: 'r1' }, archive)).result;
		expect(out).toContain('Result r1');
		expect(out.length).toBeLessThan(2_300);
	});

	it('returns only the matching lines, numbered, with a little around them', async () => {
		const lines = Array.from({ length: 900 }, (_, i) =>
			i === 611 ? '[0611] release token: TOKEN-4be2' : `[${i}] synced ok`
		);
		const out = (await recall({ id: 'r1', pattern: 'token' }, archiveWith(lines.join('\n'))))
			.result;
		expect(out).toContain('1 of 900 lines contain "token"');
		expect(out).toContain('612: [0611] release token: TOKEN-4be2');
		expect(out).toContain('610: [609] synced ok');
		expect(out).not.toContain('600: ');
	});

	it('says why when there is nothing to recall', async () => {
		const none = JSON.parse((await recall({ id: 'r1' })).result).error;
		expect(none).toContain('Nothing has been trimmed');
		const unknown = JSON.parse((await recall({ id: 'r9' }, archiveWith('x'))).result).error;
		expect(unknown).toContain('No trimmed result "r9"');
	});
});
