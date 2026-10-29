import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { TOKEN_BYTES_RATIO } from '#lib/agent/contextBudget.ts';
import type { LoopContext } from './context';
import {
	diversityNudgePrompt,
	hasNonThinkingContent,
	isCodeContext,
	looksLikeClarifyingQuestion,
	looksLikeImageOnlyRequest,
	outOfTokensMessage,
	phantomImageNudgePrompt,
	researchNudgePrompt,
	wroteRemoteImageMarkdown
} from './heuristics';

describe('looksLikeImageOnlyRequest', () => {
	it.each([
		'show me a picture of a red panda',
		'Get me the photos from the launch',
		'give some images',
		'find shots of the eclipse',
		'What does the Tesla Cybertruck look like?',
		'what do capybaras look like',
		'pics of corgis',
		'An image of a lighthouse please'
	])('matches %s', (q) => {
		expect(looksLikeImageOnlyRequest(q)).toBe(true);
	});

	it.each([
		'',
		'Tell me about monkeys',
		'Summarise this image processing paper',
		'Show me how to write a for loop',
		'find the bug in my code',
		'imagery in modern poetry',
		'What does this function return?'
	])('does not match %s', (q) => {
		expect(looksLikeImageOnlyRequest(q)).toBe(false);
	});
});

describe('wroteRemoteImageMarkdown', () => {
	it.each([
		'![x](https://example.com/a.png)',
		'![](http://example.com/a.png)',
		'Here: ![cat]( https://cats.example/cat.jpg ) done',
		'![X](HTTPS://EXAMPLE.COM/A.PNG)',
		'![fox](http://haruspex-img.localhost/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) and ![fox](https://example.com/fox.jpg)'
	])('detects %s', (s) => {
		expect(wroteRemoteImageMarkdown(s)).toBe(true);
	});

	it.each([
		null,
		undefined,
		'',
		'[link](https://example.com)',
		'![plot](data:image/png;base64,AAAA)',
		'![plot](out/plot.png)',
		'![plot](ftp://example.com/a.png)',
		// Our image cache on Windows, then on Linux and macOS: a drawn picture.
		'![fox](http://haruspex-img.localhost/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)',
		'![fox](haruspex-img://localhost/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'
	])('ignores %s', (s) => {
		expect(wroteRemoteImageMarkdown(s)).toBe(false);
	});
});

describe('looksLikeClarifyingQuestion', () => {
	it.each([
		'Which sections should I include?',
		'Do you want a PDF or DOCX?   \n',
		'  Shall I continue ?  '
	])('treats %j as a question', (s) => {
		expect(looksLikeClarifyingQuestion(s)).toBe(true);
	});

	it.each([
		'',
		'   \n\t',
		'I wrote the file.',
		'Is it done? Yes, it is done.',
		'What?!',
		'Question mark mid-sentence? then a statement'
	])('does not treat %j as a question', (s) => {
		expect(looksLikeClarifyingQuestion(s)).toBe(false);
	});
});

describe('hasNonThinkingContent', () => {
	it.each([
		'The answer is 42.',
		'<think>hmm</think>The answer.',
		'<think>a</think>\n\nB<think>c</think>',
		// An unclosed block is not stripped, so it counts as content.
		'<think>still reasoning'
	])('true for %j', (s) => {
		expect(hasNonThinkingContent(s)).toBe(true);
	});

	it.each([
		null,
		undefined,
		'',
		'   ',
		'<think>only reasoning</think>',
		'<think>a</think>\n<think>b</think>  '
	])('false for %j', (s) => {
		expect(hasNonThinkingContent(s)).toBe(false);
	});
});

function call(name: string, args: unknown) {
	return {
		id: `c-${name}`,
		type: 'function' as const,
		function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
	};
}

function assistantCalling(...calls: ReturnType<typeof call>[]): ChatMessage {
	return { role: 'assistant', content: '', tool_calls: calls };
}

