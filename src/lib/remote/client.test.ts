/**
 * Drives the guest's page as a browser would.
 *
 * The client is plain JS served by Rust rather than part of this app's build,
 * so it is loaded here exactly as it ships — the real `index.html` into jsdom,
 * the real `app.js` imported from where Rust reads it. A test that exercised a
 * copy would pass while the served page was broken.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The page exactly as Rust serves it, from where Rust reads it.
import html from '../../../src-tauri/src/remote/client/index.html?raw';
import { boot, renderMarkdown } from '../../../src-tauri/src/remote/client/app.js';

class FakeStream {
	static last: FakeStream | null = null;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		FakeStream.last = this;
	}

	emit(event: unknown) {
		this.onmessage?.({ data: JSON.stringify(event) });
	}

	close() {
		this.closed = true;
	}
}

function mountPage() {
	// The <body> of the page as served, minus the module script that would
	// otherwise boot it with the real transport.
	const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
	document.body.innerHTML = body;
}

interface Client {
	handle: (event: unknown) => void;
	send: (text: string) => Promise<void>;
	transcript: { role: string; text: string; failed?: boolean }[];
}

function start(options: { token?: string | null; fetch?: ReturnType<typeof vi.fn> } = {}) {
	const token = options.token === undefined ? 'link-token' : options.token;
	const fetchMock =
		options.fetch ??
		vi.fn(async () => new Response(JSON.stringify({ turnId: 't1' }), { status: 202 }));
	const client = boot({
		document,
		storage: localStorage,
		fetch: fetchMock,
		EventSource: FakeStream,
		search: token ? `?t=${token}` : ''
	}) as Client;
	return { client, fetchMock, stream: () => FakeStream.last! };
}

const messages = () => Array.from(document.querySelectorAll('#messages .msg'));
const status = () => document.getElementById('status')!.textContent;

beforeEach(() => {
	localStorage.clear();
	FakeStream.last = null;
	mountPage();
});

describe('what the page renders', () => {
	it('escapes model output instead of running it', () => {
		// The model's answer is shaped by whatever the web served it during a
		// search, so this is untrusted text arriving as HTML.
		const rendered = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>');
		expect(rendered).not.toContain('<script>');
		expect(rendered).not.toContain('<img');
		expect(rendered).toContain('&lt;script&gt;');
	});

	it('refuses links that are not http(s)', () => {
		expect(renderMarkdown('[click](javascript:alert(1))')).not.toContain('href');
		expect(renderMarkdown('[click](data:text/html;base64,x)')).not.toContain('href');
		const safe = renderMarkdown('[docs](https://example.com/a)');
		expect(safe).toContain('href="https://example.com/a"');
		expect(safe).toContain('rel="noopener noreferrer"');
	});

	it('renders the small subset it promises', () => {
		expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
		expect(renderMarkdown('a `snippet` here')).toContain('<code>snippet</code>');
		expect(renderMarkdown('- one\n- two')).toContain('<li>one</li><li>two</li>');
		expect(renderMarkdown('```js\nlet x = 1 < 2;\n```')).toContain(
			'<pre><code>let x = 1 &lt; 2;\n</code></pre>'
		);
	});

	it('shows the guest their own words as text, never as markup', () => {
		const { client } = start();
		void client.send('<b>hi</b>');
		const bubble = messages()[0];
		expect(bubble.textContent).toBe('<b>hi</b>');
		expect(bubble.innerHTML).not.toContain('<b>');
	});
});

describe('a turn from the guest side', () => {
	it('posts the prompt with the session and the token', async () => {
		const { client, fetchMock } = start();
		await client.send('what is a haruspex?');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain('/api/chat?t=link-token');
		expect(JSON.parse(init.body as string)).toEqual({
			sessionId: expect.any(String),
			message: 'what is a haruspex?',
			clientLabel: null
		});
	});

	it('asks for a name once, then sends it with every message', async () => {
		start();
		// Before the first message, so the host's sidebar says who is asking
		// instead of listing identical threads.
		expect((document.getElementById('greeting') as HTMLFormElement).hidden).toBe(false);
		expect((document.getElementById('composer') as HTMLFormElement).hidden).toBe(true);

		(document.getElementById('name') as HTMLInputElement).value = 'Dave';
		document.getElementById('greeting')!.dispatchEvent(new Event('submit', { cancelable: true }));
		expect((document.getElementById('greeting') as HTMLFormElement).hidden).toBe(true);

		// And it is remembered, so a reload does not ask again.
		mountPage();
		const { client, fetchMock } = start();
		expect((document.getElementById('greeting') as HTMLFormElement).hidden).toBe(true);
		await client.send('hello again');
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string).clientLabel).toBe('Dave');
	});

	it('lets a guest skip the name and still get an answer', async () => {
		start();
		document.getElementById('skip')!.dispatchEvent(new Event('click'));
		expect((document.getElementById('composer') as HTMLFormElement).hidden).toBe(false);

		mountPage();
		const { client, fetchMock } = start();
		// Skipped is remembered as "asked and declined", not as "not asked yet".
		expect((document.getElementById('greeting') as HTMLFormElement).hidden).toBe(true);
		await client.send('hello');
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string).clientLabel).toBeNull();
	});

	it('says it is waiting for the desktop rather than looking hung', () => {
		const { stream } = start();
		stream().emit({ type: 'state', turnId: 't1', status: 'waiting' });
		// The collision case: the person at the keyboard has the only slot.
		expect(status()).toBe('Waiting for the desktop…');

		stream().emit({ type: 'delta', turnId: 't1', text: 'Ent' });
		expect(status()).toBe('Answering…');
	});

	it('streams deltas into one answer', () => {
		const { stream } = start();
		stream().emit({ type: 'delta', turnId: 't1', text: 'A reader ' });
		stream().emit({ type: 'delta', turnId: 't1', text: 'of entrails.' });
		stream().emit({ type: 'done', turnId: 't1', text: 'A reader of entrails.' });

		const bubbles = messages();
		expect(bubbles).toHaveLength(1);
		expect(bubbles[0].querySelector('p')!.textContent).toBe('A reader of entrails.');
		expect(bubbles[0].classList.contains('pending')).toBe(false);
		expect(status()).toBe('Ready');
	});

	it('offers to read only answers that are finished', () => {
		const { stream } = start();
		stream().emit({ type: 'delta', turnId: 't1', text: 'still writing' });
		// Reading a half-written answer aloud would synthesise a sentence that
		// is about to change.
		expect(messages()[0].querySelector('.speak')).toBeNull();

		stream().emit({ type: 'done', turnId: 't1', text: 'still writing, now done' });
		expect(messages()[0].querySelector('.speak')).not.toBeNull();
	});

	it('resumes a half-written answer after the connection drops', () => {
		const { stream } = start();
		stream().emit({ type: 'delta', turnId: 't1', text: 'half an ans' });

		// A phone locking its screen: EventSource reconnects and the server
		// replays where the answer had got to.
		stream().onerror?.();
		expect(status()).toBe('Reconnecting…');
		stream().emit({
			type: 'snapshot',
			turnId: 't1',
			text: 'half an answer and the rest',
			status: 'running'
		});

		const bubbles = messages();
		// One answer continued, not a second one started beside it.
		expect(bubbles).toHaveLength(1);
		expect(bubbles[0].querySelector('p')!.textContent).toBe('half an answer and the rest');
	});

	it('shows the server’s own words when it refuses', async () => {
		const fetchMock = vi.fn(
			async () => new Response('too many messages — slow down a moment', { status: 429 })
		);
		const { client } = start({ fetch: fetchMock });
		await client.send('again');
		expect(status()).toContain('slow down');
		expect(messages().at(-1)!.classList.contains('failed')).toBe(true);
	});

	it('re-enables the composer after a failure so the guest can retry', () => {
		const { stream } = start();
		stream().emit({ type: 'state', turnId: 't1', status: 'waiting' });
		stream().emit({ type: 'error', turnId: 't1', message: 'the model is not running' });

		expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false);
		expect(messages().at(-1)!.textContent).toBe('the model is not running');
	});

	it('survives a frame it cannot parse', () => {
		const { stream } = start();
		expect(() => stream().onmessage?.({ data: 'not json' })).not.toThrow();
	});
});

describe('without a link', () => {
	it('offers no way to spend the host’s GPU', () => {
		const { client } = start({ token: null });
		expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
		expect((document.getElementById('input') as HTMLTextAreaElement).disabled).toBe(true);
		expect(status()).toContain('link');
		// And no stream was opened.
		expect(FakeStream.last).toBeNull();
		expect(client.send).toBeUndefined();
	});
});
