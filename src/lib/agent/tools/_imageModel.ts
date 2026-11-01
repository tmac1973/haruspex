/**
 * The image tools' `model` argument, and their schemas as the image models in
 * Settings → Image shape them. With two or more models the chat model may name
 * one (an enum of their names); left out, the router picks the first that can
 * do the job (`#lib/image/route.ts`). With one there is nothing to choose and
 * no argument.
 *
 * A turn's schemas are built from the models each time it starts, and one
 * built from the same models is reused.
 */

import type { ToolDefinition } from '#lib/api.ts';
import { entryNames, imageEntries } from '#lib/image/entries.ts';

type Properties = Record<string, Record<string, unknown>>;

/** The argument as registered: a plain string, so a call's value is kept. */
export const MODEL_PARAM = {
	type: 'string',
	description: 'The image model to use, by name. Leave out to use the first model that can do this.'
};

/** The model the call names, if any. */
export function namedModel(args: Record<string, unknown>): string | undefined {
	const named = typeof args.model === 'string' ? args.model.trim() : '';
	return named || undefined;
}

/** What the schemas depend on: the models' names and what each can do. */
function modelsKey(): string {
	return JSON.stringify(imageEntries().map((e) => [e.name, e.caps]));
}

const built = new Map<string, { key: string; schema: ToolDefinition | null }>();

/**
 * `schema` with `model` narrowed to the models' names, or without it when
 * there are fewer than two, after `shape` has changed its properties as it
 * needs. `shape` returns false to leave the tool out.
 */
export function imageToolSchema(
	schema: ToolDefinition,
	shape: (properties: Properties) => boolean = () => true
): ToolDefinition | null {
	const name = schema.function.name;
	const key = modelsKey();
	const cached = built.get(name);
	if (cached?.key === key) return cached.schema;

	const params = schema.function.parameters as { properties: Properties };
	const properties = { ...params.properties };
	const names = entryNames();
	if (names.length < 2) delete properties.model;
	else properties.model = { ...MODEL_PARAM, enum: names };
	const live = shape(properties)
		? { ...schema, function: { ...schema.function, parameters: { ...params, properties } } }
		: null;
	built.set(name, { key, schema: live });
	return live;
}
