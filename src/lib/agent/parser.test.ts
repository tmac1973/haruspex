import { describe, it, expect } from 'vitest';
import {
	extractToolCalls,
	extractFunctionStyleToolCalls,
	hasFunctionStyleToolCalls,
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

	it('falls back to <function=name><parameter=key> format', () => {
		// The exact shape Qwen3 emitted via a misconfigured remote
		// inference server: tool-call tokens leaked into text content
		// instead of being normalized into tool_calls JSON.
		const response: ChatCompletionResponse = {
			content:
				'<function=email_summarize_message> <parameter=accountId> abc-123 <parameter=messageId> 22893',
			finish_reason: 'stop'
		};
		const calls = resolveToolCalls(response);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('email_summarize_message');
		expect(calls[0].arguments).toEqual({ accountId: 'abc-123', messageId: 22893 });
	});
});

describe('extractFunctionStyleToolCalls', () => {
	it('extracts a single call with string and int params', () => {
		const content =
			'<function=email_summarize_message> <parameter=accountId> 13873deb-0055-400f <parameter=messageId> 22893';
		const calls = extractFunctionStyleToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('email_summarize_message');
		expect(calls[0].arguments).toEqual({
			accountId: '13873deb-0055-400f',
			messageId: 22893
		});
	});

	it('handles explicit </function> and </parameter> closers', () => {
		const content = `<function=web_search>
<parameter=query>current weather</parameter>
</function>`;
		const calls = extractFunctionStyleToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('web_search');
		expect(calls[0].arguments).toEqual({ query: 'current weather' });
	});

	it('extracts multiple calls in one response', () => {
		const content =
			'<function=web_search> <parameter=query> first query ' +
			'<function=fetch_url> <parameter=url> https://example.com/path';
		const calls = extractFunctionStyleToolCalls(content);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe('web_search');
		expect(calls[0].arguments).toEqual({ query: 'first query' });
		expect(calls[1].name).toBe('fetch_url');
		expect(calls[1].arguments).toEqual({ url: 'https://example.com/path' });
	});

	it('coerces booleans, floats, and JSON objects', () => {
		const content =
			'<function=demo>' +
			' <parameter=flag> true' +
			' <parameter=ratio> 0.75' +
			' <parameter=nested> {"a":1,"b":[2,3]}';
		const calls = extractFunctionStyleToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual({
			flag: true,
			ratio: 0.75,
			nested: { a: 1, b: [2, 3] }
		});
	});

	it('strips matching surrounding quotes', () => {
		const content = '<function=web_search> <parameter=query> "exact phrase here"';
		const calls = extractFunctionStyleToolCalls(content);
		expect(calls[0].arguments).toEqual({ query: 'exact phrase here' });
	});

	it('returns empty array when no function-style tags', () => {
		expect(extractFunctionStyleToolCalls('plain text')).toHaveLength(0);
		expect(extractFunctionStyleToolCalls('')).toHaveLength(0);
	});
});

describe('hasFunctionStyleToolCalls', () => {
	it('detects the prefix', () => {
		expect(hasFunctionStyleToolCalls('<function=email_list_recent>')).toBe(true);
		expect(hasFunctionStyleToolCalls('prefix <function=x> suffix')).toBe(true);
	});

	it('rejects unrelated text', () => {
		expect(hasFunctionStyleToolCalls('just text')).toBe(false);
		expect(hasFunctionStyleToolCalls('<tool_call>{}</tool_call>')).toBe(false);
	});
});
