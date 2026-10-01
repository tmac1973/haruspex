import { describe, it, expect } from 'vitest';
import { judgePrompt, specDerivationPrompt } from './prompts';

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
