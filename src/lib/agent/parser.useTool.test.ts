import { describe, it, expect } from 'vitest';
import type { ChatCompletionResponse, ToolDefinition } from '#lib/api.ts';
import { resolveToolCalls } from './parser';

const tool = (name: string): ToolDefinition => ({
	type: 'function',
	function: { name, description: '', parameters: { type: 'object' } }
});
const WITH_PROXY = [tool('web_search'), tool('load_tools'), tool('use_tool')];

function response(name: string, args: unknown): ChatCompletionResponse {
	return {
		content: '',
		finish_reason: 'tool_calls',
		tool_calls: [
			{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }
		]
	} as ChatCompletionResponse;
}

describe('use_tool unwrapping', () => {
	it('turns a use_tool call into a call to the named tool', () => {
		const r = resolveToolCalls(
			response('use_tool', { name: 'video_probe', arguments: { episode: 'ep012' } }),
			WITH_PROXY
		);
		expect(r).toEqual({
			kind: 'calls',
			calls: [
				{
					id: 'c1',
					name: 'video_probe',
					arguments: { episode: 'ep012' },
					wire: {
						name: 'use_tool',
						arguments: { name: 'video_probe', arguments: { episode: 'ep012' } }
					}
				}
			]
		});
	});

	it('accepts arguments sent as a JSON string', () => {
		const r = resolveToolCalls(
			response('use_tool', { name: 'video_probe', arguments: '{"episode":"ep012"}' }),
			WITH_PROXY
		);
		expect(r.kind === 'calls' && r.calls[0].arguments).toEqual({ episode: 'ep012' });
	});

	it('takes missing or unreadable arguments as none', () => {
		for (const args of [undefined, 'not json', [1, 2]]) {
			const r = resolveToolCalls(response('use_tool', { name: 'video_probe', arguments: args }), [
				...WITH_PROXY
			]);
			expect(r.kind === 'calls' && r.calls[0]).toMatchObject({
				name: 'video_probe',
				arguments: {}
			});
		}
	});

	it('leaves a use_tool call with no usable name to use_tool', () => {
		for (const name of [undefined, '', 'use_tool']) {
			const r = resolveToolCalls(response('use_tool', { name, arguments: {} }), WITH_PROXY);
			expect(r.kind === 'calls' && r.calls[0].name).toBe('use_tool');
			expect(r.kind === 'calls' && r.calls[0].wire).toBeUndefined();
		}
	});

	it('unwraps a call written as text', () => {
		const r = resolveToolCalls(
			{
				content:
					'<tool_call>{"name":"use_tool","arguments":{"name":"web_search","arguments":{"query":"x"}}}</tool_call>',
				finish_reason: 'stop'
			} as ChatCompletionResponse,
			WITH_PROXY
		);
		expect(r.kind === 'calls' && r.calls[0]).toMatchObject({
			name: 'web_search',
			arguments: { query: 'x' }
		});
	});

	it('does nothing when the turn does not offer use_tool', () => {
		const r = resolveToolCalls(response('use_tool', { name: 'video_probe', arguments: {} }), [
			tool('web_search')
		]);
		expect(r.kind === 'calls' && r.calls[0].name).toBe('use_tool');
	});
});
