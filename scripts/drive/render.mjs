/**
 * Turning a Code session, as `window.__haruspexDrive.codeSessions()` returns
 * it, into something a person or an agent reads: a markdown transcript and a
 * short summary. Pure functions; no app needed.
 */

const TOOL_RESULT_MAX = 4000;

export function text(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

export function clip(s, max = TOOL_RESULT_MAX) {
	return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

/**
 * Split an assistant message into its reasoning and its answer. The app
 * stores reasoning inline as `<think>…</think>` ahead of the answer
 * (`streamAssembly.ts`) and renders it as a Reasoning panel.
 */
export function splitThinking(body) {
	const reasoning = [];
	const answer = body
		.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, inner) => {
			if (inner.trim()) reasoning.push(inner.trim());
			return '';
		})
		.trim();
	return { reasoning: reasoning.join('\n\n'), answer };
}

function fence(body, lang = '') {
	const ticks = body.includes('```') ? '````' : '```';
	return `${ticks}${lang}\n${body}\n${ticks}`;
}

function args(raw) {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

function diffText(d) {
	const rows = d.rows.map((r) => {
		if (r.kind === 'gap') return `@@ ${r.skipped} unchanged lines @@`;
		return `${r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}${r.text}`;
	});
	return `${d.mode} ${d.path} (+${d.added} -${d.removed})${d.truncated ? ', truncated' : ''}\n${fence(rows.join('\n'), 'diff')}`;
}

/** The session as markdown: every message, tool call, result and diff, in order. */
export function transcript(s, meta) {
	const out = [
		`# Code session ${s.id}`,
		'',
		`- Folder: \`${s.root}\``,
		`- Model: \`${meta.model}\` at ${meta.baseUrl}`,
		`- Status: ${s.status}${s.lastError ? `, error: ${s.lastError}` : ''}`,
		''
	];
	// Diffs and steps hang off the answer that ends a turn; find them by call id.
	const steps = new Map();
	for (const list of Object.values(s.messageSteps ?? {})) {
		for (const step of list) steps.set(step.id, step);
	}
	for (const step of s.searchSteps ?? []) steps.set(step.id, step);

	s.messages.forEach((m, i) => {
		const body = text(m.content);
		if (m.role === 'user') {
			out.push(`## User (#${i})`, '', body, '');
		} else if (m.role === 'assistant') {
			out.push(`## Assistant (#${i})`, '');
			const { reasoning, answer } = splitThinking(body);
			if (reasoning)
				out.push(`<details><summary>Reasoning</summary>\n\n${reasoning}\n\n</details>`, '');
			if (answer) out.push(answer, '');
			for (const tc of m.tool_calls ?? []) {
				out.push(`### Tool call \`${tc.function?.name}\` (${tc.id})`, '');
				out.push(fence(args(tc.function?.arguments ?? ''), 'json'), '');
			}
			const stop = s.messageStops?.[i];
			if (stop) out.push(`_Stopped: ${stop}_`, '');
			const stats = s.messageStats?.[i];
			if (stats) out.push(`_Stats: ${JSON.stringify(stats)}_`, '');
		} else if (m.role === 'tool') {
			out.push(`### Tool result (${m.tool_call_id})`, '', fence(clip(body)), '');
			const step = steps.get(m.tool_call_id);
			if (step?.diff) out.push(diffText(step.diff), '');
		} else {
			out.push(`## ${m.role} (#${i})`, '', body, '');
		}
	});
	if (s.streamingContent) out.push('## (still streaming)', '', s.streamingContent, '');
	return out.join('\n');
}

export function summarize(s) {
	const calls = s.messages.flatMap((m) => m.tool_calls ?? []);
	const counts = {};
	for (const c of calls) counts[c.function?.name] = (counts[c.function?.name] ?? 0) + 1;
	const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
	return {
		turns: s.messages.filter((m) => m.role === 'user').length,
		modelReplies: s.messages.filter((m) => m.role === 'assistant').length,
		toolCalls: calls.length,
		toolCounts: counts,
		status: s.status,
		error: s.lastError,
		lastAssistant: last ? splitThinking(text(last.content)).answer.slice(0, 300) : null
	};
}
