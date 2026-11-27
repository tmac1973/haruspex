import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { RecallArchive, archivedStub, keepResult } from './recallArchive';

const call = (id: string, name: string, args = '{}'): ChatMessage => ({
	role: 'assistant',
	content: '',
	tool_calls: [{ id, type: 'function', function: { name, arguments: args } }]
});
const result = (id: string, content: string): ChatMessage => ({
	role: 'tool',
	content,
	tool_call_id: id
});

describe('RecallArchive', () => {
	it('gives each kept result its own id, and one id per call', () => {
		const a = new RecallArchive();
		expect(a.keep('c1', 'run_command(npm test)', 'whole text')).toBe('r1');
		expect(a.keep('c2', 'fs_read_text(a.ts)', 'other')).toBe('r2');
		// Cut first, stubbed later: the first, whole text stays.
		expect(a.keep('c1', 'run_command(npm test)', 'cut text')).toBe('r1');
		expect(a.get('r1')?.text).toBe('whole text');
		expect(a.get(' r2 ')?.call).toBe('fs_read_text(a.ts)');
		expect(a.size).toBe(2);
	});

	it("tracks one round's room, and has none to track by default", () => {
		const a = new RecallArchive();
		expect(a.roomLeft).toBe(Infinity);
		a.startRound(10_000);
		expect(a.recalledThisRound).toBe(false);
		a.spend(6_000);
		expect(a.roomLeft).toBe(4_000);
		expect(a.recalledThisRound).toBe(true);
		a.spend(6_000);
		expect(a.roomLeft).toBe(0);
		a.startRound(10_000);
		expect(a.roomLeft).toBe(10_000);
		expect(a.recalledThisRound).toBe(false);
	});
});

describe('keepResult', () => {
	const messages = [call('c1', 'run_command'), result('c1', 'Exit code: 0 (5ms)\nok')];

	it('keeps a tool result when there is an archive', () => {
		const a = new RecallArchive();
		expect(keepResult(a, messages, 1, 'Exit code: 0 (5ms)\nok', 'run_command')).toBe('r1');
		expect(archivedStub(a, 'r1')).toMatch(
			/^\[Trimmed to free context: the result of run_command\. 2 lines, .*Exit code 0\. .*recall_result id="r1"\.\]$/
		);
	});

	it('keeps nothing without an archive, or for a recall_result reply', () => {
		expect(keepResult(undefined, messages, 1, 'x', 'run_command')).toBeNull();
		const recalled = [call('c2', 'recall_result', '{"id":"r1"}'), result('c2', 'text')];
		expect(keepResult(new RecallArchive(), recalled, 1, 'text', 'recall_result(r1)')).toBeNull();
	});
});
