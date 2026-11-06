import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, number[]>());
const io = vi.hoisted(() => ({
	read: async (path: string) => {
		const f = files.get(path);
		if (!f) throw 'No such file';
		return f;
	},
	write: async (path: string, bytes: number[], overwrite: boolean, dryRun: boolean) => {
		if (files.has(path) && !overwrite) throw 'File already exists';
		if (!dryRun) files.set(path, bytes);
	}
}));
vi.mock('#lib/agent/tools/_assetIo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/agent/tools/_assetIo.ts')>()),
	assetIo: () => io
}));
const call = vi.hoisted(() => ({ callSpecialist: vi.fn() }));
vi.mock('#lib/specialists/call.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/specialists/call.ts')>()),
	callSpecialist: call.callSpecialist
}));
const runner = vi.hoisted(() => ({ runAssetHtml: vi.fn() }));
vi.mock('#lib/specialists/three/runHtml.ts', () => runner);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { specialists: [] }
	})
);

import '#lib/specialists/kinds/index.ts';
import { effectiveSampling, newSpecialistEntry } from '#lib/specialists/entries.ts';
import type { SpecialistRun } from '#lib/specialists/types.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import type { RunError } from './runHtml';
import {
	failureReport,
	htmlCallLabel,
	runHtmlKind,
	type HtmlKindOutcome,
	type HtmlKindSpec
} from './htmlKind';

const PAGE = '<!DOCTYPE html><html><body>cube</body></html>';
const entry = { ...newSpecialistEntry('threejs', []), name: '3D Coder' };

/** A kind that saves `x.html` beside the output and passes unless told otherwise. */
function spec(outcome: HtmlKindOutcome = { ok: true, output: { result: 'Made it.' } }) {
	return {
		sourcePath: (args: Record<string, unknown>) => {
			const p = (args.path ?? args.recheck) as string;
			if (!p.endsWith('.glb') && !p.endsWith('.html')) return 'path must end in .glb';
			return { source: p.replace(/\.glb$/, '.html'), target: p };
		},
		requestSuffix: ' (one file)',
		runOptions: { export: true },
		finish: async () => outcome
	} satisfies HtmlKindSpec;
}

function run(
	args: Record<string, unknown>,
	request?: string,
	over: Partial<ToolContext> = {},
	images: unknown[] = []
): SpecialistRun {
	return {
		entry,
		request,
		images,
		args,
		ctx: makeToolContext({ workingDir: '/proj', codeMode: true, ...over })
	} as unknown as SpecialistRun;
}

function errorOf(out: { result: string }): string {
	return (JSON.parse(out.result) as { error: string }).error;
}

const saved = (path: string) =>
	new TextDecoder().decode(new Uint8Array(files.get(path) ?? [])).trim();

beforeEach(() => {
	files.clear();
	call.callSpecialist
		.mockReset()
		.mockResolvedValue({ content: '```html\n' + PAGE + '\n```', finishReason: 'stop' });
	runner.runAssetHtml.mockReset().mockResolvedValue({ glb: null, png: null, errors: [] });
});

describe('htmlCallLabel', () => {
	it('names the file a recheck re-runs', () => {
		expect(htmlCallLabel(entry, { recheck: 'models/sub\\cube.html' })).toBe(
			'3D Coder: recheck cube.html'
		);
		expect(htmlCallLabel(entry, { recheck: 'models/cube.html' })).toBe(
			'3D Coder: recheck cube.html'
		);
	});

	it('keeps the default label for a new request', () => {
		expect(htmlCallLabel(entry, { path: 'cube.glb' })).toBeNull();
	});
});

describe('failureReport', () => {
	it('lists every error and problem, then how to recheck', () => {
		const errors: RunError[] = [
			{ kind: 'error', message: 'THREE is not defined', line: 12 },
			{ kind: 'timeout', message: 'never finished', line: null }
		];
		expect(failureReport(errors, ['no lights'], 'a.html', '3D Coder')).toBe(
			[
				'The check failed.',
				'- line 12: THREE is not defined',
				'- never finished',
				'- no lights',
				"The source is at a.html. Fix it with your edit tools, then call ask_specialist with name '3D Coder' and recheck 'a.html'."
			].join('\n')
		);
	});
});

