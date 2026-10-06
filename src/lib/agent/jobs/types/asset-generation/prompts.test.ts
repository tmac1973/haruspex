import { describe, it, expect } from 'vitest';
import { hexOf, judgePrompt, KIND_RULE, recipePrompt, specDerivationPrompt } from './prompts';

describe('judgePrompt', () => {
	it('does not hold a subject to the reference colours', () => {
		// Each sheet keeps its own palette; green grass beside a brown anchor is right.
		const p = judgePrompt('green weeds', 'pixel art');
		expect(p).not.toContain('same palette');
		expect(p).toContain('Its colours may differ');
	});

	it('asks a texture about its view, and a sprite not', () => {
		expect(judgePrompt('asphalt', 'pixel art', 'texture')).toMatch(/perspective or a horizon/);
		expect(judgePrompt('a sword', 'pixel art', 'sprite')).not.toMatch(/horizon/);
	});
});

describe('specDerivationPrompt', () => {
	it('keeps colour schemes out of the shared style', () => {
		const p = specDerivationPrompt('a game', 'assets/spec.json');
		expect(p).toContain('Do NOT name colours or a colour scheme');
		expect(p).not.toMatch(/rust and concrete\s+palette/);
	});
});

describe('what a texture is', () => {
	it('tells both spec prompts that an object is a sprite', () => {
		const joined = KIND_RULE.join(' ');
		expect(joined).toContain('subway entrance');
		expect(joined).toContain('Anything with an outline is a `sprite`');
		expect(specDerivationPrompt('a game', 'plan/assets.json')).toContain(KIND_RULE[0]);
	});
});

describe('recipePrompt', () => {
	it('offers the palette and quotes what was wrong last time', () => {
		const p = recipePrompt(
			[{ id: 'street', prompt: 'cracked asphalt' }],
			[0x2a2a2dff],
			'pixel art',
			new Map([['street', 'base.ramp: too few']])
		);
		expect(p).toContain('#2a2a2d');
		expect(p).toContain('needs changing: base.ramp: too few');
		expect(p).toContain('submit_texture_recipes');
	});

	it('writes a packed colour as hex', () => {
		expect(hexOf(0x2a2a2dff)).toBe('#2a2a2d');
		expect(hexOf(0x000000ff)).toBe('#000000');
	});
});
