import { describe, it, expect, vi, beforeEach } from 'vitest';

const server = vi.hoisted(() => ({
	answer: (() => null) as (path: string, body: unknown) => unknown
}));
vi.mock('@tauri-apps/api/core', async () => ({
	// The progress socket's channel; it never hears anything here, so the run polls.
	Channel: class {
		onmessage: unknown = null;
	},
	...(await import('#lib/testing/invoke.ts')).mockTauriCore({
		audio_store_url: { hash: 'f'.repeat(64), mime: 'video/webm', bytes: 1000 },
		video_probe_cached: { audio: [], durationSecs: 5 },
		comfy_json: (args) => {
			const call = args!.call as { path: string; body: unknown };
			return server.answer(call.path, call.body);
		}
	})
}));
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs } from '#lib/testing/invoke.ts';
import { comfyVideoFor } from './backend';
import { VideoBackendError } from '../backend';
import { videoModel } from '#lib/testing/videoModels.ts';
import type { VideoJobHandle, VideoProgress } from '../types';

const MODEL = 'wan2.2_ti2v_5B_fp16.safetensors';
const LISTS: Record<string, Record<string, string[]>> = {
	UNETLoader: { unet_name: [MODEL] },
	CLIPLoader: { clip_name: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'] },
	VAELoader: { vae_name: ['wan2.2_vae.safetensors'] },
	Wan22ImageToVideoLatent: {},
	CreateVideo: {},
	SaveVideo: {}
};

let lists = LISTS;
let posted: { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }[] =
	[];
let up = true;

function answer(path: string, body: unknown): unknown {
	if (!up) throw { kind: 'unreachable', message: 'Could not reach the image backend at box:8188.' };
	if (path === '/system_stats') return { system: {} };
	if (path.startsWith('/object_info/')) {
		const cls = decodeURIComponent(path.slice('/object_info/'.length));
		const inputs = lists[cls];
		if (!inputs) return {};
		const required = Object.fromEntries(
			Object.entries(inputs).map(([k, v]) => [k, ['COMBO', { options: v }]])
		);
		return { [cls]: { input: { required } } };
	}
	if (path === '/prompt') {
		posted.push(body as (typeof posted)[number]);
		return { prompt_id: 'p1' };
	}
	if (path === '/history/p1') {
		return {
			p1: {
				outputs: {
					save: { images: [{ filename: 'c_00001_.webm', subfolder: 'haruspex', type: 'output' }] }
				}
			}
		};
	}
	throw new Error(`unexpected ${path}`);
}

beforeEach(() => {
	lists = LISTS;
	posted = [];
	up = true;
	server.answer = answer;
});

const entry = (model = MODEL) =>
	videoModel('comfyui', { id: 'e1', name: 'Wan 5B', url: 'http://box:8188', model });

describe('the ComfyUI video backend', () => {
	it('probes: no model, an unknown file, missing files, and connected', async () => {
		expect(await comfyVideoFor(entry('')).probe()).toMatchObject({
			ok: false,
			detail: 'Choose a video model.',
			models: [{ name: MODEL, label: `${MODEL} — Wan 2.2 TI2V 5B` }]
		});
		expect((await comfyVideoFor(entry('ming.safetensors')).probe()).detail).toBe(
			'ming.safetensors is not a video model Haruspex can run.'
		);
		lists = { ...LISTS, VAELoader: { vae_name: [] } };
		expect((await comfyVideoFor(entry()).probe()).detail).toBe(
			'Missing on the server: the Wan 2.2 VAE. Settings → Video generation → Install adds them.'
		);
		lists = LISTS;
		expect(await comfyVideoFor(entry()).probe()).toMatchObject({
			ok: true,
			detail: 'Connected — Wan 2.2 TI2V 5B.'
		});
	});

	it('says a server that is away is unreachable, so routing passes over it', async () => {
		up = false;
		expect((await comfyVideoFor(entry()).probe()).ok).toBe(false);
		const err = await comfyVideoFor(entry())
			.generate({
				title: 'Fox',
				prompt: 'a fox',
				width: 1280,
				height: 704,
				frames: 121,
				fps: 24,
				seed: 7
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VideoBackendError);
		expect(err).toMatchObject({ kind: 'unreachable' });
		expect((err as Error).message).toContain('Could not reach ComfyUI');
	});

	it('makes a clip: the graph, its handle, progress, and the clip kept in the cache', async () => {
		const handles: VideoJobHandle[] = [];
		const seen: VideoProgress[] = [];
		const made = await comfyVideoFor(entry()).generate(
			{ title: 'Fox', prompt: 'a fox', width: 1280, height: 704, frames: 123, fps: 24, seed: 7 },
			{ onHandle: (h) => handles.push(h), onProgress: (p) => seen.push(p) }
		);
		const graph = posted[0].prompt;
		expect(graph.unet.inputs.unet_name).toBe(MODEL);
		expect(graph.latent.inputs).toMatchObject({ width: 1280, height: 704, length: 121 });
		expect(handles[0]).toMatchObject({
			backend: 'comfyui',
			baseUrl: 'http://box:8188',
			id: 'p1',
			model: MODEL,
			extra: { outputNode: 'save', frames: '121' }
		});
		expect(invokeArgs(vi.mocked(invoke), 'audio_store_url')).toMatchObject({
			url: 'http://box:8188/view?filename=c_00001_.webm&subfolder=haruspex&type=output',
			mimeHint: 'video/webm',
			title: 'Fox'
		});
		expect(seen.at(-1)).toEqual({ phase: 'saving' });
		expect(made).toMatchObject({ model: 'Wan 5B', frames: 121, hasAudio: false });
	});

	it('refuses an end picture the family can’t take', async () => {
		await expect(
			comfyVideoFor(entry()).generate({
				title: 'x',
				prompt: 'x',
				width: 1280,
				height: 704,
				frames: 9,
				fps: 24,
				seed: 1,
				endImage: { name: 'e.png', hash: 'h' }
			})
		).rejects.toMatchObject({ kind: 'rejected', message: "Wan 5B can't end on a picture." });
	});

	it('follows a job again from its handle, and says when ComfyUI lost it', async () => {
		const handle: VideoJobHandle = {
			backend: 'comfyui',
			baseUrl: 'http://box:8188',
			id: 'p1',
			model: MODEL,
			keyId: '',
			entryId: 'e1',
			extra: { clientId: '', outputNode: 'save', frames: '121' }
		};
		const req = {
			title: 'Fox',
			prompt: 'a fox',
			width: 1280,
			height: 704,
			frames: 9,
			fps: 24,
			seed: 7
		};
		expect(await comfyVideoFor(entry()).resume(handle, req)).toMatchObject({
			frames: 121,
			model: 'Wan 5B'
		});
	});
});
