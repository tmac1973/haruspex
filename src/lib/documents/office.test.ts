import { describe, it, expect } from 'vitest';
import { columnShares } from './office';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('columnShares', () => {
	it('splits evenly between columns alike', () => {
		const shares = columnShares(
			[
				['a', 'b'],
				['1', '2']
			],
			400,
			10
		);
		expect(shares).toEqual([0.5, 0.5]);
	});

	it('gives each column at least its longest word', () => {
		const texts = [
			['Fruit', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
			['Strawberries', '3.50', '3.50', '3.50', '3.50', '3.50', '3.50', '3.50', '3.50']
		];
		const shares = columnShares(texts, 468, 10);
		expect(sum(shares)).toBeCloseTo(1);
		// 12 letters and padding, against 4 and padding.
		expect(shares[0] / shares[1]).toBeCloseTo(14 / 6);
	});

	it('gives the room past the longest words to the longest text', () => {
		const prose = 'a sentence long enough to want a wide column of its own here';
		const shares = columnShares(
			[
				['Name', 'Note'],
				['Kiwi', prose]
			],
			300,
			10
		);
		expect(shares[1]).toBeGreaterThan(0.8);
	});

	it('keeps to the longest words when even they do not fit', () => {
		const shares = columnShares([['Strawberries', 'Raspberries']], 50, 10);
		expect(shares[0] / shares[1]).toBeCloseTo(14 / 13);
	});
});
