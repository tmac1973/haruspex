/**
 * Pure reads of the conversation and the model's output that the loop
 * branches on (code context, image-only requests, clarifying questions,
 * reasoning-only answers), and the nudge and error texts they lead to.
 */

import { messageText, type ChatMessage } from '#lib/api.ts';
import { TOKEN_BYTES_RATIO } from '#lib/agent/context-budget.ts';
import type { LoopContext } from './context';

/**
 * Decide whether the next completion should use the active model's
 * "coding" sampling profile (per the Qwen 3.5 recommendations: lower
 * temperature, zero presence_penalty). The signal is local — we walk
 * the most recent assistant/tool exchange:
 *
 *   - A tool result containing `<diagnostics file="*.py">` means we
 *     just lint-errored Python and the model is about to fix it.
 *   - An assistant tool call against `run_python`, or `fs_write_text` /
 *     `fs_edit_text` on a .py path, means the model is actively writing
 *     Python — the next iteration is overwhelmingly going to be more
 *     Python.
 *
 * Any other exchange (web fetches, email, plain prose) returns false
 * and we use the general profile.
 */
/**
 * True if any of an assistant turn's tool calls is Python work: a run_python
 * call, or an fs_edit_text / fs_write_text against a `.py` path.
 */
function assistantTouchesPython(toolCalls: NonNullable<ChatMessage['tool_calls']>): boolean {
	for (const tc of toolCalls) {
		const name = tc.function?.name;
		if (name === 'run_python') return true;
		if (name === 'fs_edit_text' || name === 'fs_write_text') {
			try {
				const args = JSON.parse(tc.function.arguments) as { path?: string };
				if (args.path?.toLowerCase().endsWith('.py')) return true;
			} catch {
				// Unparseable arguments — treat as not-code-context.
			}
		}
	}
	return false;
}

/** The "open 2-3 distinct sources" nudge pushed when a turn researched too narrowly. */
/**
 * Recognises a request that images alone can satisfy, so the research nudge
 * does not fire on someone who only wanted a picture. Same shape as
 * `looksLikeReviewQuery` / `looksLikeFileOutputRequest` in system-prompt.ts.
 */
const IMAGE_ONLY_PATTERNS =
	/\b(show|find|get|give|send)\s+(me\s+)?(a\s+|some\s+|the\s+)?(pic(ture)?s?|photos?|images?|shots?)\b|\bwhat\s+do(es)?\s+.*look\s+like\b|\bpic(ture)?s?\s+of\b|\bimages?\s+of\b/i;

export function looksLikeImageOnlyRequest(content: string): boolean {
	return IMAGE_ONLY_PATTERNS.test(content);
}

/**
 * Did the model write a remote markdown image reference?
 *
 * Only `http(s)` counts. The Python sandbox legitimately produces
 * `![plot](data:image/png;base64,…)` for inline charts, and models routinely
 * write `![plot](sine_wave.png)` after saving a figure — neither is a claim to
 * have found a picture on the web.
 */
export function wroteRemoteImageMarkdown(content: string | null | undefined): boolean {
	return /!\[[^\]]*\]\(\s*https?:/i.test(content ?? '');
}

export function phantomImageNudgePrompt(): string {
	return (
		'STOP. Your answer contains image links, but you never called ' +
		'image_search, so those URLs are ones you made up. They do not exist and ' +
		'nothing will be displayed. You MUST call image_search now to find real ' +
		'pictures. Your NEXT output must be a tool_calls block invoking ' +
		'image_search — do not reply with text. When the results come back, use ' +
		'a thumb_url exactly as it appears in them, and never write an image URL ' +
		'from memory.'
	);
}

