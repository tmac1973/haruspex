import { describe, it, expect } from 'vitest';
import { classifyFindings, isPlanClean, verifierPrompt } from './pipeline';

/**
 * This project has no `@types/node` — it is a browser bundle, and adding the
 * package for one dev-only script would put Node globals in scope everywhere.
 * Vitest runs this file under Node regardless, so the module is resolved
 * through a variable specifier, which TypeScript declines to resolve rather
 * than reports as missing, and the shape is declared here instead.
 */
const nodeFs = 'node:fs';
const { readFileSync, readdirSync, writeFileSync } = (await import(nodeFs)) as {
	readFileSync: (path: string, encoding: string) => string;
	readdirSync: (path: string) => string[];
	writeFileSync: (path: string, data: string) => void;
};
declare const process: { env: Record<string, string | undefined> };

/** `path.join` for the one case here: a directory and a filename. */
const join = (dir: string, file: string) => `${dir.replace(/\/+$/, '')}/${file}`;

/**
 * A/B: does the verifier still find real problems with thinking turned off?
 *
 * Run 51 measured the verifier at 98.2% reasoning — 33 calls generated 138,055
 * tokens, of which 135,540 were thinking, to produce a couple of thousand
 * tokens of findings. That makes it the largest single pool of reasoning in a
 * guided-planning run and the obvious first candidate for turning thinking
 * down. It is also the stage the chain gate depends on, so it is the one place
 * where cutting reasoning could cost something that matters.
 *
 * This is deliberately NOT a full replay of the stage. The real verifier is an
 * agentic turn that reads the plan with tools; here the plan is inlined and one
 * completion is taken, which removes tool-loop variance and isolates the
 * variable under test: given identical plan content, what does thinking buy?
 * A finding the no-think run misses here is evidence; a timing difference here
 * understates the real one, because the real turn pays per tool call.
 *
 * Skipped unless pointed at a plan and a backend:
 *
 *   HARUSPEX_AB_PLAN=/path/to/plan/<feature>/ \
 *   HARUSPEX_AB_URL=http://compute:3000 \
 *   HARUSPEX_AB_MODEL=<id, or omit to take the first the server lists> \
 *   HARUSPEX_AB_RUNS=3 \
 *   npx vitest run verifierReasoning
 *
 * That runs the stability probe. Add HARUSPEX_AB_THINKING=1 to also run the
 * thinking-on/off comparison, which costs a second pass per run.
 */
const PLAN_DIR = process.env.HARUSPEX_AB_PLAN;
/** The thinking-on/off comparison is expensive; opt into it explicitly. */
const RUN_AB = process.env.HARUSPEX_AB_THINKING === '1';
// Required rather than defaulted: which backend is free varies, and a default
// that silently points at the wrong host wastes a run before it fails.
const BASE_URL = process.env.HARUSPEX_AB_URL ?? '';
const RUNS = Number(process.env.HARUSPEX_AB_RUNS ?? '1');

interface Attempt {
	thinking: boolean;
	ms: number;
	completionTokens: number;
	reasoningTokens: number;
	/** Why generation stopped. `length` means the answer never arrived. */
	finishReason: string;
	verdict: string;
	blocking: string[];
	advisory: string[];
}

async function resolveModel(): Promise<string> {
	if (process.env.HARUSPEX_AB_MODEL) return process.env.HARUSPEX_AB_MODEL;
	const res = await fetch(`${BASE_URL}/v1/models`);
	const body = (await res.json()) as { data?: { id?: string }[] };
	const id = body.data?.[0]?.id;
	if (!id) throw new Error(`No model advertised at ${BASE_URL}/v1/models`);
	return id;
}

/** The plan as the verifier would have read it, inlined. */
function readPlan(dir: string) {
	const overview = readFileSync(join(dir, 'overview.md'), 'utf8');
	const phases = readdirSync(dir)
		.filter((f) => /^phase-\d+.*\.md$/.test(f))
		.sort()
		.map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
	return { overview, phases };
}

