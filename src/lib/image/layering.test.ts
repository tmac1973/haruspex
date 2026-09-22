import { describe, it, expect } from 'vitest';

/**
 * The project has no `@types/node`, so a static `node:fs` import fails
 * svelte-check even though it runs fine under vitest. The repo already solves
 * this in `verifierReasoning.live.test.ts`: import through a variable
 * specifier, which TypeScript declines to resolve rather than reports as
 * missing, and declare the shape here.
 */
const nodeFs = 'node:fs';
const { readdirSync, readFileSync, statSync } = (await import(nodeFs)) as {
	readdirSync: (path: string) => string[];
	readFileSync: (path: string, encoding: string) => string;
	statSync: (path: string) => { isDirectory: () => boolean };
};

/** `path.join` for the one case here: a directory and a name. */
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

/**
 * The boundary this whole layer exists to hold.
 *
 * `src/lib/image/` is the backend: requests in, images out. It must stay
 * usable by a caller that has no job, no project directory and no asset spec —
 * a future image tab, or a chat turn that shows a generated picture inline.
 * Both of those are out of scope as work, but neither may require refactoring
 * this module when it arrives.
 *
 * Two halves, because one on its own is not enough. An import scan catches a
 * dependency on the jobs layer; it does NOT catch this module quietly growing
 * a type called `AssetSpec`, which is how the boundary actually erodes.
 * Everything asset-shaped belongs in `src/lib/assets/`, which may depend on
 * this module but never the reverse.
 */

// Vitest runs from the project root, so a relative path needs no `process`.
const ROOT = 'src/lib/image';

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (name.endsWith('.ts') || name.endsWith('.svelte')) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Strip comments before checking identifiers. The module is allowed — and
 * expected — to explain in prose what it deliberately does not know; it is the
 * code that must not say "asset".
 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN_TYPES = ['AssetSpec', 'AssetEntry', 'AnchorRef', 'AnchorRecipe'];
const FORBIDDEN_WORDS = ['spec', 'anchor', 'entry', 'asset'];

describe('the image layer knows nothing about assets', () => {
	const files = sourceFiles(ROOT);

	it('finds source files to check', () => {
		// A scan that silently matches nothing would pass forever.
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing from the jobs layer', () => {
		const offenders = files.filter((f) => {
			const src = readFileSync(f, 'utf8');
			return /from\s+['"]\$lib\/agent\/jobs/.test(src) || /from\s+['"][./]*agent\/jobs/.test(src);
		});
		expect(offenders).toEqual([]);
	});

	it('never names an asset-domain type', () => {
		const offenders: string[] = [];
		for (const f of files) {
			if (f.endsWith('layering.test.ts')) continue;
			const src = stripComments(readFileSync(f, 'utf8'));
			for (const t of FORBIDDEN_TYPES) {
				if (new RegExp(`\\b${t}\\b`).test(src)) offenders.push(`${f}: ${t}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('never uses spec/anchor/entry/asset as an identifier', () => {
		const offenders: string[] = [];
		for (const f of files) {
			if (f.endsWith('layering.test.ts')) continue;
			const src = stripComments(readFileSync(f, 'utf8'));
			for (const w of FORBIDDEN_WORDS) {
				// The word on its own, or as the head of an identifier:
				// `asset`, `assets`, `assetPath`, `AssetSpec`. NOT `assessment`
				// or `specify`, where a lowercase letter continues a different
				// word.
				//
				// Deliberately case-sensitive, with the capitalized form spelled
				// out. Under the `i` flag `[a-z]` matches uppercase too, so the
				// lookahead rejected exactly the camelCase names this is for —
				// the guard passed on a file containing `AssetSpec`.
				const cap = w[0].toUpperCase() + w.slice(1);
				const re = new RegExp(`\\b(${w}|${cap})s?(?![a-z])`);
				if (re.test(src)) offenders.push(`${f}: ${w}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
