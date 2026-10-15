import { describe, expect, it } from 'vitest';
import { backendLabel } from '#lib/inferenceProbe.ts';

describe('backendLabel', () => {
	it('names a toolchest by the engine its status reports', () => {
		expect(backendLabel('llama-toolchest', 'vllm')).toBe('toolchest (vLLM)');
		expect(backendLabel('llama-toolchest', 'llama.cpp')).toBe('toolchest (llama.cpp)');
		expect(backendLabel('llama-toolchest', 'mlx')).toBe('toolchest (mlx)');
	});

	it('says just toolchest when the server names no engine', () => {
		expect(backendLabel('llama-toolchest')).toBe('toolchest');
		expect(backendLabel('llama-toolchest', null)).toBe('toolchest');
	});

	it('names the other backends as before', () => {
		expect(backendLabel('llama-server')).toBe('llama-server');
		expect(backendLabel('openai-compat')).toBe('OpenAI-compatible');
		expect(backendLabel('ollama')).toBe('Ollama');
		expect(backendLabel(null)).toBe('Unknown');
	});
});