async function askVerifier(model: string, thinking: boolean): Promise<Attempt> {
	const { overview, phases } = readPlan(PLAN_DIR!);
	// The real prompt, with the overview inlined exactly as the pipeline does.
	const system = verifierPrompt('plan/', 'plan/overview.md', overview);
	const userMessage = [
		'The phase files are reproduced below — you have no tools in this run, so',
		'review them as given rather than reading them from disk.',
		'',
		...phases.flatMap((p) => [`--- ${p.name} ---`, p.text, `--- END ${p.name} ---`, ''])
	].join('\n');

	const started = Date.now();
	// Streamed, and not for the progress: a non-streaming request sends no
	// response headers until generation finishes, and Node's fetch abandons the
	// connection after 300s of waiting for them. A review of a 69k-token plan
	// with thinking on takes longer than that.
	const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: userMessage }
			],
			// Generous: a review of a 69k-token plan with thinking on spends most
			// of its budget before the findings start, and an answer that never
			// arrives is indistinguishable from a plan with no problems.
			max_tokens: 65536,
			stream: true,
			stream_options: { include_usage: true },
			chat_template_kwargs: { enable_thinking: thinking }
		})
	});
	if (!res.ok) {
		const text = await res.text();
		// The common one, and opaque on its own: the server already has a model
		// loaded (the app, most likely) and will not auto-load a second.
		if (text.includes('model limit reached')) {
			throw new Error(
				`${BASE_URL} already has a different model loaded and will not load ` +
					`"${model}" alongside it. Either set HARUSPEX_AB_MODEL to the model ` +
					`that is already loaded, or stop whatever is holding it.\n\n${text}`
			);
		}
		throw new Error(`${res.status} ${text}`);
	}
	const stream = res.body;
	if (!stream) throw new Error('no response body');
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	let verdict = '';
	let reasoningChars = 0;
	let finishReason = '?';
	let completionTokens = 0;
	let reasoningTokens = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const lines = buffered.split('\n');
		// Keep the last fragment: an SSE event can be split across chunks.
		buffered = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') continue;
			let chunk: {
				choices?: {
					delta?: { content?: string; reasoning_content?: string };
					finish_reason?: string;
				}[];
				usage?: { completion_tokens?: number; reasoning_tokens?: number };
			};
			try {
				chunk = JSON.parse(payload);
			} catch {
				continue;
			}
			const choice = chunk.choices?.[0];
			verdict += choice?.delta?.content ?? '';
			reasoningChars += (choice?.delta?.reasoning_content ?? '').length;
			if (choice?.finish_reason) finishReason = choice.finish_reason;
			if (chunk.usage?.completion_tokens) completionTokens = chunk.usage.completion_tokens;
			if (chunk.usage?.reasoning_tokens) reasoningTokens = chunk.usage.reasoning_tokens;
		}
	}

	const { blocking, advisory } = classifyFindings(verdict);
	return {
		thinking,
		finishReason,
		ms: Date.now() - started,
		completionTokens,
		reasoningTokens: reasoningTokens || Math.round(reasoningChars / 4),
		verdict,
		blocking,
		advisory
	};
}

function report(label: string, attempts: Attempt[]) {
	console.log(`\n=== ${label} ===`);
	for (const [i, a] of attempts.entries()) {
		const outcome = !a.verdict.trim()
			? `NO ANSWER (finish_reason=${a.finishReason})`
			: isPlanClean(a.verdict)
				? 'PLAN OK'
				: `${a.blocking.length} blocking, ${a.advisory.length} advisory`;
		console.log(
			`  run ${i + 1}: ${(a.ms / 1000).toFixed(1)}s  ${a.completionTokens} tok ` +
				`(${a.reasoningTokens} reasoning, finish=${a.finishReason})  ${outcome}`
		);
	}
	const findings = new Set(attempts.flatMap((a) => [...a.blocking, ...a.advisory]));
	if (findings.size > 0) {
		console.log('  findings across runs:');
		for (const f of findings) console.log(`    - ${f.slice(0, 160)}`);
	}
}

/**
 * How much of a review's output is the plan, and how much is the sampling?
 *
 * Run 52's three review rounds found 14, 16 and 7 problems, and round 3's
 * seven appeared in neither of the first two — while five of its seven files
 * had already been flagged for different reasons. Revisions were fixing what
 * was reported; each fresh pass simply reported something else.
 *
 * That has two possible causes and they call for opposite fixes. If repeated
 * reviews of an UNCHANGED plan agree, findings are stable, the plan really
 * does have a long tail of defects, and more rounds grind through it. If they
 * disagree, a single pass recalls a different subset each time, the count
 * never reaches zero however many rounds are spent, and a gate demanding zero
 * can never open.
 *
 * So: same plan, same settings, N times, nothing edited in between.
 */
