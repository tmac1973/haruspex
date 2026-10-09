import { describe, it, expect } from 'vitest';
import {
	describePendingCall,
	dropPendingCall,
	formatBytes,
	partialJsonString,
	upsertPendingCall,
	type PendingToolCall
} from '#lib/code/pendingCall.ts';

describe('partialJsonString', () => {
	it('reads a finished value', () => {
		expect(partialJsonString('{"path": "src/a.ts", "x": 1}', 'path')).toBe('src/a.ts');
	});

	it('reads a value cut off mid-string', () => {
		expect(partialJsonString('{"path":"src/a.ts","content":"line one\\nline t', 'content')).toBe(
			'line one\nline t'
		);
	});

	it('is null before the key or its string has started', () => {
		expect(partialJsonString('{"pa', 'path')).toBeNull();
		expect(partialJsonString('{"path":', 'path')).toBeNull();
		expect(partialJsonString('{"path": ', 'path')).toBeNull();
	});

	it('is empty once the opening quote is in', () => {
		expect(partialJsonString('{"path": "', 'path')).toBe('');
	});

	it('decodes escapes and leaves off one split by the cut', () => {
		expect(partialJsonString('{"command":"echo \\"hi\\" \\u00e9', 'command')).toBe('echo "hi" é');
		expect(partialJsonString('{"command":"echo \\', 'command')).toBe('echo ');
		expect(partialJsonString('{"command":"a\\u00', 'command')).toBe('a');
	});

	it('does not take a value for a key', () => {
		expect(partialJsonString('{"content":"\\"path\\": \\"x\\""}', 'path')).toBeNull();
	});
});

describe('describePendingCall', () => {
	it('shows a write with its path and size so far', () => {
		const content = 'x'.repeat(4300);
		expect(
			describePendingCall({
				name: 'fs_write_text',
				argsSoFar: `{"path":"src/foo.ts","content":"${content}`
			})
		).toEqual({ verb: 'Writing', path: 'src/foo.ts', size: '4.2 KB' });
	});

	it('shows a write before its path arrives', () => {
		expect(describePendingCall({ name: 'fs_write_text', argsSoFar: '{"pa' })).toEqual({
			verb: 'Writing',
			path: undefined,
			size: undefined
		});
	});

	it('shows an edit with its path', () => {
		expect(
			describePendingCall({ name: 'fs_edit_text', argsSoFar: '{"path":"a.py","old_str":"x' })
		).toEqual({ verb: 'Editing', path: 'a.py' });
	});

	it('shows a command once it has started to arrive', () => {
		expect(describePendingCall({ name: 'run_command', argsSoFar: '{"comm' })).toEqual({
			verb: 'Preparing command…'
		});
		expect(describePendingCall({ name: 'run_command', argsSoFar: '{"command":"npm te' })).toEqual({
			verb: 'Preparing command…',
			command: 'npm te'
		});
	});

	it('names any other tool, or none before its name arrives', () => {
		expect(describePendingCall({ name: 'code_grep', argsSoFar: '' }).verb).toBe(
			'Calling code_grep…'
		);
		expect(describePendingCall({ argsSoFar: '' }).verb).toBe('Calling a tool…');
	});
});

describe('formatBytes', () => {
	it('picks a unit', () => {
		expect(formatBytes(812)).toBe('812 B');
		expect(formatBytes(4300)).toBe('4.2 KB');
		expect(formatBytes(1.3 * 1024 * 1024)).toBe('1.3 MB');
	});
});

describe('pending call lists', () => {
	const a: PendingToolCall = { index: 0, id: 'a', name: 'run_command', argsSoFar: '' };

	it('upsert by index, in index order', () => {
		let list = upsertPendingCall([], 1, { id: 'b', name: 'x', argsSoFar: '' });
		list = upsertPendingCall(list, 0, a);
		list = upsertPendingCall(list, 1, { id: 'b', name: 'x', argsSoFar: '{}' });
		expect(list.map((c) => [c.index, c.argsSoFar])).toEqual([
			[0, ''],
			[1, '{}']
		]);
	});

	it('drop the call that started, by id or else by name', () => {
		const b: PendingToolCall = { index: 1, name: 'fs_read_text', argsSoFar: '' };
		expect(dropPendingCall([a, b], { id: 'a', name: 'run_command' })).toEqual([b]);
		expect(dropPendingCall([a, b], { id: 'zz', name: 'fs_read_text' })).toEqual([a]);
		expect(dropPendingCall([a, b], { id: 'zz', name: 'other' })).toEqual([a, b]);
	});
});
