/**
 * Keeping a prompt inside the text encoder's window.
 *
 * SD1.5 and SDXL encode text with CLIP, whose context is **77 tokens**. A
 * longer prompt is not rejected — ComfyUI splits it into chunks and
 * concatenates the embeddings — but the later chunks carry far less weight,
 * and anything past the first is effectively a suggestion.
 *
 * That matters here because a spec's `style.prompt` is prepended to the
 * anchor's composition instruction and appended to every entry's subject. A
 * richly written style therefore pushes the thing the image is actually
 * SUPPOSED TO BE out of the window entirely.
 *
 * Measured against SD1.5 at a fixed seed, asking for a sheet of four named
 * vehicles:
 *
 * | style length | result |
 * | --- | --- |
 * | 637 chars | abstract blobs on brown; not one of the four subjects present |
 * | 326 chars | mostly unusable |
 * | 239 chars | a clean sheet of isolated objects on flat magenta |
 * | 107 chars | a clean sheet of isolated objects on flat magenta |
 *
 * Reordering does not help — putting the composition first and the full style
 * after produced the worst image of the set — because the problem is the
 * total, not the order.
 */

/**
 * How much of a prompt the style may occupy, in characters.
 *
 * Characters rather than tokens because a real CLIP tokenizer is a
 * dependency, a dictionary and a build step for one comparison, and the
 * measurement above is in characters anyway. 240 is the largest value that
 * produced a usable anchor; the next size up did not.
 */
export const STYLE_BUDGET_CHARS = 240;

export interface FittedStyle {
	text: string;
	/** True when something was dropped, so the report can say so. */
	truncated: boolean;
}

/**
 * The leading clauses of a style that fit the budget.
 *
 * Cut at clause boundaries, never mid-phrase: half of "desaturated
 * post-apocalyptic palette of ash grey" is worse than none of it, because the
 * model reads the fragment as an instruction.
 *
 * The LEADING clauses specifically. Whatever opens a style prompt decides the
 * medium — measured: leading with subjects and appending the style produced a
 * competent oil painting where leading with "16-bit pixel art" produced pixel
 * art — so the opening is the part worth keeping.
 */
export function fitStyle(style: string, budget = STYLE_BUDGET_CHARS): FittedStyle {
	const trimmed = style.trim();
	if (trimmed.length <= budget) return { text: trimmed, truncated: false };

	// Semicolons are clause separators too; a style written with them would
	// otherwise be one enormous unsplittable clause.
	const clauses = trimmed
		.replace(/;/g, ',')
		.split(',')
		.map((c) => c.trim())
		.filter((c) => c.length > 0);

	const kept: string[] = [];
	let used = 0;
	for (const clause of clauses) {
		const cost = clause.length + (kept.length > 0 ? 2 : 0);
		if (used + cost > budget) break;
		kept.push(clause);
		used += cost;
	}

	// A single clause longer than the whole budget: keep it anyway rather than
	// emit an empty style, since a style of nothing loses the medium entirely
	// — which is the one thing the opening was for.
	if (kept.length === 0 && clauses.length > 0) {
		return { text: clauses[0], truncated: true };
	}
	return { text: kept.join(', '), truncated: kept.length < clauses.length };
}
