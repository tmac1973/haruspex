import { describe, it, expect } from 'vitest';
import { imageAnswerText } from './_imageAnswer';

const drawn = {
	verb: 'Image ready',
	width: 1024,
	height: 768,
	model: 'openai/gpt-image-2',
	seed: 7,
	markdown: '![a fox](haruspex-image:abc)',
	sees: false,
	saved: null,
	notes: []
};

describe('imageAnswerText', () => {
	it('names the backend and the price when a paid backend made it', () => {
		expect(imageAnswerText({ ...drawn, servedBy: 'OpenRouter', costUsd: 0.04 })).toMatch(
			/^Image ready \(1024×768, openai\/gpt-image-2, seed 7, backend: OpenRouter, cost \$0\.04\)\./
		);
	});

	it('says nothing of cost when there was none', () => {
		expect(imageAnswerText({ ...drawn, servedBy: 'ComfyUI at gpu:8188' })).not.toContain('cost');
	});
});
