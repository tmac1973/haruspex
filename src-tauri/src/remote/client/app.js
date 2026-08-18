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
const LABEL_KEY = 'haruspex-remote-label';

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

/**
 * Markdown escapes: models write citations as `[\[1\]](url)`, and a backslash
 * that survives to the page is a backslash the reader has to mentally delete.
 * Applied last, so `\*not italic\*` keeps its asterisks rather than becoming
 * emphasis.
 *
 * @param {string} text @returns {string}
 */
function unescapeMarkdown(text) {
	return text.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1');
}

/** @param {string} text @returns {string} */
function inline(text) {
	let out = text;
	out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
	// The label may contain escaped brackets, which is exactly how a model
	// writes a footnote marker — without allowing for it, every citation in an
	// answer renders as raw punctuation.
	out = out.replace(/\[((?:[^\]\\\n]|\\.)*)\]\(([^)\s]+)\)/g, (match, label, href) => {
		const url = safeUrl(href.replace(/&amp;/g, '&'));
		return url
			? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${unescapeMarkdown(label)}</a>`
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
	return unescapeMarkdown(out);
}

/** @param {string[]} lines @param {number} start */
function tableAt(lines, start) {
	const header = lines[start];
	const divider = lines[start + 1];
	if (!header || !divider || !header.includes('|')) return null;
	// The row of dashes is what distinguishes a table from a sentence with a
	// pipe in it.
	if (!/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(divider)) return null;

	/** @param {string} row */
	const cells = (row) =>
		row
			.replace(/^\s*\|/, '')
			.replace(/\|\s*$/, '')
			.split('|')
			.map((cell) => cell.trim());

	const head = cells(header)
		.map((cell) => `<th>${inline(cell)}</th>`)
		.join('');
	let i = start + 2;
	const body = [];
	while (i < lines.length && lines[i].includes('|')) {
		body.push(`<tr>${cells(lines[i]).map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
		i++;
	}
	return {
		html: `<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`,
		next: i
	};
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
// `>` has already been escaped by the time blocks are parsed.
const QUOTE = /^\s*&gt;\s?/;

/**
 * One block, line by line rather than all-or-nothing.
 *
 * The first version asked whether *every* line in a block was a list item,
 * which is not how anyone writes: "Old World monkeys" followed immediately by
 * four bullets is one block, and it rendered as a paragraph with the dashes
 * left in. Runs of like lines are grouped instead, so a lead-in line and its
 * list come out as a paragraph and a list.
 *
 * @param {string} trimmed @param {RegExp} placeholder @returns {string}
 */
function renderBlock(trimmed, placeholder) {
	const lines = trimmed.split('\n');
	let html = '';
	let i = 0;

	/** @param {string} line */
	const isProse = (line) =>
		!HEADING.test(line) &&
		!RULE.test(line) &&
		!BULLET.test(line) &&
		!NUMBERED.test(line) &&
		!QUOTE.test(line) &&
		!placeholder.test(line.trim());

	while (i < lines.length) {
		const line = lines[i];

		if (placeholder.test(line.trim())) {
			html += line.trim();
			i++;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			html += `<h${level}>${inline(heading[2].trim())}</h${level}>`;
			i++;
			continue;
		}

		if (RULE.test(line)) {
			html += '<hr />';
			i++;
			continue;
		}

		const table = tableAt(lines, i);
		if (table) {
			html += table.html;
			i = table.next;
			continue;
		}

		if (BULLET.test(line)) {
			const items = [];
			while (i < lines.length && BULLET.test(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(BULLET, ''))}</li>`);
				i++;
			}
			html += `<ul>${items.join('')}</ul>`;
			continue;
		}

		if (NUMBERED.test(line)) {
			const items = [];
			while (i < lines.length && NUMBERED.test(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(NUMBERED, ''))}</li>`);
				i++;
			}
			html += `<ol>${items.join('')}</ol>`;
			continue;
		}

		if (QUOTE.test(line)) {
			const quoted = [];
			while (i < lines.length && QUOTE.test(lines[i])) {
				quoted.push(lines[i].replace(QUOTE, ''));
				i++;
			}
			html += `<blockquote>${inline(quoted.join('\n')).replace(/\n/g, '<br />')}</blockquote>`;
			continue;
		}

		const prose = [];
		while (i < lines.length && isProse(lines[i]) && !tableAt(lines, i)) {
			prose.push(lines[i]);
			i++;
		}
		if (prose.length) {
			html += `<p>${inline(prose.join('\n')).replace(/\n/g, '<br />')}</p>`;
		} else if (i < lines.length && prose.length === 0 && isProse(line)) {
			// Cannot happen with the guards above, but a loop that might not
			// advance is not something to leave to reasoning.
			i++;
		}
	}
	return html;
}