describe('runHtmlKind', () => {
	it('generates, saves the source and returns what the kind made', async () => {
		const out = await runHtmlKind(run({ path: 'cube.glb' }, 'A cube'), spec());
		expect(out).toEqual({ result: 'Made it.' });
		expect(saved('/proj/cube.html')).toBe(PAGE);
		expect(call.callSpecialist.mock.calls[0][1]).toBe('A cube (one file)');
	});

	it('asks for request and path, or recheck', async () => {
		expect(errorOf(await runHtmlKind(run({ path: 'cube.glb' }), spec()))).toBe(
			'Pass request and path, or recheck.'
		);
		expect(errorOf(await runHtmlKind(run({}, 'A cube'), spec()))).toBe(
			'Pass request and path, or recheck.'
		);
	});

	it('refuses a recheck with a request, a path or images', async () => {
		expect(errorOf(await runHtmlKind(run({ recheck: 'a.html' }, 'again'), spec()))).toMatch(
			/recheck takes no request or path/
		);
		expect(errorOf(await runHtmlKind(run({ recheck: 'a.html', path: 'b.glb' }), spec()))).toMatch(
			/recheck takes no request or path/
		);
		expect(
			errorOf(await runHtmlKind(run({ recheck: 'a.html' }, undefined, {}, [{}]), spec()))
		).toMatch(/images only go with a new request/);
	});

	it("passes on the kind's refusal of the path", async () => {
		expect(errorOf(await runHtmlKind(run({ path: 'cube.png' }, 'A cube'), spec()))).toBe(
			'path must end in .glb'
		);
	});

	it('refuses before generating when the output exists, naming the relative path', async () => {
		files.set('/proj/cube.glb', [1]);
		const msg = errorOf(await runHtmlKind(run({ path: 'cube.glb' }, 'A cube'), spec()));
		expect(msg).toBe('cube.glb already exists. Choose another name, or pass overwrite: true.');
		expect(call.callSpecialist).not.toHaveBeenCalled();
	});

	it('says how to raise the limit when the specialist runs out of tokens', async () => {
		call.callSpecialist.mockResolvedValue({ content: '<html', finishReason: 'length' });
		const msg = errorOf(await runHtmlKind(run({ path: 'cube.glb' }, 'A cube'), spec()));
		expect(msg).toContain(`max ${effectiveSampling(entry).max_tokens}`);
		expect(msg).toContain('Settings → Code → Specialists');
	});

	it('reports an answer with no HTML page in it', async () => {
		call.callSpecialist.mockResolvedValue({ content: 'Sorry, I cannot.', finishReason: 'stop' });
		expect(errorOf(await runHtmlKind(run({ path: 'cube.glb' }, 'A cube'), spec()))).toBe(
			'The specialist answered without an HTML page: Sorry, I cannot.'
		);
	});

	it('rechecks the saved source without generating', async () => {
		files.set('/proj/cube.html', Array.from(new TextEncoder().encode(PAGE)));
		const out = await runHtmlKind(run({ recheck: 'cube.html' }), spec());
		expect(out).toEqual({ result: 'Made it.' });
		expect(runner.runAssetHtml.mock.calls[0][0]).toBe(PAGE);
		expect(call.callSpecialist).not.toHaveBeenCalled();
	});

	it('says when the source to recheck cannot be read', async () => {
		expect(errorOf(await runHtmlKind(run({ recheck: 'gone.html' }), spec()))).toBe(
			'Could not read gone.html: No such file'
		);
	});

	it('fails on run errors before the kind can write anything', async () => {
		const errors: RunError[] = [{ kind: 'error', message: 'boom', line: 3 }];
		runner.runAssetHtml.mockResolvedValue({ glb: null, png: null, errors });
		let finished = false;
		const out = await runHtmlKind(run({ path: 'cube.glb' }, 'A cube'), {
			...spec(),
			finish: async () => {
				finished = true;
				return { ok: true, output: { result: 'Made it.' } };
			}
		});
		expect(out.result).toBe(failureReport(errors, [], 'cube.html', entry.name));
		expect(finished).toBe(false);
		expect(saved('/proj/cube.html')).toBe(PAGE);
	});

	it("reports the kind's problems and leaves the source for a fix", async () => {
		const out = await runHtmlKind(
			run({ path: 'cube.glb' }, 'A cube'),
			spec({ ok: false, problems: ['the model is empty'] })
		);
		expect(out.result).toBe(failureReport([], ['the model is empty'], 'cube.html', entry.name));
		expect(saved('/proj/cube.html')).toBe(PAGE);
	});
});
