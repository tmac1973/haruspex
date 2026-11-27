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

	it('refuses a recall that would overfill the round, then allows it next round', async () => {
		// Two 16K-char pages are about 9K estimated tokens; the cap holds one.
		const archive = new RecallArchive(6_000);
		archive.keep('c1', 'fs_read_text(a.py)', 'a'.repeat(16_000));
		archive.keep('c2', 'fs_read_text(b.py)', 'b'.repeat(16_000));
		archive.startRound();
		expect((await recall({ id: 'r1' }, archive)).result).toContain('aaaa');
		const refused = (await recall({ id: 'r2' }, archive)).result;
		expect(refused).toMatch(/"error":"Not read: .*Recall \\"r2\\" in a later call/);
		archive.startRound();
		expect((await recall({ id: 'r2' }, archive)).result).toContain('bbbb');
	});

	it('returns the exact text, a page at a time', async () => {
		const text = 'a'.repeat(16_000) + 'TAIL';
		const first = (await recall({ id: 'r1' }, archiveWith(text))).result;
		expect(first).toContain('Result r1 (run_command(npm test)), characters 0–16000 of 16004:');
		expect(first).toContain('[More: recall_result id="r1" offset=16000]');
		const next = (await recall({ id: 'r1', offset: 16_000 }, archiveWith(text))).result;
		expect(next.endsWith('\n\nTAIL')).toBe(true);
		expect(next).not.toContain('[More:');
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
