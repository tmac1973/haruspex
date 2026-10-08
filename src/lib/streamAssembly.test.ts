import { describe, it, expect } from 'vitest';
import type { StreamChunk } from '#lib/api.ts';
import { StreamResponseAssembler, combineReasoningAndContent } from '#lib/streamAssembly.ts';

const c = (delta: StreamChunk['delta'], finish_reason: string | null = null): StreamChunk => ({
	delta,
	finish_reason
});

function assemble(chunks: StreamChunk[]) {
	const a = new StreamResponseAssembler();
	for (const ch of chunks) a.push(ch);
	return a.finish();
}

describe('StreamResponseAssembler', () => {
	it('assembles parallel tool calls by index, interleaved', () => {
		const res = assemble([
			c({
				tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'fs_read_text' } }]
			}),
			c({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'code_grep' } }] }),
			c({ tool_calls: [{ index: 1, function: { arguments: '{"pattern":' } }] }),
			c({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }),
			c({ tool_calls: [{ index: 1, function: { arguments: '"foo"}' } }] }),
			c({}, 'tool_calls')
		]);
		expect(res.tool_calls).toEqual([
			{
				id: 'a',
				type: 'function',
				function: { name: 'fs_read_text', arguments: '{"path":"a.ts"}' }
			},
			{ id: 'b', type: 'function', function: { name: 'code_grep', arguments: '{"pattern":"foo"}' } }
		]);
		expect(res.finish_reason).toBe('tool_calls');
		expect(res.content).toBeNull();
	});

	it('joins argument chunks split mid-string and mid-escape', () => {
		const args = JSON.stringify({ path: 'a.ts', content: 'say "hi"\n\tdone' });
		const pieces = [args.slice(0, 5), args.slice(5, 31), args.slice(31, 32), args.slice(32)];
		const res = assemble([
			c({ tool_calls: [{ index: 0, id: 'w', function: { name: 'fs_write_text' } }] }),
			...pieces.map((p) => c({ tool_calls: [{ index: 0, function: { arguments: p } }] })),
			c({}, 'tool_calls')
		]);
		expect(JSON.parse(res.tool_calls![0].function.arguments)).toEqual({
			path: 'a.ts',
			content: 'say "hi"\n\tdone'
		});
	});

	it('keeps the first id and name when a server repeats them', () => {
		const res = assemble([
			c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{' } }] }),
			c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '}' } }] })
		]);
		expect(res.tool_calls![0]).toMatchObject({ id: 'a', function: { name: 'x', arguments: '{}' } });
	});

	it('gives a call the stream sent no id one of its own', () => {
		const res = assemble([c({ tool_calls: [{ index: 0, function: { name: 'x' } }] })]);
		expect(res.tool_calls![0].id).toMatch(/^call_stream_\d+$/);
	});

	it('wraps reasoning ahead of tool calls as chatCompletion does', () => {
		const res = assemble([
			c({ reasoning_content: 'Look at ' }),
			c({ reasoning: 'the file.' }),
			c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] }),
			c({}, 'tool_calls')
		]);
		expect(res.content).toBe('<think>Look at the file.</think>');
		expect(res.tool_calls).toHaveLength(1);
	});

	it('keeps content written alongside tool calls', () => {
		const res = assemble([
			c({ reasoning_content: 'R' }),
			c({ content: 'Let me ' }),
			c({ content: 'check.' }),
			c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] }),
			c({}, 'tool_calls')
		]);
		expect(res.content).toBe(combineReasoningAndContent('R', 'Let me check.'));
		expect(res.content).toBe('<think>R</think>\n\nLet me check.');
	});

	it('keeps a call truncated by finish_reason=length as partial JSON', () => {
		const res = assemble([
			c({ tool_calls: [{ index: 0, id: 'w', function: { name: 'fs_write_text' } }] }),
			c({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts","content":"abc' } }] }),
			c({}, 'length')
		]);
		expect(res.finish_reason).toBe('length');
		expect(res.tool_calls![0].function.arguments).toBe('{"path":"a.ts","content":"abc');
	});

	it('takes the last usage, defaults the finish reason, and carries no reasoning_details', () => {
		const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
		const res = assemble([c({ content: 'Hi' }), { delta: {}, finish_reason: null, usage }]);
		expect(res).toEqual({
			content: 'Hi',
			tool_calls: undefined,
			finish_reason: 'stop',
			usage,
			reasoning_details: null
		});
	});

	it('reports a call as far as it is written', () => {
		const a = new StreamResponseAssembler();
		expect(a.partial(0)).toBeNull();
		a.push(c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{"p' } }] }));
		expect(a.partial(0)).toEqual({ id: 'a', name: 'x', argsSoFar: '{"p' });
	});
});
