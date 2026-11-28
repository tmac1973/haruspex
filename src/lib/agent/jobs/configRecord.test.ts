import { describe, it, expect } from 'vitest';
import { configRecord } from './configRecord.ts';

describe('configRecord', () => {
	it('reads a JSON object', () => {
		expect(configRecord('{"a":1}')).toEqual({ a: 1 });
	});

	it('is empty for nothing, bad JSON, and JSON that is not an object', () => {
		for (const json of [null, '', '{nope', '[1,2]', '3', 'null']) {
			expect(configRecord(json)).toEqual({});
		}
	});
});
