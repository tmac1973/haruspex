import { beforeEach, describe, expect, it } from 'vitest';
import {
	noteRunToolCall,
	reflectionPrompt,
	reportTrace,
	takeRunTrace
} from '#lib/harnessFeedback/reflection.ts';
import { traceFromMessages } from '#lib/harnessFeedback/report.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import type { ChatMessage } from '#lib/api.ts';

const run = {
	jobName: 'Nightly',
	jobType: 'research',
	goal: 'Find news',
	status: 'succeeded',
	error: null
};

beforeEach(() => {
	updateSettings({ agentFeedbackEnabled: true });
	takeRunTrace(1);
});

describe("a run's trace", () => {
	it('is not kept while the setting is off', () => {
		updateSettings({ agentFeedbackEnabled: false });
		noteRunToolCall(1, 'web_search', { q: 'x' }, 'ok');
		expect(takeRunTrace(1)).toBeNull();
	});

	it('leaves out reports themselves, and is gone once taken', () => {
		noteRunToolCall(1, 'web_search', { q: 'x' }, 'ok');
		noteRunToolCall(1, 'haruspex_feedback', {}, 'Recorded.');
		const trace = takeRunTrace(1)!;
		expect(trace.calls.map((c) => c.tool)).toEqual(['web_search']);
		expect(takeRunTrace(1)).toBeNull();
	});

	it('keeps failed calls over successful ones when it fills', () => {
		noteRunToolCall(1, 'fetch_url', { url: 'u' }, '{"error":"403"}');
		for (let i = 0; i < 80; i++) noteRunToolCall(1, 'web_search', { q: i }, 'ok');
		const trace = takeRunTrace(1)!;
		expect(trace.total).toBe(81);
		expect(trace.calls).toHaveLength(60);
		expect(trace.calls[0]).toMatchObject({ tool: 'fetch_url', error: true });
		expect(trace.byTool.get('web_search')).toEqual({ calls: 80, errors: 0 });
		expect(trace.byTool.get('fetch_url')).toEqual({ calls: 1, errors: 1 });
	});

	it('gives each report the failures first, then the latest calls', () => {
		for (let i = 0; i < 20; i++) noteRunToolCall(1, 'web_search', { q: i }, 'ok');
		noteRunToolCall(1, 'fetch_url', { url: 'u' }, '{"error":"403"}');
		const attached = reportTrace(takeRunTrace(1)!);
		expect(attached).toHaveLength(10);
		expect(attached[0].tool).toBe('fetch_url');
		expect(attached.at(-1)!.args).toBe('{"q":19}');
	});
});

describe('the reflection prompt', () => {
	it('names the job, its outcome and each call', () => {
		noteRunToolCall(1, 'fetch_url', { url: 'u' }, '{"error":"403"}');
		noteRunToolCall(1, 'web_search', { q: 'x' }, 'ok');
		const prompt = reflectionPrompt(
			{ ...run, status: 'failed', error: 'no sources' },
			takeRunTrace(1)!
		);
		expect(prompt).toContain('Nightly (research)');
		expect(prompt).toContain('Find news');
		expect(prompt).toContain('failed: no sources');
		expect(prompt).toContain('- fetch_url: 1 call, 1 failed');
		expect(prompt).toContain('### 1. fetch_url (failed)');
		expect(prompt).toContain('### 2. web_search\nArguments: {"q":"x"}\nResult: ok');
	});
});

describe('traceFromMessages', () => {
	it('pairs each call with its result, newest last, and shortens long ones', () => {
		const long = 'x'.repeat(5000);
		const messages: ChatMessage[] = [
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{ id: '1', type: 'function', function: { name: 'fs_read_text', arguments: '{}' } },
					{ id: '2', type: 'function', function: { name: 'run_command', arguments: '{}' } }
				]
			},
			{ role: 'tool', tool_call_id: '1', content: long },
			{ role: 'tool', tool_call_id: '2', content: JSON.stringify({ error: long }) }
		];
		const [read, cmd] = traceFromMessages(messages);
		expect(read.error).toBe(false);
		expect(read.result.length).toBeLessThan(1600);
		expect(cmd.error).toBe(true);
		expect(cmd.result.length).toBeGreaterThan(3999);
		expect(traceFromMessages(messages, 1).map((t) => t.tool)).toEqual(['run_command']);
	});

	it('keeps earlier failures of the reported tool that fell out of the window', () => {
		const call = (id: string, name: string) => ({
			id,
			type: 'function' as const,
			function: { name, arguments: '{}' }
		});
		const messages: ChatMessage[] = [
			{ role: 'assistant', content: '', tool_calls: [call('a', 'fs_read_text')] },
			{ role: 'tool', tool_call_id: 'a', content: '{"error":"path escapes working directory"}' },
			...['b', 'c', 'd'].flatMap((id): ChatMessage[] => [
				{ role: 'assistant', content: '', tool_calls: [call(id, 'web_search')] },
				{ role: 'tool', tool_call_id: id, content: 'ok' }
			])
		];
		expect(traceFromMessages(messages, 2).map((t) => t.tool)).toEqual(['web_search', 'web_search']);
		expect(traceFromMessages(messages, 2, 'fs_read_text').map((t) => t.tool)).toEqual([
			'fs_read_text',
			'web_search',
			'web_search'
		]);
	});
});
