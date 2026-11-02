/**
 * The structured result of a Home card's job. The model never writes what a
 * card shows: it picks items by id from candidates the pipeline fetched, and
 * adds a short field or two (why an email matters). Everything here exists to
 * hold it to that: the reply is parsed, checked against the type's schema,
 * and any id the model made up is dropped.
 */
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

/** One item of a card result's `{ items: [...] }`. */
export interface ResultSchema {
	/** The field holding the item's id, checked against the candidates. */
	idField: string;
	/** The other fields the model writes, by type. */
	fields: Record<string, 'string' | 'number'>;
	/** At most this many items are kept. */
	max: number;
}

export type ResultItem = Record<string, string | number>;

export interface CardResult {
	items: ResultItem[];
}

/**
 * Check `value` against `schema`. Every item needs a string id and each
 * listed field with the right type; anything else on an item is removed, and
 * items past `max` are cut. Throws with a message the model can act on.
 */
export function validate(value: unknown, schema: ResultSchema): CardResult {
	if (typeof value !== 'object' || value === null || !Array.isArray((value as CardResult).items)) {
		throw new Error('The reply must be an object with an "items" array.');
	}
	const items = (value as { items: unknown[] }).items.map((raw, i) => {
		if (typeof raw !== 'object' || raw === null) throw new Error(`Item ${i + 1} is not an object.`);
		const item = raw as Record<string, unknown>;
		const id = item[schema.idField];
		if (typeof id !== 'string' || id === '') {
			throw new Error(`Item ${i + 1} has no "${schema.idField}".`);
		}
		const kept: ResultItem = { [schema.idField]: id };
		for (const [field, type] of Object.entries(schema.fields)) {
			if (typeof item[field] !== type) {
				throw new Error(`Item ${i + 1}'s "${field}" must be a ${type}.`);
			}
			kept[field] = item[field] as string | number;
		}
		return kept;
	});
	return { items: items.slice(0, schema.max) };
}

/** The first JSON object in a model's reply, code fences and prose around it allowed. */
export function parseModelJson(text: string): unknown {
	const unfenced = text.replace(/```(?:json)?/gi, '');
	const start = unfenced.indexOf('{');
	if (start < 0) throw new Error('The reply has no JSON object.');
	// Find the object's closing brace, skipping braces inside strings.
	let depth = 0;
	let inString = false;
	for (let i = start; i < unfenced.length; i++) {
		const c = unfenced[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) {
			try {
				return JSON.parse(unfenced.slice(start, i + 1));
			} catch (e) {
				throw new Error(`The JSON doesn't parse: ${(e as Error).message}`, { cause: e });
			}
		}
	}
	throw new Error('The JSON object is not closed.');
}

/** Drop items whose id is not one of the candidates; say how many went. */
export function keepKnownIds(
	items: ResultItem[],
	idField: string,
	knownIds: ReadonlySet<string>
): { items: ResultItem[]; dropped: number } {
	const kept = items.filter((item) => knownIds.has(String(item[idField])));
	return { items: kept, dropped: items.length - kept.length };
}

type PickTurn = Parameters<JobRunContext['runJobTurn']>[0];

/**
 * One model turn that picks items, parsed, checked and limited to known ids.
 * A reply that doesn't parse or fit the schema gets one more turn, told what
 * was wrong; when that fails too this throws its error, for the step to fail
 * with.
 */
export async function pickWithRetry(
	ctx: Pick<JobRunContext, 'runJobTurn'>,
	turn: PickTurn,
	schema: ResultSchema,
	knownIds: ReadonlySet<string>
): Promise<{ items: ResultItem[]; dropped: number }> {
	let message = turn.userMessage;
	for (let attempt = 0; ; attempt++) {
		const { finalText } = await ctx.runJobTurn({ ...turn, userMessage: message });
		try {
			const result = validate(parseModelJson(finalText), schema);
			return keepKnownIds(result.items, schema.idField, knownIds);
		} catch (e) {
			if (attempt > 0) throw e;
			message = `${turn.userMessage}\n\nYour last reply could not be used: ${(e as Error).message} Reply again with only the JSON object.`;
		}
	}
}
