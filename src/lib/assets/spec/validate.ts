/**
 * What is wrong with a spec, as sentences naming the entry at fault.
 *
 * Every message carries the id, because the only thing a user can do with
 * "an output path escapes the working directory" is search for it.
 */

import type { AssetSpec } from './types';
import { ID_PATTERN } from './types';

/** Absolute, drive-lettered, or climbing out of the working directory. */
function escapesWorkdir(p: string): boolean {
	const n = p.replace(/\\/g, '/');
	if (n.startsWith('/')) return true;
	if (/^[a-zA-Z]:/.test(n)) return true;
	return n.split('/').includes('..');
}

function isPowerOfTwo(n: number): boolean {
	return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function validateAssetSpec(spec: AssetSpec): string[] {
	const problems: string[] = [];
	const seenIds = new Set<string>();
	const seenOut = new Map<string, string>();

	if (spec.entries.length === 0) {
		problems.push('The spec lists no assets to generate.');
	}
	if (spec.style.prompt.trim().length === 0) {
		problems.push('The style has no prompt — it is what makes the set coherent.');
	}

	for (const e of spec.entries) {
		const at = e.id || '(no id)';
		if (!ID_PATTERN.test(e.id)) {
			problems.push(
				`${at}: the id must start with a letter and use only lowercase letters, digits and underscores (2-48 characters).`
			);
		}
		if (seenIds.has(e.id)) {
			problems.push(`${at}: duplicate id.`);
		}
		seenIds.add(e.id);

		if (e.prompt.trim().length === 0) {
			problems.push(`${at}: empty prompt.`);
		}
		if (e.out.trim().length === 0) {
			problems.push(`${at}: no output path.`);
		} else if (escapesWorkdir(e.out)) {
			problems.push(`${at}: the output path "${e.out}" is outside the working directory.`);
		}
		const clash = seenOut.get(e.out);
		if (clash !== undefined) {
			problems.push(`${at}: writes to "${e.out}", which ${clash} also writes to.`);
		} else if (e.out.trim().length > 0) {
			seenOut.set(e.out, at);
		}

		if (e.size !== undefined && !isPowerOfTwo(e.size)) {
			problems.push(`${at}: size ${e.size} is not a positive power of two.`);
		}
		if (e.kind === 'texture' && e.seamless === false) {
			problems.push(`${at}: a texture with seamless off will not tile — drop one or the other.`);
		}
	}
	return problems;
}
