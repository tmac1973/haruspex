import { describe, it, expect } from 'vitest';
import {
	extractToolCalls,
	hasToolCalls,
	stripToolCallXml,
	resolveToolCalls
} from '$lib/agent/parser';
import type { ChatCompletionResponse } from '$lib/api';

describe('extractToolCalls', () => {
	it('extracts a single tool call', () => {
		const content = `<tool_call>
{"name": "web_search", "arguments": {"query": "weather portland"}}
</tool_call>`;
		const calls = extractToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('web_search');
		expect(calls[0].arguments).toEqual({ query: 'weather portland' });
	});

	it('extracts multiple tool calls', () => {
		const content = `<tool_call>
{"name": "web_search", "arguments": {"query": "news today"}}
</tool_call>
Some text in between
<tool_call>
{"name": "fetch_url", "arguments": {"url": "https://example.com"}}
</tool_call>`;
		const calls = extractToolCalls(content);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe('web_search');
		expect(calls[1].name).toBe('fetch_url');
	});

	it('handles malformed JSON inside tool_call tags', () => {
		const content = `<tool_call>
{not valid json}
</tool_call>
<tool_call>
{"name": "web_search", "arguments": {"query": "test"}}
</tool_call>`;
		const calls = extractToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('web_search');
	});

	it('returns empty array when no tool calls present', () => {
		expect(extractToolCalls('Just a regular message')).toHaveLength(0);
		expect(extractToolCalls('')).toHaveLength(0);
	});

	it('skips entries without name or arguments', () => {
		const content = `<tool_call>
{"name": "web_search"}
</tool_call>
<tool_call>
{"arguments": {"query": "test"}}
</tool_call>`;
		const calls = extractToolCalls(content);
		expect(calls).toHaveLength(0);
	});
});

describe('hasToolCalls', () => {
	it('returns true when tool_call tags present', () => {
		expect(hasToolCalls('<tool_call>something</tool_call>')).toBe(true);
		expect(hasToolCalls('prefix <tool_call>x</tool_call> suffix')).toBe(true);
	});

	it('returns false when no tags', () => {
		expect(hasToolCalls('just text')).toBe(false);
		expect(hasToolCalls('')).toBe(false);
	});
});

describe('stripToolCallXml', () => {
	it('removes tool_call tags and preserves other content', () => {
		const content = `Hello <tool_call>{"name":"x","arguments":{}}</tool_call> world`;
		expect(stripToolCallXml(content)).toBe('Hello  world');
	});

	it('removes multiple tags', () => {
		const content = `<tool_call>a</tool_call> text <tool_call>b</tool_call>`;
		expect(stripToolCallXml(content)).toBe('text');
	});

	it('returns original content when no tags', () => {
		expect(stripToolCallXml('no tags here')).toBe('no tags here');
	});
});

describe('resolveToolCalls', () => {
	it('prefers structured tool_calls over XML fallback', () => {
		const response: ChatCompletionResponse = {
			content: '<tool_call>{"name":"xml_tool","arguments":{"q":"a"}}</tool_call>',
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'structured_tool', arguments: '{"q":"b"}' }
				}
			],
			finish_reason: 'tool_calls'
		};
		const calls = resolveToolCalls(response);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('structured_tool');
		expect(calls[0].id).toBe('call_1');
	});

	it('falls back to XML when no structured calls', () => {
		const response: ChatCompletionResponse = {
			content: '<tool_call>{"name":"web_search","arguments":{"query":"test"}}</tool_call>',
			finish_reason: 'stop'
		};
		const calls = resolveToolCalls(response);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('web_search');
		expect(calls[0].id).toMatch(/^call_/);
	});

	it('returns empty when no tool calls at all', () => {
		const response: ChatCompletionResponse = {
			content: 'Just a normal response',
			finish_reason: 'stop'
		};
		expect(resolveToolCalls(response)).toHaveLength(0);
	});

	it('returns empty for null content and no tool_calls', () => {
		const response: ChatCompletionResponse = {
			content: null,
			finish_reason: 'stop'
		};
		expect(resolveToolCalls(response)).toHaveLength(0);
	});
});
