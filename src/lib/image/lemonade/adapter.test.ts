import { describe, it, expect } from 'vitest';
import health from './fixtures/health.json';
import systemInfo from './fixtures/system-info.json';
import models from './fixtures/models.json';
import {
	bareName,
	buildGeneration,
	errorMessage,
	findJob,
	imagesFrom,
	MAX_EXTRAS_CHARS,
	readServer
} from './adapter';
import { CLEAR_START_STRENGTH } from '#lib/image/local/adapter.ts';

const base = {
	model: 'user.Ming-Image-0.1-Design-GGUF',
	prompt: 'RGBA, 4-channel, transparent background. a coin',
	seed: 7,
	width: 1024,
	height: 1024,
	sampler: { name: 'euler', steps: 12, cfg: 1 }
};

/** The block sd-server will read: the first one in the prompt. */
function extras(prompt: string): Record<string, unknown> {
	const m = /^<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args> /.exec(prompt);
	expect(m, 'our block leads the prompt').not.toBeNull();
	return JSON.parse(m![1]);
}

describe('buildGeneration', () => {
	it('leads the prompt with the native parameters, so Lemonade’s own block loses', () => {
		const body = buildGeneration(base);
		expect(body.prompt.endsWith(' RGBA, 4-channel, transparent background. a coin')).toBe(true);
		expect(extras(body.prompt)).toEqual({
			seed: 7,
			width: 1024,
			height: 1024,
			sample_params: { sample_steps: 12, sample_method: 'euler', guidance: { txt_cfg: 1 } }
		});
		expect(body).toMatchObject({
			model: 'user.Ming-Image-0.1-Design-GGUF',
			size: '1024x1024',
			seed: 7,
			n: 1,
			response_format: 'b64_json'
		});
	});

	it('starts Ming from the clear canvas at the measured strength', () => {
		const x = extras(buildGeneration({ ...base, clearStart: 'CANVAS' }).prompt);
		expect(x).toMatchObject({ init_image: 'CANVAS', strength: CLEAR_START_STRENGTH });
		expect(x).not.toHaveProperty('mask_image');
	});

	it('refuses a block long enough to crash sd-server, and passes a clear canvas', () => {
		// A 1024 clear canvas is ~5.5 KB of base64 and drew; 61 KB crashed.
		expect(() => buildGeneration({ ...base, clearStart: 'A'.repeat(5_500) })).not.toThrow();
		expect(() => buildGeneration({ ...base, clearStart: 'A'.repeat(MAX_EXTRAS_CHARS) })).toThrow(
			/too large for Lemonade/
		);
	});

	it('carries a negative prompt only when there is one', () => {
		expect(extras(buildGeneration({ ...base, negativePrompt: ' blurry ' }).prompt)).toMatchObject({
			negative_prompt: 'blurry'
		});
		expect(extras(buildGeneration({ ...base, negativePrompt: '  ' }).prompt)).not.toHaveProperty(
			'negative_prompt'
		);
	});
});

describe('responses', () => {
	it('reads OpenAI-style images', () => {
		expect(imagesFrom({ data: [{ b64_json: 'AQID' }, { url: 'x' }] })).toEqual([
			new Uint8Array([1, 2, 3])
		]);
		expect(imagesFrom({ error: 'x' })).toEqual([]);
	});

	it('takes Lemonade’s own sentence from a refusal', () => {
		// Recorded from Lemonade 2026.43.3 for a model it does not have.
		const body =
			'{"error":{"code":"model_not_found","message":"Model \'user.Nope\' was not found.","type":"model_not_found"}}';
		expect(errorMessage(body)).toBe("Model 'user.Nope' was not found.");
		expect(errorMessage('Internal Server Error')).toBeNull();
	});
});

