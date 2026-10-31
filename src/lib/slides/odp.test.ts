import { describe, it, expect } from 'vitest';
import { foldForOdp } from './odp';

describe('foldForOdp', () => {
	it('leaves content and section slides as they are, and reports nothing', () => {
		const slides = [
			{ title: 'A', bullets: ['x'], image: 'a.png' },
			{ title: 'B', layout: 'section' as const, subtitle: 's' }
		];
		const out = foldForOdp(slides);
		expect(out.dropped).toEqual([]);
		expect(out.slides).toStrictEqual(slides);
		expect(out.slides[0]).not.toBe(slides[0]);
	});

	it('turns cover, quote and stat slides into section slides', () => {
		for (const layout of ['cover', 'quote', 'stat'] as const) {
			const { slides } = foldForOdp([{ title: 'T', layout, subtitle: 'S' }]);
			expect(slides[0]).toEqual({ title: 'T', subtitle: 'S', layout: 'section' });
		}
	});

	it('puts a two-column slide’s right column after its left', () => {
		const { slides } = foldForOdp([
			{ title: 'T', layout: 'two-column', bullets: ['a'], right: ['b', 'c'] }
		]);
		expect(slides[0]).toEqual({ title: 'T', bullets: ['a', 'b', 'c'], layout: 'content' });
	});

	it('shows an image slide’s subtitle as a bullet beside the image', () => {
		const { slides } = foldForOdp([
			{ title: 'T', layout: 'image', image: 'a.png', subtitle: 'caption' }
		]);
		expect(slides[0]).toEqual({
			title: 'T',
			bullets: ['caption'],
			image: 'a.png',
			layout: 'content'
		});
	});

	it('lists a chart’s numbers as bullets after the slide’s own', () => {
		const { slides } = foldForOdp([
			{
				title: 'T',
				layout: 'content',
				bullets: ['Up again'],
				chart: { type: 'bar', labels: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [3, 5] }] }
			},
			{
				title: 'U',
				layout: 'content',
				chart: {
					type: 'line',
					labels: ['Q1'],
					series: [
						{ name: 'Sales', values: [3] },
						{ name: 'Costs', values: [2] }
					]
				}
			}
		]);
		expect(slides[0]).toStrictEqual({
			title: 'T',
			layout: 'content',
			bullets: ['Up again', 'Q1: 3', 'Q2: 5']
		});
		expect(slides[1].bullets).toEqual(['Q1: Sales 3, Costs 2']);
	});

	it('lists a table as its header, then its rows under it', () => {
		const { slides, dropped } = foldForOdp([
			{
				title: 'T',
				layout: 'content',
				table: [
					['Name', 'Age'],
					['Ada', '36']
				]
			}
		]);
		expect(slides[0].bullets).toEqual(['Name · Age', { text: 'Ada · 36', level: 1 }]);
		expect(slides[0]).not.toHaveProperty('table');
		expect(dropped).toEqual(['tables were listed as bullets']);
	});

	it('names the layouts it simplified, once each, and dropped notes', () => {
		const { slides, dropped } = foldForOdp([
			{ title: 'A', layout: 'cover' },
			{ title: 'B', layout: 'stat', notes: 'say it slowly' },
			{ title: 'C', layout: 'cover' }
		]);
		expect(dropped).toEqual([
			'cover, stat slides were drawn as plain title or bullet slides',
			'speaker notes were left out'
		]);
		expect(slides.every((s) => !('notes' in s))).toBe(true);
	});
});
