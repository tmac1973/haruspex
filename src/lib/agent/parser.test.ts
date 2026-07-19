import { describe, it, expect } from 'vitest';
import {
	extractToolCalls,
	extractFunctionStyleToolCalls,
	hasFunctionStyleToolCalls,
	hasToolCalls,
	stripToolCallXml,
	resolveToolCalls,
	type ToolCallResolution
} from '$lib/agent/parser';
import type { ChatCompletionResponse } from '$lib/api';

/**
 * Unwrap a resolution to its calls, so the assertions below read the same as
 * they did when `resolveToolCalls` returned a bare array. A `rejected` result
 * is deliberately NOT flattened to `[]` — tests that expect a rejection assert
 * on it directly, and silently treating one as "no calls" is exactly the
 * conflation the resolution type exists to prevent.
 */
function callsOf(resolution: ToolCallResolution) {
	return resolution.kind === 'calls' ? resolution.calls : [];
}

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
		const calls = callsOf(resolveToolCalls(response));
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('structured_tool');
		expect(calls[0].id).toBe('call_1');
	});

	it('falls back to XML when no structured calls', () => {
		const response: ChatCompletionResponse = {
			content: '<tool_call>{"name":"web_search","arguments":{"query":"test"}}</tool_call>',
			finish_reason: 'stop'
		};
		const calls = callsOf(resolveToolCalls(response));
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('web_search');
		expect(calls[0].id).toMatch(/^call_/);
	});

	it('returns empty when no tool calls at all', () => {
		const response: ChatCompletionResponse = {
			content: 'Just a normal response',
			finish_reason: 'stop'
		};
		expect(callsOf(resolveToolCalls(response))).toHaveLength(0);
	});

	it('returns empty for null content and no tool_calls', () => {
		const response: ChatCompletionResponse = {
			content: null,
			finish_reason: 'stop'
		};
		expect(callsOf(resolveToolCalls(response))).toHaveLength(0);
	});

	it('does not throw on malformed structured arguments, falls through to XML', () => {
		// A remote/quantized server emitted a tool_calls entry with
		// truncated JSON args. Previously JSON.parse threw past the
		// recovery chain; now it falls through to the XML fallback.
		const response: ChatCompletionResponse = {
			content: '<tool_call>{"name":"web_search","arguments":{"query":"test"}}</tool_call>',
			tool_calls: [
				{
					id: 'call_bad',
					type: 'function',
					function: { name: 'structured_tool', arguments: '{"q":' }
				}
			],
			finish_reason: 'tool_calls'
		};
		const calls = callsOf(resolveToolCalls(response));
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('web_search');
	});

	it('returns empty (no throw) when structured args are malformed and no fallback exists', () => {
		const response: ChatCompletionResponse = {
			content: null,
			tool_calls: [
				{
					id: 'call_bad',
					type: 'function',
					function: { name: 'structured_tool', arguments: 'not json' }
				}
			],
			finish_reason: 'tool_calls'
		};
		expect(() => resolveToolCalls(response)).not.toThrow();
		expect(callsOf(resolveToolCalls(response))).toHaveLength(0);
	});

	it('treats empty-string structured arguments as {}', () => {
		const response: ChatCompletionResponse = {
			content: null,
			tool_calls: [
				{
					id: 'call_noargs',
					type: 'function',
					function: { name: 'list_dir', arguments: '' }
				}
			],
			finish_reason: 'tool_calls'
		};
		const calls = callsOf(resolveToolCalls(response));
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('list_dir');
		expect(calls[0].arguments).toEqual({});
	});

	it('keeps only the parseable structured calls when some are malformed', () => {
		const response: ChatCompletionResponse = {
			content: null,
			tool_calls: [
				{ id: 'c1', type: 'function', function: { name: 'good_tool', arguments: '{"a":1}' } },
				{ id: 'c2', type: 'function', function: { name: 'bad_tool', arguments: '{oops' } }
			],
			finish_reason: 'tool_calls'
		};
		const calls = callsOf(resolveToolCalls(response));
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('good_tool');
		expect(calls[0].id).toBe('c1');
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
		const calls = callsOf(resolveToolCalls(response));
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

describe('extractToolCalls function-style fallback', () => {
	// Qwen3 at Q4_K_M sometimes wraps function-style markup inside a
	// <tool_call> block, especially when "rehearsing" a call inside its
	// <think> stream. Before the fallback was added this dropped to
	// the malformed-tool-call recovery path and burned an iteration.
	it('parses function-style markup wrapped in <tool_call>', () => {
		const content =
			'<tool_call>\n<function=fs_read_text>\n<parameter=path>\n/home/tim/projects/planets/main.py\n</parameter>\n</function>\n</tool_call>';
		const calls = extractToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('fs_read_text');
		expect(calls[0].arguments).toEqual({ path: '/home/tim/projects/planets/main.py' });
	});

	it('parses the wrapped form even when embedded inside <think>', () => {
		// This is the exact shape that showed up in the shell-tab log
		// — reasoning_content was prepended as <think>…</think> by the
		// API layer, and the model had emitted a <tool_call> inside
		// its reasoning.
		const content =
			'<think>Let me use the correct absolute path.\n\n<tool_call>\n<function=fs_read_text>\n<parameter=path>\n/home/tim/projects/planets/main.py\n</parameter>\n</function>\n</tool_call></think>';
		const calls = extractToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('fs_read_text');
		expect(calls[0].arguments.path).toBe('/home/tim/projects/planets/main.py');
	});
});

describe('resolveToolCalls — truncated and ambiguous calls', () => {
	// The shape observed in the real incident: a phase file emitted as a
	// <function=…> block, chunked across repeated <parameter=content> blocks
	// and then cut off mid-CSS-property with no closing tag. Salvaging this
	// produced a 1,170-byte "middle slice" — prefix lost to the duplicate-key
	// overwrite, suffix lost to the unclosed-tag match — which was then written
	// to disk and reported as a successful write.
	const incidentPayload =
		'<function=fs_write_text>' +
		'<parameter=path>plan/phase-02-css.md' +
		'<parameter=content># Phase 02 — CSS Styling\n\nDepends on: 01\n' +
		'<parameter=content>### 9. Score panel\n\n```css\n#score-panel {\n  display: flex;\n  align-items';

	it('rejects a truncated function-style call instead of salvaging a fragment', () => {
		const response: ChatCompletionResponse = {
			content: incidentPayload,
			finish_reason: 'length'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('rejected');
		// The critical property: no executable call is produced at all.
		expect(callsOf(result)).toHaveLength(0);
	});

	it('rejects the incident payload under stop, for the duplicate-parameter reason', () => {
		// Same bytes, complete generation. The truncation gate does not apply,
		// but the repeated <parameter=content> is still ambiguous.
		const response: ChatCompletionResponse = {
			content: incidentPayload,
			finish_reason: 'stop'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toContain('duplicate parameter');
			expect(result.reason).toContain('content');
		}
	});

	it('still accepts a complete unclosed-tag call under stop', () => {
		// The loose grammar is a real emission shape, not a defect — a
		// duplicate-free call with no closing tags must keep working.
		const response: ChatCompletionResponse = {
			content: '<function=web_search> <parameter=query> current weather',
			finish_reason: 'stop'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('calls');
		expect(callsOf(result)).toHaveLength(1);
		expect(callsOf(result)[0].arguments).toEqual({ query: 'current weather' });
	});

	it('rejects truncated structured arguments rather than falling through to salvage', () => {
		const response: ChatCompletionResponse = {
			content: '<function=fs_write_text> <parameter=path> a.md <parameter=content> partial',
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'fs_write_text', arguments: '{"path":"a.md","content":"# Titl' }
				}
			],
			finish_reason: 'length'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('rejected');
		expect(callsOf(result)).toHaveLength(0);
	});

	it('rejects the whole response when only the LAST structured call is truncated', () => {
		// The realistic truncation shape. Executing the good prefix and dropping
		// the cut-off tail is a half-success the model cannot detect: it believes
		// both calls ran.
		const response: ChatCompletionResponse = {
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'fs_read_text', arguments: '{"path":"overview.md"}' }
				},
				{
					id: 'call_2',
					type: 'function',
					function: { name: 'fs_write_text', arguments: '{"path":"a.md","conte' }
				}
			],
			content: null,
			finish_reason: 'length'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('rejected');
		expect(callsOf(result)).toHaveLength(0);
	});

	it('executes structured calls that all parse, even under a length finish', () => {
		// Valid JSON means the calls themselves are complete; the cut fell after
		// them. The reject is keyed on parse failure, not on `length` alone.
		const response: ChatCompletionResponse = {
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'fs_read_text', arguments: '{"path":"overview.md"}' }
				}
			],
			content: null,
			finish_reason: 'length'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('calls');
		expect(callsOf(result)).toHaveLength(1);
	});

	it('leaves a truncated response with no tool-call syntax alone', () => {
		// Plain prose cut off by the ceiling is not a refused call — the
		// existing continue-on-length recovery handles that.
		const response: ChatCompletionResponse = {
			content: 'Here is the first half of my answer and then it just st',
			finish_reason: 'length'
		};
		expect(resolveToolCalls(response).kind).toBe('none');
	});

	it('allows the same parameter name in two different calls', () => {
		// Duplicate detection is scoped per function block: one response can
		// legitimately carry several calls that each use the same argument name.
		const response: ChatCompletionResponse = {
			content:
				'<function=fs_read_text> <parameter=path> a.md ' +
				'<function=fs_read_text> <parameter=path> b.md',
			finish_reason: 'stop'
		};
		const result = resolveToolCalls(response);
		expect(result.kind).toBe('calls');
		expect(callsOf(result)).toHaveLength(2);
	});
});
