import { describe, it, expect } from 'vitest';
import { specFromSubmission } from './tools';
import { foxSpec } from '#lib/testing/sequenceSpecs.ts';

describe('specFromSubmission', () => {
	it('takes a whole spec, whatever version the model put on it', () => {
		const { version: _, ...args } = foxSpec();
		void _;
		const { spec, problems } = specFromSubmission({ ...args, version: 7 });
		expect(problems).toEqual([]);
		expect(spec).toEqual(foxSpec());
	});

	it('names what is wrong with a bad one', () => {
		expect(specFromSubmission(null).problems).toEqual(['The submission had no spec in it.']);
		const { problems } = specFromSubmission({ title: 'x', sections: [{ kind: 'generated' }] });
		expect(problems).toEqual(
			expect.arrayContaining([
				'sections[0].id: missing',
				'sections[0].prompt: missing',
				'sections[0].seconds: missing'
			])
		);
	});
});
