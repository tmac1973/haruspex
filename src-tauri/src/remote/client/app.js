/**
 * The guest's chat client.
 *
 * Plain ES module, no framework, no build step: this file is served verbatim by
 * the Rust process to whatever browser a friend happens to have. It cannot
 * import anything from the desktop app — 19 modules there call Tauri's
 * `invoke()`, which does not exist here — so it speaks the HTTP API and nothing
 * else.
 *
 * `boot()` takes its dependencies as arguments so the whole page can be driven
 * in tests with a fake transport. Nothing runs on import.
 */

const SESSION_KEY = 'haruspex-remote-session';
const TOKEN_KEY = 'haruspex-remote-token';
const TRANSCRIPT_KEY = 'haruspex-remote-transcript';

/** Kept short: this is a courtesy copy for reloads, not a conversation store. */
const TRANSCRIPT_LIMIT = 50;

/**
 * Stands in for a fenced code block while the rest of the markdown rules run.
 * A NUL cannot appear in the escaped text it is spliced into, so it cannot be
 * forged by model output trying to smuggle markup past the escaper.
 */
const CODE_MARK = '\u0000';

// --- markdown --------------------------------------------------------------

/**
 * Model output is rendered as HTML, and model output is influenced by whatever
 * the web served it during a search. So everything is escaped first and the
 * markdown subset is applied to already-safe text — there is no path here where
 * a document from the internet becomes markup.
 */
/** @param {unknown} text @returns {string} */
export function escapeHtml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Only http(s) survives. `javascript:` and `data:` links do not. */
/** @param {string} url @returns {string | null} */
function safeUrl(url) {
	const trimmed = String(url).trim();
	return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** @param {string} text @returns {string} */
function inline(text) {
	let out = text;
	out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
	out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
		const url = safeUrl(href.replace(/&amp;/g, '&'));
		return url
			? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
			: match;
	});
	out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, lead, href) => {
		const url = safeUrl(href.replace(/&amp;/g, '&'));
		return url
			? `${lead}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${href}</a>`
			: match;
	});
	out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
	return out;
}

/**
 * A deliberately small subset: fenced code, inline code, bold, italic, links,
 * lists, paragraphs. Not the app's renderer — no tables, no images, no raw HTML
 * passthrough — because every feature here is also an attack surface.
 */
/** @param {unknown} text @returns {string} */
export function renderMarkdown(text) {
	// NULs are stripped before anything else so the code-block placeholder
	// cannot be spoofed by the text being rendered.
	const escaped = escapeHtml(String(text).split(CODE_MARK).join(''));

	// Code blocks are lifted out first so nothing inside them is treated as
	// markup by the rules below.
	/** @type {string[]} */
	const blocks = [];
	const withoutCode = escaped.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, code) => {
		blocks.push(code);
		return `${CODE_MARK}${blocks.length - 1}${CODE_MARK}`;
	});

	const placeholder = new RegExp(`^${CODE_MARK}\\d+${CODE_MARK}$`);

	const html = withoutCode
		.split(/\n{2,}/)
		.map((block) => {
			const trimmed = block.trim();
			if (!trimmed) return '';
			if (placeholder.test(trimmed)) return trimmed;

			const lines = trimmed.split('\n');
			if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
				const items = lines.map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
				return `<ul>${items.join('')}</ul>`;
			}
			if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
				const items = lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
				return `<ol>${items.join('')}</ol>`;
			}
			return `<p>${inline(lines.join('\n')).replace(/\n/g, '<br />')}</p>`;
		})
		.join('');

	return html.replace(
		new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'),
		(_, index) => `<pre><code>${blocks[index]}</code></pre>`
	);
}

/**
 * One line in the conversation as the page shows it.
 *
 * @typedef {{
 *   role: 'user' | 'assistant',
 *   text: string,
 *   turnId?: string | null,
 *   pending?: boolean,
 *   failed?: boolean
 * }} Bubble
 */

// --- identity --------------------------------------------------------------

