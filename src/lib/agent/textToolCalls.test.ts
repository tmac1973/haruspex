import { describe, it, expect } from 'vitest';
import { splitRoundForDisplay, splitTextToolCalls, toolRoundText } from './textToolCalls';

describe('splitTextToolCalls', () => {
	it('cuts a finished <tool_call> block out and reads its call', () => {
		const res = splitTextToolCalls(
			'I will read it.\n<tool_call>\n{"name": "fs_read_text", "arguments": {"path": "a.ts"}}\n</tool_call>'
		);
		expect(res.text).toBe('I will read it.\n');
		expect(res.calls).toEqual([{ name: 'fs_read_text', argsSoFar: '{"path": "a.ts"}}\n' }]);
	});

	it('hides a block still being written, and reads the name once it is whole', () => {
		expect(splitTextToolCalls('Fixing.\n<tool_call>\n{"na')).toEqual({
			text: 'Fixing.\n',
			calls: []
		});
		expect(splitTextToolCalls('Fixing.\n<tool_call>\n{"name": "fs_write')).toEqual({
			text: 'Fixing.\n',
			calls: []
		});
		const res = splitTextToolCalls(
			'Fixing.\n<tool_call>\n{"name": "fs_write_text", "arguments": {"path": "b.py", "content": "x = '
		);
		expect(res.text).toBe('Fixing.\n');
		expect(res.calls).toEqual([
			{ name: 'fs_write_text', argsSoFar: '{"path": "b.py", "content": "x = ' }
		]);
	});

	it('hides a call marker cut off at the end', () => {
		expect(splitTextToolCalls('Running it.\n<tool_ca').text).toBe('Running it.\n');
		expect(splitTextToolCalls('Running it.\n<function=').text).toBe('Running it.\n');
		expect(splitTextToolCalls('Running it.\n<fun').text).toBe('Running it.\n');
		// Ordinary text with a `<` is left alone.
		expect(splitTextToolCalls('if a <b> or x < y').text).toBe('if a <b> or x < y');
	});

	it('reads the function form, alone or inside <tool_call>, parameters as JSON', () => {
		const alone = splitTextToolCalls(
			'Run it.\n<function=run_command>\n<parameter=command>\npython main.py\n</parameter>\n</function>\nThen check.'
		);
		expect(alone.text).toBe('Run it.\n\nThen check.');
		expect(alone.calls).toEqual([
			{ name: 'run_command', argsSoFar: JSON.stringify({ command: 'python main.py' }) }
		]);

		const wrapped = splitTextToolCalls(
			'<tool_call>\n<function=fs_write_text>\n<parameter=path>\nmain.py\n</parameter>\n<parameter=content>\nprint(1'
		);
		expect(wrapped.text).toBe('');
		expect(wrapped.calls).toEqual([
			{ name: 'fs_write_text', argsSoFar: JSON.stringify({ path: 'main.py', content: 'print(1' }) }
		]);

		// The name is not read until its tag closes.
		expect(splitTextToolCalls('<function=run_comm').calls).toEqual([]);
	});

	it('reads several calls in order', () => {
		const res = splitTextToolCalls(
			'<tool_call>{"name": "a", "arguments": {}}</tool_call>\n<tool_call>{"name": "b", "arguments": {}}</tool_call>'
		);
		expect(res.calls.map((c) => c.name)).toEqual(['a', 'b']);
		expect(res.text).toBe('\n');
	});
});

describe('toolRoundText', () => {
	it('keeps only what the model said: no reasoning, no calls', () => {
		expect(
			toolRoundText(
				'<think>plan</think>\n\nThe bug is the off-by-one.\n<tool_call>{"name": "x", "arguments": {}}</tool_call>'
			)
		).toBe('The bug is the off-by-one.');
		expect(toolRoundText(null)).toBe('');
		expect(toolRoundText('<think>only thinking</think>')).toBe('');
	});
});

describe('splitRoundForDisplay', () => {
	it('leaves reasoning alone and cuts calls from the text after it', () => {
		const res = splitRoundForDisplay(
			'<think>Mention <tool_call> here</think>\n\nFixing.\n<tool_call>{"name": "run_command", "arguments": {"command": "ls'
		);
		expect(res.text).toBe('<think>Mention <tool_call> here</think>\n\nFixing.\n');
		expect(res.calls).toEqual([{ name: 'run_command', argsSoFar: '{"command": "ls' }]);
	});

	it('leaves a round that is still reasoning as it is', () => {
		expect(splitRoundForDisplay('<think>Use <tool_call> for')).toEqual({
			text: '<think>Use <tool_call> for',
			calls: []
		});
	});
});