export function researchNudgePrompt(): string {
	return (
		'STOP. The only tool you have called this turn is image_search, which finds ' +
		'pictures and tells you nothing about the subject. You have not researched ' +
		'the question at all, so anything you write now comes from memory and cannot ' +
		'be cited. You MUST now call web_search for the topic, then fetch_url or ' +
		'research_url on 2-3 of the results. Do NOT reply with text describing what ' +
		'you plan to search for — your NEXT output must be a tool_calls block. Once ' +
		'the pages come back, write the answer with [source](URL) citations, and keep ' +
		'the image you already found.'
	);
}

export function diversityNudgePrompt(fetchedCount: number): string {
	return (
		`STOP. You have opened ${fetchedCount === 0 ? 'no pages' : 'only one page'} ` +
		'this turn. A complete answer needs 2–3 distinct sources covering different ' +
		'angles (e.g. an official body, an academic / think-tank source, and a ' +
		'journalistic or community account). You MUST now call fetch_url on two or ' +
		'three additional URLs from the prior web_search results — pick ones that ' +
		'plausibly cover the sub-points your answer will make. Do NOT reply with ' +
		'text describing the URLs you plan to fetch — your NEXT output must be a ' +
		'tool_calls block invoking fetch_url. After the fetches return, produce the ' +
		'final answer with [source](URL) citations pointing to the specific page ' +
		'where each claim appeared — do not reuse the same URL across unrelated claims.'
	);
}

export function isCodeContext(messages: ChatMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'tool') {
			if (/<diagnostics file="[^"]+\.py"/i.test(messageText(msg.content))) return true;
			continue;
		}
		if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
			return assistantTouchesPython(msg.tool_calls);
		}
		if (msg.role === 'user') return false;
	}
	return false;
}

/**
 * Returns true if the model's response appears to be asking the user
 * a clarifying question rather than ending the turn with an answer.
 * Used as a guard on the file-write hallucination recovery so we don't
 * interrupt legitimate "which sections should I include?" style replies.
 */
export function looksLikeClarifyingQuestion(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length === 0) return false;
	return /\?\s*$/.test(trimmed);
}

/**
 * True if `content` carries real answer prose once `<think>...</think>`
 * reasoning blocks are stripped out. With thinking mode on (the default),
 * a tool-check response can come back as reasoning only — the API layer's
 * `combineReasoningAndContent` packs that into a bare `<think>...</think>`
 * string. That is NOT a final answer: committing it directly ends the turn
 * with the model's reasoning (or, after the UI strips it, nothing) shown
 * instead of a reply, which is exactly the "model stops before answering,
 * I have to say continue" failure. Such responses must fall through to the
 * tool-less re-stream that forces a real answer.
 */
export function hasNonThinkingContent(content: string | null | undefined): boolean {
	if (!content) return false;
	return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim().length > 0;
}

/**
 * The "ran out of tokens" error, naming the limit that was actually hit.
 *
 * This message used to tell the user to raise the context size. That is the
 * wrong dial and sends people on a long detour: the ceiling here is the
 * per-response output cap, which is independent of context. The report that
 * prompted this had a 256K context with 20K of it in use — the answer was
 * truncated at an 8192-token output cap the message never mentioned.
 */
export function outOfTokensMessage(ctx: LoopContext, postTools: boolean): string {
	const settingLabel = ctx.expectsFileOutput
		? 'Max response tokens (file writes)'
		: 'Max response tokens';
	const approxKb = Math.round((ctx.maxResponseTokens * TOKEN_BYTES_RATIO) / 1024);
	return (
		`The model ran out of room before finishing its answer. It hit the ` +
		`${ctx.maxResponseTokens}-token response limit — roughly ${approxKb} KB of ` +
		`output, less whatever the model spent reasoning. This is a separate ` +
		`setting from the context size, which is not what ran out here. Raise ` +
		`Settings → Agent → Response Length → ${settingLabel}, ask for a smaller ` +
		`piece of work, or lower the reasoning effort so more of the budget goes ` +
		`to the answer.` +
		(postTools
			? ` If the turn gathered a lot of material, a narrower question or ` +
				`disabling deep research will also leave more room.`
			: '')
	);
}
