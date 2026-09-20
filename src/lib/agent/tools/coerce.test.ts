import { describe, it, expect } from 'vitest';
import { coerceArgsToSchema } from './coerce';

const schema = {
	type: 'object',
	properties: {
		slides: { type: 'array' },
		options: { type: 'object' },
		count: { type: 'integer' },
		ratio: { type: 'number' },
		overwrite: { type: 'boolean' },
		content: { type: 'string' }
	}
};

describe('coerceArgsToSchema', () => {
	it('parses a JSON-encoded string where the schema wants an array', () => {
		const out = coerceArgsToSchema(schema, { slides: '[{"title":"a"},{"title":"b"}]' });
		expect(out.slides).toEqual([{ title: 'a' }, { title: 'b' }]);
	});

	it('wraps a bare object into a singleton array', () => {
		expect(coerceArgsToSchema(schema, { slides: { title: 'a' } }).slides).toEqual([{ title: 'a' }]);
		expect(coerceArgsToSchema(schema, { slides: '{"title":"a"}' }).slides).toEqual([
			{ title: 'a' }
		]);
	});

	it('parses a JSON-encoded string where the schema wants an object', () => {
		expect(coerceArgsToSchema(schema, { options: '{"a":1}' }).options).toEqual({ a: 1 });
	});

	it('converts numeric strings for integer/number params', () => {
		const out = coerceArgsToSchema(schema, { count: '5', ratio: '2.5' });
		expect(out.count).toBe(5);
		expect(out.ratio).toBe(2.5);
	});

	it('truncates a float string for an integer param', () => {
		expect(coerceArgsToSchema(schema, { count: '5.9' }).count).toBe(5);
	});

	it('converts "true"/"false" for boolean params', () => {
		expect(coerceArgsToSchema(schema, { overwrite: 'true' }).overwrite).toBe(true);
		expect(coerceArgsToSchema(schema, { overwrite: 'false' }).overwrite).toBe(false);
	});

	it('stringifies numbers/booleans and joins string arrays for string params', () => {
		expect(coerceArgsToSchema(schema, { content: 42 }).content).toBe('42');
		expect(coerceArgsToSchema(schema, { content: ['a', 'b'] }).content).toBe('a\nb');
	});

	it('leaves ambiguous or already-correct values untouched', () => {
		const slides = [{ title: 'a' }];
		const out = coerceArgsToSchema(schema, {
			slides,
			count: 3,
			content: 'text',
			overwrite: 'yes', // not a clean boolean — pass through
			ratio: 'abc' // not numeric — pass through
		});
		expect(out.slides).toBe(slides);
		expect(out.count).toBe(3);
		expect(out.content).toBe('text');
		expect(out.overwrite).toBe('yes');
		expect(out.ratio).toBe('abc');
	});

	it('passes through unknown properties and null values', () => {
		const out = coerceArgsToSchema(schema, { mystery: '5', count: null });
		expect(out.mystery).toBe('5');
		expect(out.count).toBeNull();
	});

	it('handles a malformed JSON string gracefully', () => {
		expect(coerceArgsToSchema(schema, { slides: '[{broken' }).slides).toBe('[{broken');
	});

	it('no-ops without a schema', () => {
		const args = { a: '1' };
		expect(coerceArgsToSchema(undefined, args)).toEqual(args);
	});
});

/**
 * Observed in a real guided-planning run: the model emitted `options` as a
 * JSON string whose array was valid but had a stray fragment of the enclosing
 * object after it. JSON.parse rejected the whole thing, the string reached the
 * executor, Array.isArray said no, and the user got a question with nothing to
 * pick — for an entire interview.
 */
describe('coerceArgsToSchema — a valid value with trailing junk', () => {
	const schema = {
		properties: {
			options: { type: 'array' },
			question: { type: 'string' }
		}
	};

	const REAL = String.raw`[{"label": "Strict alternating", "description": "Simplest."}, {"label": "Energy queue", "description": "DCSS style."}], "recommended": true}]`;

	it('recovers the array from the exact payload that broke a run', () => {
		const out = coerceArgsToSchema(schema, { options: REAL, question: 'How?' });
		expect(Array.isArray(out.options)).toBe(true);
		expect((out.options as unknown[]).length).toBe(2);
		expect((out.options as { label: string }[])[0].label).toBe('Strict alternating');
	});

	it('is not fooled by a bracket inside a label or description', () => {
		const withBrackets = String.raw`[{"label": "Array [0] indexing", "description": "a } and a ]"}] trailing`;
		const out = coerceArgsToSchema(schema, { options: withBrackets });
		expect((out.options as { label: string }[])[0].label).toBe('Array [0] indexing');
	});

	it('still parses a well-formed array unchanged', () => {
		const out = coerceArgsToSchema(schema, { options: '[{"label":"A"},{"label":"B"}]' });
		expect((out.options as unknown[]).length).toBe(2);
	});

	it('leaves genuine nonsense alone for the tool to report', () => {
		const out = coerceArgsToSchema(schema, { options: '[not json at all' });
		expect(typeof out.options).toBe('string');
	});
});