function randomId() {
	const bytes = new Uint8Array(9);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

/** @param {Storage | null} store @param {string} key @returns {string | null} */
function readStore(store, key) {
	try {
		return store?.getItem(key) ?? null;
	} catch {
		// Private mode, or storage disabled. Not a reason to fail.
		return null;
	}
}

/** @param {Storage | null} store @param {string} key @param {string} value */
function writeStore(store, key, value) {
	try {
		store?.setItem(key, value);
	} catch {
		// As above: losing continuity across reloads beats not working at all.
	}
}

// --- the page --------------------------------------------------------------

/**
 * @param {{
 *   document?: Document,
 *   storage?: Storage | null,
 *   fetch?: typeof fetch,
 *   EventSource?: any,
 *   search?: string
 * }} [deps]
 */
export function boot(deps = {}) {
	const doc = deps.document ?? document;
	const store = deps.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
	const net = deps.fetch ?? ((...args) => fetch(...args));
	const Stream = deps.EventSource ?? (typeof EventSource === 'undefined' ? null : EventSource);
	const search = deps.search ?? (typeof location === 'undefined' ? '' : location.search);

	const messagesEl = doc.getElementById('messages');
	const statusEl = doc.getElementById('status');
	const composerEl = /** @type {HTMLFormElement | null} */ (doc.getElementById('composer'));
	const inputEl = /** @type {HTMLTextAreaElement | null} */ (doc.getElementById('input'));
	const sendEl = /** @type {HTMLButtonElement | null} */ (doc.getElementById('send'));
	const stopEl = /** @type {HTMLButtonElement | null} */ (doc.getElementById('stop'));
	// All or nothing: a page missing one of these is a page this script cannot
	// drive, and failing here beats throwing halfway through a guest's first
	// message.
	if (!messagesEl || !statusEl || !composerEl || !inputEl || !sendEl || !stopEl) return null;

	const ui = {
		messages: messagesEl,
		status: statusEl,
		composer: composerEl,
		input: inputEl,
		send: sendEl,
		stop: stopEl
	};

	// The link the host shared carries the token; it is kept in the address bar
	// so a reload still works, and stashed so a bookmark without the query
	// string does too.
	const fromUrl = new URLSearchParams(search).get('t');
	if (fromUrl) writeStore(store, TOKEN_KEY, fromUrl);
	const token = fromUrl ?? readStore(store, TOKEN_KEY);

	// Encoded once. Every route below is unreachable without a token — the page
	// stops at the guard at the end of `boot` — so an empty string here is a
	// state the server never sees.
	const auth = encodeURIComponent(token ?? '');
	// Not an account: it distinguishes this browser from another one, so two
	// guests do not land in one conversation and a reload continues rather than
	// restarts.
	const sessionId = readStore(store, SESSION_KEY) ?? randomId();
	writeStore(store, SESSION_KEY, sessionId);

	/** @type {Bubble[]} */
	let transcript = [];
	try {
		const saved = readStore(store, `${TRANSCRIPT_KEY}:${sessionId}`);
		if (saved) transcript = JSON.parse(saved);
	} catch {
		transcript = [];
	}

	/** @type {string | null} */
	let currentTurn = null;
	let busy = false;
	/** @type {any} */
	let stream = null;

	function saveTranscript() {
		transcript = transcript.slice(-TRANSCRIPT_LIMIT);
		writeStore(store, `${TRANSCRIPT_KEY}:${sessionId}`, JSON.stringify(transcript));
	}

	/** @param {string} text @param {boolean} [isError] */
	function setStatus(text, isError = false) {
		ui.status.textContent = text;
		ui.status.classList.toggle('error', isError);
	}

	function atBottom() {
		const node = ui.messages;
		return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
	}

	function render() {
		const stick = atBottom();
		ui.messages.replaceChildren();

		if (!transcript.length) {
			const empty = doc.createElement('div');
			empty.className = 'empty';
			empty.textContent = 'Ask a question to get started.';
			ui.messages.append(empty);
		}

		for (const message of transcript) {
			const node = doc.createElement('div');
			node.className = `msg ${message.role}`;
			if (message.failed) node.classList.add('failed');
			if (message.pending) node.classList.add('pending');
			if (message.role === 'user') {
				// Never rendered as markdown: it is the guest's own text and has
				// no reason to become markup.
				node.textContent = message.text;
			} else {
				node.innerHTML = renderMarkdown(message.text);
				// Only on a finished answer: reading a half-written one aloud
				// would synthesise a sentence that is about to change.
				if (!message.pending && !message.failed && message.text) {
					node.append(speakButton(message.text));
				}
			}
			ui.messages.append(node);
		}

		if (stick) ui.messages.scrollTop = ui.messages.scrollHeight;
	}

	/**
	 * Reads an answer aloud through the host's TTS sidecar. Best effort: if the
	 * host has never turned speech on, the button says so once and stops
	 * offering something that does not work.
	 */
	/** @param {string} text */
	function speakButton(text) {
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'speak';
		button.textContent = 'Listen';
		button.setAttribute('aria-label', 'Read this answer aloud');
		button.addEventListener('click', async () => {
			button.disabled = true;
			button.textContent = 'Loading…';
			try {
				const response = await net(`/api/speak?t=${auth}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text })
				});
				if (!response.ok) {
					button.textContent = response.status === 503 ? 'No speech' : 'Failed';
					return;
				}
				const audio = new Audio(URL.createObjectURL(await response.blob()));
				audio.addEventListener('ended', () => {
					button.disabled = false;
					button.textContent = 'Listen';
				});
				await audio.play();
				button.textContent = 'Playing…';
			} catch {
				button.textContent = 'Failed';
			}
		});
		return button;
	}

	/**
	 * The assistant message being written, created if this is its first text.
	 *
	 * @returns {Bubble}
	 */
	function assistantSlot() {
		const last = transcript[transcript.length - 1];
		if (last && last.role === 'assistant' && last.turnId === currentTurn) return last;
		/** @type {Bubble} */
		const slot = { role: 'assistant', text: '', turnId: currentTurn, pending: true };
		transcript.push(slot);
		return slot;
	}

	/** @param {boolean} value */
	function setBusy(value) {
		busy = value;
		ui.send.disabled = value;
		ui.stop.hidden = !value;
	}

	/** @param {string | undefined} status @returns {string} */
	function statusText(status) {
		switch (status) {
			case 'waiting':
				// The one that matters: the host is mid-turn on a single-slot
				// local model, and a spinner alone would read as a broken page.
				return 'Waiting for the desktop…';
			case 'running':
				return 'Answering…';
			case 'failed':
				return 'Something went wrong';
			default:
				return 'Ready';
		}
	}

	/** @param {any} event A frame from the server's SSE stream. */
	function handle(event) {
		switch (event.type) {
			case 'snapshot': {
				// Sent on every (re)connect. A phone that locked its screen
				// rejoins here with the text it missed already written.
				if (!event.turnId) {
					render();
					return;
				}
				currentTurn = event.turnId;
				const slot = assistantSlot();
				slot.text = event.text ?? '';
				slot.pending = event.status === 'waiting' || event.status === 'running';
				if (event.status === 'failed' && event.message) {
					slot.text = event.message;
					slot.failed = true;
				}
				if (!slot.pending) currentTurn = null;
				setBusy(slot.pending);
				setStatus(statusText(event.status));
				render();
				saveTranscript();
				break;
			}
			case 'state': {
				currentTurn = event.turnId;
				setStatus(statusText(event.status));
				break;
			}
			case 'delta': {
				currentTurn = event.turnId;
				const slot = assistantSlot();
				slot.text += event.text;
				slot.pending = true;
				setStatus('Answering…');
				render();
				break;
			}
			case 'done': {
				currentTurn = event.turnId;
				const slot = assistantSlot();
				slot.text = event.text ?? slot.text;
				slot.pending = false;
				currentTurn = null;
				setBusy(false);
				setStatus('Ready');
				render();
				saveTranscript();
				break;
			}
			case 'error': {
				currentTurn = event.turnId;
				const slot = assistantSlot();
				slot.text = event.message || 'Something went wrong.';
				slot.failed = true;
				slot.pending = false;
				currentTurn = null;
				setBusy(false);
				setStatus('Something went wrong', true);
				render();
				saveTranscript();
				break;
			}
			default:
				break;
		}
	}

	function connect() {
		if (!Stream || !token) return;
		const url = `/api/stream/${encodeURIComponent(sessionId)}?t=${auth}`;
		stream = new Stream(url);
		stream.onopen = () => setStatus(busy ? 'Answering…' : 'Ready');
		stream.onmessage = (/** @type {{data: string}} */ event) => {
			try {
				handle(JSON.parse(event.data));
			} catch {
				// A frame we cannot parse is not worth tearing the page down for.
			}
		};
		stream.onerror = () => {
			// EventSource reconnects on its own and the server replays a
			// snapshot when it does, so this is a status change and no more.
			setStatus('Reconnecting…', true);
		};
	}

	/** @param {string} text */
	function fail(text) {
		transcript.push({ role: 'assistant', text, failed: true });
		setBusy(false);
		setStatus(text, true);
		render();
		saveTranscript();
	}

	/** @param {string} text */
	async function send(text) {
		transcript.push({ role: 'user', text });
		saveTranscript();
		setBusy(true);
		setStatus('Sending…');
		render();

		try {
			const response = await net(`/api/chat?t=${auth}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, message: text })
			});
			if (!response.ok) {
				// The server's own words: "too many messages — slow down a
				// moment" is more use to a guest than a status code.
				const reason = (await response.text().catch(() => '')) || `Error ${response.status}`;
				fail(reason);
				return;
			}
			const body = await response.json().catch(() => ({}));
			if (body.turnId) currentTurn = body.turnId;
		} catch {
			fail('Could not reach the computer running Haruspex.');
		}
	}

	function isTouch() {
		return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	}

	ui.composer.addEventListener('submit', (event) => {
		event.preventDefault();
		const text = ui.input.value.trim();
		if (!text || busy) return;
		ui.input.value = '';
		ui.input.style.height = 'auto';
		void send(text);
	});

	ui.input.addEventListener('keydown', (event) => {
		// Enter sends, Shift+Enter makes a newline — except on a touch keyboard,
		// where Enter is the only way to get one.
		if (event.key === 'Enter' && !event.shiftKey && !isTouch()) {
			event.preventDefault();
			ui.composer.requestSubmit();
		}
	});

	ui.input.addEventListener('input', () => {
		ui.input.style.height = 'auto';
		ui.input.style.height = `${ui.input.scrollHeight}px`;
	});

	ui.stop.addEventListener('click', () => {
		void net(`/api/cancel?t=${auth}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId })
		}).catch(() => {});
		setStatus('Stopping…');
	});

	if (!token) {
		setStatus('You need the link its host shared with you', true);
		ui.send.disabled = true;
		ui.input.disabled = true;
		render();
		return { handle, render };
	}

	render();
	connect();

	// Returned for tests; the page itself is driven entirely by events.
	return {
		handle,
		send,
		render,
		sessionId,
		get transcript() {
			return transcript;
		},
		close: () => stream?.close()
	};
}