describe('isCodeContext', () => {
	const user: ChatMessage = { role: 'user', content: 'help' };

	it.each<[string, ChatMessage[]]>([
		['run_python call', [user, assistantCalling(call('run_python', { code: 'print(1)' }))]],
		['fs_write_text on .py', [user, assistantCalling(call('fs_write_text', { path: 'a/b.py' }))]],
		['fs_edit_text on .PY', [user, assistantCalling(call('fs_edit_text', { path: 'MAIN.PY' }))]],
		[
			'any Python call among several',
			[user, assistantCalling(call('web_search', { q: 'x' }), call('run_python', {}))]
		],
		[
			'python diagnostics in the latest tool result',
			[
				user,
				assistantCalling(call('fs_read_text', { path: 'notes.md' })),
				{
					role: 'tool',
					content: '<diagnostics file="src/app.py">E1</diagnostics>',
					tool_call_id: 'x'
				}
			]
		],
		[
			'diagnostics in a content-part array',
			[
				user,
				{
					role: 'tool',
					content: [{ type: 'text', text: '<DIAGNOSTICS FILE="x.py">' }],
					tool_call_id: 'x'
				}
			]
		]
	])('true for %s', (_label, messages) => {
		expect(isCodeContext(messages)).toBe(true);
	});

	it.each<[string, ChatMessage[]]>([
		['empty', []],
		['plain user message', [user]],
		['web tool call', [user, assistantCalling(call('fetch_url', { url: 'https://x' }))]],
		['fs_write_text on .md', [user, assistantCalling(call('fs_write_text', { path: 'a.md' }))]],
		['fs_write_text with no path', [user, assistantCalling(call('fs_write_text', {}))]],
		['unparseable arguments', [user, assistantCalling(call('fs_edit_text', '{not json'))]],
		[
			'non-python diagnostics',
			[user, { role: 'tool', content: '<diagnostics file="a.ts">', tool_call_id: 'x' }]
		],
		[
			'python work before the latest user message',
			[assistantCalling(call('run_python', {})), { role: 'user', content: 'now something else' }]
		],
		[
			'latest assistant exchange is not python, older one was',
			[
				user,
				assistantCalling(call('run_python', {})),
				{ role: 'tool', content: 'ok', tool_call_id: 'c-run_python' },
				assistantCalling(call('web_search', { q: 'x' }))
			]
		]
	])('false for %s', (_label, messages) => {
		expect(isCodeContext(messages)).toBe(false);
	});

	it('skips assistant prose without tool calls and keeps walking back', () => {
		expect(
			isCodeContext([
				user,
				assistantCalling(call('run_python', {})),
				{ role: 'assistant', content: 'thinking out loud' }
			])
		).toBe(true);
	});
});

describe('nudge prompts', () => {
	it('diversityNudgePrompt names how many pages were opened', () => {
		expect(diversityNudgePrompt(0)).toContain('opened no pages');
		expect(diversityNudgePrompt(1)).toContain('opened only one page');
	});

	it('research and phantom-image prompts demand a tool call', () => {
		expect(researchNudgePrompt()).toContain('web_search');
		expect(phantomImageNudgePrompt()).toContain('image_search');
	});

	// The rejected answer is never shown, and without this the model replied
	// with only a paragraph about the picture it found (a 6.5 KB answer lost).
	it('phantom-image prompt asks for the whole answer again', () => {
		expect(phantomImageNudgePrompt()).toContain('write the whole answer again');
	});
});

describe('outOfTokensMessage', () => {
	const ctx = (over: Partial<LoopContext>) =>
		({ maxResponseTokens: 8192, expectsFileOutput: false, ...over }) as LoopContext;

	it('names the response limit and its approximate size', () => {
		const msg = outOfTokensMessage(ctx({}), false);
		const kb = Math.round((8192 * TOKEN_BYTES_RATIO) / 1024);
		expect(msg).toContain('8192-token response limit');
		expect(msg).toContain(`roughly ${kb} KB`);
		expect(msg).toContain('Settings → Inference → Model defaults → Max response tokens,');
		expect(msg).not.toContain('deep research');
	});

	it('points at the file-write setting when the turn expects a file', () => {
		const msg = outOfTokensMessage(ctx({ expectsFileOutput: true }), false);
		expect(msg).toContain('Max response tokens (file writes)');
	});

	it('adds the research hint after tools ran', () => {
		expect(outOfTokensMessage(ctx({}), true)).toContain('disabling deep research');
	});
});