/**
 * A deliberately small subset: headings, fenced and inline code, bold, italic,
 * links, lists, quotes, rules and tables. Not the app's renderer — no images
 * and no raw HTML passthrough — but wide enough that an ordinary answer arrives
 * as prose rather than as punctuation.
 *
 * @param {unknown} text @returns {string}
 */
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
			return trimmed ? renderBlock(trimmed, placeholder) : '';
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
	const greetingEl = /** @type {HTMLFormElement | null} */ (doc.getElementById('greeting'));
	const nameEl = /** @type {HTMLInputElement | null} */ (doc.getElementById('name'));
	const skipEl = /** @type {HTMLButtonElement | null} */ (doc.getElementById('skip'));
	// All or nothing: a page missing one of these is a page this script cannot
	// drive, and failing here beats throwing halfway through a guest's first
	// message.
	if (
		!messagesEl ||
		!statusEl ||
		!composerEl ||
		!inputEl ||
		!sendEl ||
		!stopEl ||
		!greetingEl ||
		!nameEl ||
		!skipEl
	) {
		return null;
	}

	const ui = {
		messages: messagesEl,
		status: statusEl,
		composer: composerEl,
		input: inputEl,
		send: sendEl,
		stop: stopEl,
		greeting: greetingEl,
		name: nameEl,
		skip: skipEl
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
	// Asked once and remembered, so the host's sidebar says who is talking to
	// their machine rather than listing identical threads. `null` means the
	// question has not been answered; an empty string means it was skipped.
	let label = readStore(store, LABEL_KEY);

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
		// A bubble that is still pending is adopted even if it was created
		// before the server handed back a turn id — otherwise the placeholder
		// that shows something is happening would be orphaned beside the real
		// answer.
		if (last && last.role === 'assistant' && (last.turnId === currentTurn || last.pending)) {
			last.turnId = currentTurn;
			return last;
		}
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
				// It has the slot, but nothing is written yet — a model can
				// reason for a minute before its first word.
				return 'Thinking…';
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
				// Show the waiting bubble as soon as the turn is accepted. The
				// first version only created it on the first delta, so a guest
				// asked a question and watched nothing happen — for as long as
				// the model spent thinking.
				assistantSlot().pending = true;
				setStatus(statusText(event.status));
				render();
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
		// Reuses the placeholder rather than leaving it blinking beside an
		// error message.
		const slot = assistantSlot();
		slot.text = text;
		slot.failed = true;
		slot.pending = false;
		currentTurn = null;
		setBusy(false);
		setStatus(text, true);
		render();
		saveTranscript();
	}

	/** @param {string} text */
	async function send(text) {
		transcript.push({ role: 'user', text });
		// Optimistic placeholder: the wait for the server to accept the prompt
		// is short, but it is not nothing, and silence after pressing send is
		// what makes a page feel broken.
		transcript.push({ role: 'assistant', text: '', turnId: null, pending: true });
		saveTranscript();
		setBusy(true);
		setStatus('Sending…');
		render();

		try {
			const response = await net(`/api/chat?t=${auth}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, message: text, clientLabel: label || null })
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

	function askForName() {
		ui.greeting.hidden = false;
		ui.composer.hidden = true;
	}

	/** @param {string} value */
	function rememberName(value) {
		label = value;
		writeStore(store, LABEL_KEY, value);
		ui.greeting.hidden = true;
		ui.composer.hidden = false;
		ui.input.focus();
	}

	ui.greeting.addEventListener('submit', (event) => {
		event.preventDefault();
		rememberName(ui.name.value.trim());
	});

	// A guest who would rather not give a name still gets an answer.
	ui.skip.addEventListener('click', () => rememberName(''));

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
	if (label === null) askForName();

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
