import { describe, it, expect } from 'vitest';
import { recommendLean } from './recommend';

const GOOD_GPU = { gpu_available: true, gpu_integrated_slow: false };

describe('recommendLean', () => {
	it('recommends lean for a model of 9B or smaller', () => {
		for (const modelId of ['Qwen3.5-9B-IQ4_NL', 'Qwen3.5-4B-IQ4_NL.gguf', 'org/tiny-1.5b']) {
			expect(recommendLean({ modelId, hardware: GOOD_GPU })).toEqual({
				lean: true,
				reason: 'small-model'
			});
		}
	});

	it('recommends full for a bigger model on a good GPU, MoE included', () => {
		expect(recommendLean({ modelId: 'qwen/qwen3.6-35b-a3b', hardware: GOOD_GPU })).toEqual({
			lean: false,
			reason: null
		});
		expect(recommendLean({ modelId: 'Qwen3.6-27B-Q4_K_M.gguf', hardware: GOOD_GPU }).lean).toBe(
			false
		);
	});

	it('recommends lean for any model without a fast GPU', () => {
		const noGpu = { gpu_available: false, gpu_integrated_slow: false };
		const slowIgpu = { gpu_available: true, gpu_integrated_slow: true };
		expect(recommendLean({ modelId: 'Qwen3.6-27B', hardware: noGpu }).reason).toBe('weak-hardware');
		expect(recommendLean({ modelId: null, hardware: slowIgpu }).reason).toBe('weak-hardware');
	});

	it('takes a remote model of unknown size as capable', () => {
		expect(recommendLean({ modelId: 'gpt-oss', hardware: null })).toEqual({
			lean: false,
			reason: null
		});
		expect(recommendLean({ modelId: 'llama-3.1-8b-instruct', hardware: null }).lean).toBe(true);
	});
});
