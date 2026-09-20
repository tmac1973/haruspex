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
const { readFileSync, readdirSync } = (await import(nodeFs)) as {
	readFileSync: (path: string, encoding: string) => string;
	readdirSync: (path: string) => string[];
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
 */
const PLAN_DIR = process.env.HARUSPEX_AB_PLAN;
// Required rather than defaulted: which backend is free varies, and a default
// that silently points at the wrong host wastes a run before it fails.
const BASE_URL = process.env.HARUSPEX_AB_URL ?? '';
const RUNS = Number(process.env.HARUSPEX_AB_RUNS ?? '1');

interface Attempt {
	thinking: boolean;
	ms: number;
	completionTokens: number;
	reasoningTokens: number;
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
	const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: userMessage }
			],
			max_tokens: 32768,
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
	const body = (await res.json()) as {
		choices?: { message?: { content?: string; reasoning_content?: string } }[];
		usage?: { completion_tokens?: number; reasoning_tokens?: number };
	};
	const verdict = body.choices?.[0]?.message?.content ?? '';
	const { blocking, advisory } = classifyFindings(verdict);
	return {
		thinking,
		ms: Date.now() - started,
		completionTokens: body.usage?.completion_tokens ?? 0,
		reasoningTokens:
			body.usage?.reasoning_tokens ??
			Math.round((body.choices?.[0]?.message?.reasoning_content?.length ?? 0) / 4),
		verdict,
		blocking,
		advisory
	};
}

function report(label: string, attempts: Attempt[]) {
	console.log(`\n=== ${label} ===`);
	for (const [i, a] of attempts.entries()) {
		console.log(
			`  run ${i + 1}: ${(a.ms / 1000).toFixed(1)}s  ${a.completionTokens} tok ` +
				`(${a.reasoningTokens} reasoning)  ` +
				`${isPlanClean(a.verdict) ? 'PLAN OK' : `${a.blocking.length} blocking, ${a.advisory.length} advisory`}`
		);
	}
	const findings = new Set(attempts.flatMap((a) => [...a.blocking, ...a.advisory]));
	if (findings.size > 0) {
		console.log('  findings across runs:');
		for (const f of findings) console.log(`    - ${f.slice(0, 160)}`);
	}
}

describe.skipIf(!PLAN_DIR || !BASE_URL)('verifier reasoning A/B (live)', () => {
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
