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
