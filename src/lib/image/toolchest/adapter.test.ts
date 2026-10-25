import { describe, it, expect } from 'vitest';
import created from './fixtures/job-created.json';
import succeeded from './fixtures/job-succeeded.json';
import { buildImageBody, progressOf, readJob } from './adapter';

const extrasOf = (prompt: string) =>
	JSON.parse(/^<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/.exec(prompt)![1]);

describe('buildImageBody', () => {
	it('puts sd-server fields in the leading block and keeps the instance sampler when none is given', () => {
		const body = buildImageBody({
			model: 'qwen-turbo-local',
			prompt: 'a fox',
			negativePrompt: ' blurry ',
			seed: 7,
			width: 768,
			height: 512
		});
		expect(body).toMatchObject({ model: 'qwen-turbo-local', size: '768x512', n: 1 });
		expect(body.prompt.endsWith(' a fox')).toBe(true);
		const extras = extrasOf(body.prompt);
		expect(extras).toEqual({ seed: 7, width: 768, height: 512, negative_prompt: 'blurry' });
	});

	it('sends a sampler and a clear start when asked', () => {
		const body = buildImageBody({
			model: 'ming-gpu1',
			prompt: 'RGBA… a fox',
			seed: 1,
			width: 64,
			height: 64,
			sampler: { name: 'euler', steps: 12, cfg: 1 },
			clearStart: 'AAAA'
		});
		const extras = extrasOf(body.prompt);
		expect(extras.sample_params).toEqual({
			sample_steps: 12,
			sample_method: 'euler',
			guidance: { txt_cfg: 1 }
		});
		expect(extras.init_image).toBe('AAAA');
		expect(extras.strength).toBe(0.9);
	});

	it('refuses a block sd-server would crash on', () => {
		expect(() =>
			buildImageBody({
				model: 'm',
				prompt: 'p',
				seed: 1,
				width: 1,
				height: 1,
				clearStart: 'A'.repeat(30_000)
			})
		).toThrow(/too large/);
	});
});

describe('readJob', () => {
	it('reads a job toolchest recorded, running and done', () => {
		expect(readJob(created)).toEqual({
			id: '8ffd10ab645e7e1b',
			status: 'running',
			phase: 'generating',
			ahead: 0,
			images: [],
			error: null
		});
		expect(readJob(succeeded)).toMatchObject({
			status: 'succeeded',
			phase: '',
			images: ['/v1/images/jobs/8ffd10ab645e7e1b/image/0']
		});
	});

	it('keeps only relative image paths, and reads a failure', () => {
		const job = readJob({
			id: 'x',
			status: 'failed',
			error: 'generating: out of memory',
			images: [{ url: 'http://elsewhere/evil.png' }]
		});
		expect(job).toMatchObject({ images: [], error: 'generating: out of memory' });
		expect(readJob({ status: 'queued' })).toBeNull();
	});
});

describe('progressOf', () => {
	it('maps queue, drawing and saving to the shared phases', () => {
		const base = { id: 'x', images: [], error: null };
		expect(progressOf({ ...base, status: 'queued', phase: 'queued', ahead: 2 })).toEqual({
			phase: 'queued',
			ahead: 2
		});
		expect(progressOf({ ...base, status: 'queued', phase: 'queued', ahead: 0 })).toEqual({
			phase: 'queued'
		});
		expect(progressOf({ ...base, status: 'running', phase: 'generating', ahead: 0 })).toEqual({
			phase: 'running'
		});
		expect(progressOf({ ...base, status: 'running', phase: 'saving', ahead: 0 })).toEqual({
			phase: 'downloading'
		});
	});
});
