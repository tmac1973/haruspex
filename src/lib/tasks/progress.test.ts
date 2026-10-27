import { describe, it, expect } from 'vitest';
import { ordinal } from './progress.ts';

describe('ordinal', () => {
	it('says 1st, 2nd, 3rd, 4th, and the teens with th', () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
			'1st',
			'2nd',
			'3rd',
			'4th',
			'11th',
			'12th',
			'13th',
			'21st',
			'22nd',
			'23rd',
			'101st',
			'111th'
		]);
	});
});