describe.skipIf(!PLAN_DIR || !BASE_URL)('verifier finding stability (live)', () => {
	it(
		'reviews an unchanged plan repeatedly and reports how much they agree',
		async () => {
			const model = await resolveModel();
			console.log(`\nplan:  ${PLAN_DIR}\nmodel: ${model}\npasses: ${RUNS}\n`);

			const passes: Attempt[] = [];
			for (let i = 0; i < RUNS; i++) passes.push(await askVerifier(model, true));
			report('independent reviews of the SAME plan', passes);

			// Match on (category, file, opening words): the same defect reworded
			// between passes should still count as the same defect.
			const key = (f: string) => {
				const m = /^\(([a-z])\)\s*(\S+?\.md)?\s*:?\s*(.*)$/.exec(f);
				return m
					? `${m[1]}|${m[2] ?? ''}|${m[3].toLowerCase().split(/\s+/).slice(0, 8).join(' ')}`
					: f.slice(0, 80);
			};
			// Dump every verdict before any matching happens. Deciding whether two
			// differently-worded findings are the same defect is a judgement, and
			// one worth revisiting without paying five minutes a pass to re-run.
			const out = process.env.HARUSPEX_AB_OUT;
			if (out) {
				writeFileSync(
					out,
					JSON.stringify(
						passes.map((a) => ({
							finishReason: a.finishReason,
							ms: a.ms,
							completionTokens: a.completionTokens,
							blocking: a.blocking,
							advisory: a.advisory,
							verdict: a.verdict
						})),
						null,
						2
					)
				);
				console.log(`\nverdicts written to ${out}`);
			}

			// An empty verdict is not "no problems found" — it is no answer, and
			// including one would force the overlap to zero by itself.
			const answered = passes.filter((a) => a.verdict.trim().length > 0);
			const silent = passes.length - answered.length;
			if (silent > 0) console.log(`\n${silent} of ${passes.length} passes returned no answer.`);
			const sets = answered.map((a) => new Set([...a.blocking, ...a.advisory].map(key)));
			const union = new Set(sets.flatMap((s) => [...s]));
			const inAll = sets.length > 0 ? [...union].filter((k) => sets.every((s) => s.has(k))) : [];

			console.log(
				`\ndistinct findings across ${sets.length} answering passes: ${union.size}` +
					`\nfound by EVERY pass: ${inAll.length}` +
					`\nfound by exactly one: ${[...union].filter((k) => sets.filter((s) => s.has(k)).length === 1).length}`
			);
			console.log(
				'\nIf "found by every pass" is close to the per-pass count, findings are ' +
					'stable and more rounds will grind the tail down. If most are found by ' +
					'exactly one pass, the gate cannot converge and the plan needs a ' +
					'different contract with the coding run.'
			);

			// Two answering passes is the minimum that can show agreement at all.
			// Fewer means the run measured nothing, which is worth failing over —
			// but a pass that answered nothing is reported, not hidden.
			expect(sets.length).toBeGreaterThanOrEqual(2);
		},
		60 * 60 * 1000
	);
});

describe.skipIf(!PLAN_DIR || !BASE_URL || !RUN_AB)('verifier reasoning A/B (live)', () => {
	it(
		'compares findings and cost with thinking on vs off',
		async () => {
			const model = await resolveModel();
			console.log(`\nplan:  ${PLAN_DIR}\nmodel: ${model}\nruns:  ${RUNS} each\n`);

			const withThinking: Attempt[] = [];
			const without: Attempt[] = [];
			for (let i = 0; i < RUNS; i++) {
				withThinking.push(await askVerifier(model, true));
				without.push(await askVerifier(model, false));
			}

			report('thinking ON', withThinking);
			report('thinking OFF', without);

			const sum = (xs: Attempt[], f: (a: Attempt) => number) =>
				xs.reduce((n, a) => n + f(a), 0) / xs.length;
			console.log(
				`\nmean: ON ${(sum(withThinking, (a) => a.ms) / 1000).toFixed(1)}s / ` +
					`${Math.round(sum(withThinking, (a) => a.completionTokens))} tok   vs   ` +
					`OFF ${(sum(without, (a) => a.ms) / 1000).toFixed(1)}s / ` +
					`${Math.round(sum(without, (a) => a.completionTokens))} tok`
			);

			// What the decision turns on, stated so it is not lost in the numbers:
			// a finding the thinking run reports and the no-think run never does.
			const onFindings = new Set(withThinking.flatMap((a) => [...a.blocking, ...a.advisory]));
			const offFindings = new Set(without.flatMap((a) => [...a.blocking, ...a.advisory]));
			const onlyWithThinking = [...onFindings].filter((f) => !offFindings.has(f));
			console.log(
				`\nfindings only the thinking run produced: ${onlyWithThinking.length}` +
					(onlyWithThinking.length
						? `\n${onlyWithThinking.map((f) => `  - ${f.slice(0, 200)}`).join('\n')}`
						: '')
			);

			// The experiment has to produce something to compare, or it proved
			// nothing — a backend that answered nothing at all is not evidence
			// that thinking is unnecessary.
			expect(withThinking.every((a) => a.verdict.trim().length > 0)).toBe(true);
			expect(without.every((a) => a.verdict.trim().length > 0)).toBe(true);
		},
		30 * 60 * 1000
	);
});
