import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import '#lib/agent/tools/haruspex-feedback.ts';
import { MAX_REPORTS_PER_TURN } from '#lib/agent/tools/haruspex-feedback.ts';
import { executeTool, getToolSchemas } from '#lib/agent/tools/registry.ts';
import { REMOTE_TOOLS } from '#lib/remote/driver.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { ChatMessage } from '#lib/api.ts';
import type { FeedbackEntry } from '#lib/harnessFeedback/report.ts';

const NAME = 'haruspex_feedback';

const offered = (opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).some((s) => s.function.name === NAME);

const report = {
	tool: 'fs_edit_text',
	kind: 'unclear_error',
	what_happened: 'The edit failed with "no match" though the text was there.',
	expected: 'To be told the file has CRLF line endings.'
};

/** The turn so far: one failed edit, then the feedback call itself. */
const transcript: ChatMessage[] = [
	{ role: 'user', content: 'fix it' },
	{
		role: 'assistant',
		content: '',
		tool_calls: [
			{
				id: 'a',
				type: 'function',
				function: { name: 'fs_edit_text', arguments: '{"path":"x.ts"}' }
			}
		]
	},
	{ role: 'tool', tool_call_id: 'a', content: '{"error":"no match"}' },
	{
		role: 'assistant',
		content: '',
		tool_calls: [{ id: 'b', type: 'function', function: { name: NAME, arguments: '{}' } }]
	}
];

const written = () => mocks.invoke.mock.calls.at(-1)?.[1].entry as FeedbackEntry;

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.invoke.mockResolvedValue('/data/agent_feedback/2026-10.jsonl');
	updateSettings({ agentFeedbackEnabled: false });
});

describe('who gets haruspex_feedback', () => {
	it('nobody while the setting is off', () => {
		expect(offered({ hasWorkingDir: true, interactive: true })).toBe(false);
		expect(offered({ hasWorkingDir: false, toolAllowlist: [], harnessFeedback: true })).toBe(false);
	});

	it('every mode and subtasks once it is on', () => {
		updateSettings({ agentFeedbackEnabled: true });
		for (const mode of [
			{},
			{ shellMode: true },
			{ codeMode: true },
			{ shellMode: true, codeMode: true },
			{ codeMode: true, subtask: true },
			{ interactive: true }
		]) {
			expect(offered({ hasWorkingDir: true, ...mode })).toBe(true);
		}
	});

	it("a job's allowlisted turn, but not a remote guest's or memory's", () => {
		updateSettings({ agentFeedbackEnabled: true });
		expect(
			offered({ hasWorkingDir: false, toolAllowlist: ['web_search'], harnessFeedback: true })
		).toBe(true);
		expect(offered({ hasWorkingDir: false, toolAllowlist: REMOTE_TOOLS })).toBe(false);
		expect(offered({ hasWorkingDir: false, toolAllowlist: ['memory_search'] })).toBe(false);
	});
});

describe('a report', () => {
	it('is refused while the setting is off, whatever the model guessed', async () => {
		const out = await executeTool(NAME, report, makeToolContext());
		expect(JSON.parse(out.result).error).toContain('Settings → Feedback');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('is written with the calls that led to it', async () => {
		updateSettings({ agentFeedbackEnabled: true });
		const out = await executeTool(
			NAME,
			{ ...report, kind: 'made_up_kind' },
			makeToolContext({ codeMode: true, codeSessionId: 's1', transcript: () => transcript })
		);
		expect(out.result).toContain('Recorded');
		expect(mocks.invoke).toHaveBeenCalledWith('agent_feedback_append', expect.anything());
		const entry = written();
		expect(entry).toMatchObject({
			origin: 'tool',
			tool: 'fs_edit_text',
			kind: 'other',
			mode: 'code',
			source: 'code session s1'
		});
		expect(entry.trace).toEqual([
			{ tool: 'fs_edit_text', args: '{"path":"x.ts"}', result: '{"error":"no match"}', error: true }
		]);
	});

	it("takes a job's label and trace when the turn carries one", async () => {
		updateSettings({ agentFeedbackEnabled: true });
		const trace = [{ tool: 'web_search', args: '{}', result: 'ok', error: false }];
		await executeTool(
			NAME,
			report,
			makeToolContext({
				feedback: { source: 'job "x", run 3', origin: 'reflection', trace: () => trace },
				transcript: () => transcript
			})
		);
		expect(written()).toMatchObject({
			origin: 'reflection',
			mode: 'job-review',
			source: 'job "x", run 3',
			trace
		});
	});

	it(`stops after ${MAX_REPORTS_PER_TURN} in a turn`, async () => {
		updateSettings({ agentFeedbackEnabled: true });
		const turn = makeToolContext({ feedbackThisTurn: { count: 0 } });
		for (let i = 0; i < MAX_REPORTS_PER_TURN; i++) {
			expect((await executeTool(NAME, report, turn)).result).toContain('Recorded');
		}
		const over = await executeTool(NAME, report, turn);
		expect(JSON.parse(over.result).error).toContain('Enough reports');
		expect(mocks.invoke).toHaveBeenCalledTimes(MAX_REPORTS_PER_TURN);
	});

	it('lets the model carry on when it cannot be saved', async () => {
		updateSettings({ agentFeedbackEnabled: true });
		mocks.invoke.mockRejectedValue(new Error('disk full'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = await executeTool(NAME, report, makeToolContext());
		expect(out.result).toContain('Carry on');
		warn.mockRestore();
	});
});