describe('readServer', () => {
	it('reads a real server: version, GPU, storage, sd-cpp, and what is loaded and installed', () => {
		const s = readServer(health, systemInfo, models);
		expect(s.version).toBe('2026.43.3');
		expect(s.gpu).toBe('AMD Radeon AI PRO R9700 (gfx1201)');
		expect(s.storage).toBe('/opt/var/lib/lemonade/.cache/huggingface/hub');
		expect(s.sdcpp).toEqual({ usable: true, backend: 'rocm', installed: true });
		expect(s.loadedImage).toBe('Ming-Image-0.1-Design-GGUF');
		expect(s.downloaded.has(bareName('user.Ming-Image-0.1-Design-GGUF'))).toBe(true);
		expect(s.downloaded.has('Z-Image-Turbo')).toBe(false);
	});

	it('says when sd-cpp cannot run there', () => {
		const none = { recipes: { 'sd-cpp': { backends: { cuda: { state: 'unsupported' } } } } };
		expect(readServer({}, none, {}).sdcpp).toEqual({
			usable: false,
			backend: null,
			installed: false
		});
	});

	it('reads which installed models edit, whether the upscaler is there, and an engine still to install', () => {
		const fresh = {
			recipes: {
				'sd-cpp': { default_backend: 'vulkan', backends: { vulkan: { state: 'installable' } } }
			}
		};
		const list = {
			data: [
				{
					id: 'user.Qwen-Image-2.1-Turbo-GGUF',
					downloaded: true,
					checkpoints: { main: 'a:b.gguf', llm_vision: 'a:mmproj.gguf' }
				},
				{ id: 'user.Ming-Image-0.1-Design-GGUF', downloaded: true, checkpoints: { main: 'm:x' } },
				{ id: 'RealESRGAN-x4plus', downloaded: true, checkpoints: { main: 'amd/r:x.pth' } }
			]
		};
		const s = readServer({}, fresh, list);
		expect(s.sdcpp).toEqual({ usable: true, backend: 'vulkan', installed: false });
		expect([...s.edits]).toEqual(['Qwen-Image-2.1-Turbo-GGUF']);
		expect(s.upscaler).toBe(true);
		expect(readServer({}, fresh, { data: [] }).upscaler).toBe(false);
	});

	it('survives a server that answers with something else', () => {
		const s = readServer(null, 'nope', []);
		expect(s).toMatchObject({ version: 'unknown version', gpu: null, loadedImage: null });
		expect(s.downloaded.size).toBe(0);
	});
});

describe('findJob', () => {
	// Recorded from Lemonade 2026.43.3: a pull that failed.
	const failed = {
		bytes_downloaded: 0,
		complete: false,
		cumulative_bytes_downloaded: 0,
		error: 'Hugging Face repository not found or not accessible: nobody/nothing-here',
		file: '',
		file_index: 0,
		id: 'model:user.Nope',
		model_name: 'user.Nope',
		running: false,
		status: 'error',
		total_download_size: 0,
		total_files: 0,
		type: 'model'
	};

	it('finds a model’s job by either form of its name', () => {
		expect(findJob([failed], 'user.Nope')).toMatchObject({
			status: 'error',
			running: false,
			error: failed.error
		});
		expect(findJob([{ ...failed, id: 'model:Nope' }], 'user.Nope')?.id).toBe('model:Nope');
		expect(findJob([failed], 'user.Other')).toBeNull();
		expect(findJob('nope', 'user.Nope')).toBeNull();
	});

	it('counts bytes across the whole job', () => {
		const job = findJob(
			[
				{
					...failed,
					status: 'downloading',
					running: true,
					file: 'ming_ling_mini_2.0-Q4_K.gguf',
					file_index: 2,
					total_files: 4,
					cumulative_bytes_downloaded: 9e9,
					total_download_size: 17e9
				}
			],
			'user.Nope'
		);
		expect(job).toMatchObject({ fileIndex: 2, totalFiles: 4, downloaded: 9e9, total: 17e9 });
	});
});
