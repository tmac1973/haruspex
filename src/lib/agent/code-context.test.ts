import { describe, it, expect } from 'vitest';
import { isCodeContext } from '$lib/agent/loop';
import type { ChatMessage } from '$lib/api';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistantToolCalls = (calls: Array<{ name: string; args: object }>): ChatMessage => ({
	role: 'assistant',
	content: '',
	tool_calls: calls.map((c, i) => ({
		id: `id-${i}`,
		type: 'function',
		function: { name: c.name, arguments: JSON.stringify(c.args) }
	}))
});
const toolResult = (id: string, content: string): ChatMessage => ({
	role: 'tool',
	tool_call_id: id,
	content
});

describe('isCodeContext', () => {
	it('returns false for an empty conversation', () => {
		expect(isCodeContext([])).toBe(false);
	});

	it('returns false for a plain user turn', () => {
		expect(isCodeContext([user('what is 2+2?')])).toBe(false);
	});

	it('detects code context from a Python <diagnostics> tool result', () => {
		const messages: ChatMessage[] = [
			user('write bug.py'),
			assistantToolCalls([{ name: 'fs_write_text', args: { path: 'bug.py' } }]),
			toolResult(
				'id-0',
				'Wrote: bug.py\n\n<diagnostics file="bug.py">\nF821 [2:5] Undefined name `prnt`\n</diagnostics>'
			)
		];
		expect(isCodeContext(messages)).toBe(true);
	});

	it('ignores <diagnostics> blocks on non-Python files', () => {
		// We only ship Python diagnostics today, but be future-proof in
		// case some other tool adds a diagnostics envelope for, say, JSON.
		const messages: ChatMessage[] = [
			user('write config'),
			assistantToolCalls([{ name: 'fs_write_text', args: { path: 'config.json' } }]),
			toolResult('id-0', 'Wrote: config.json\n\n<diagnostics file="config.json">err</diagnostics>')
		];
		expect(isCodeContext(messages)).toBe(false);
	});

	it('detects code context when the last tool call was run_python', () => {
		const messages: ChatMessage[] = [
			user('compute something'),
			assistantToolCalls([{ name: 'run_python', args: { code: '1+1' } }]),
			toolResult('id-0', 'result: 2')
		];
		expect(isCodeContext(messages)).toBe(true);
	});

	it('detects code context when fs_edit_text targets a .py file', () => {
		const messages: ChatMessage[] = [
			user('fix the typo'),
			assistantToolCalls([
				{ name: 'fs_edit_text', args: { path: 'bug.py', old_str: 'prnt', new_str: 'print' } }
			]),
			toolResult('id-0', 'Edited bug.py')
		];
		expect(isCodeContext(messages)).toBe(true);
	});

	it('does NOT flag fs_write_text on non-Python paths', () => {
		const messages: ChatMessage[] = [
			user('save notes'),
			assistantToolCalls([{ name: 'fs_write_text', args: { path: 'notes.md' } }]),
			toolResult('id-0', 'Wrote: notes.md')
		];
		expect(isCodeContext(messages)).toBe(false);
	});

	it('does NOT flag web-only tool turns', () => {
		const messages: ChatMessage[] = [
			user('research X'),
			assistantToolCalls([{ name: 'web_search', args: { query: 'X' } }]),
			toolResult('id-0', 'results...')
		];
		expect(isCodeContext(messages)).toBe(false);
	});

	it('case-insensitive on the .py extension', () => {
		const messages: ChatMessage[] = [
			user('weird'),
			assistantToolCalls([{ name: 'fs_write_text', args: { path: 'WEIRD.PY' } }]),
			toolResult('id-0', 'Wrote: WEIRD.PY')
		];
		expect(isCodeContext(messages)).toBe(true);
	});

	it('survives an unparseable tool-call arguments string', () => {
		const messages: ChatMessage[] = [
			user('broken'),
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'broken-1',
						type: 'function',
						function: { name: 'fs_write_text', arguments: 'not-json' }
					}
				]
			}
		];
		expect(isCodeContext(messages)).toBe(false);
	});

	it('walks past non-tool messages to find the most recent signal', () => {
		// Older python edit deeper in history shouldn't be ignored as long
		// as no newer non-code tool call has occurred since.
		const messages: ChatMessage[] = [
			user('fix bug.py'),
			assistantToolCalls([{ name: 'fs_edit_text', args: { path: 'bug.py' } }]),
			toolResult('id-0', 'Edited bug.py')
		];
		expect(isCodeContext(messages)).toBe(true);
	});

	it('a more recent non-code tool turn overrides an older code turn', () => {
		const messages: ChatMessage[] = [
			user('do two things'),
			assistantToolCalls([{ name: 'fs_edit_text', args: { path: 'bug.py' } }]),
			toolResult('id-0', 'Edited bug.py'),
			assistantToolCalls([{ name: 'web_search', args: { query: 'docs' } }]),
			toolResult('id-1', 'results...')
		];
		// Most recent assistant tool call was a web search → not code context.
		expect(isCodeContext(messages)).toBe(false);
	});
});
