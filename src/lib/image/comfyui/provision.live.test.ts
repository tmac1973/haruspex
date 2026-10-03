// @vitest-environment node
/**
 * Opt-in: installs Ming's VAE (254 MB) through a real ComfyUI-Manager.
 *
 * Point it at a THROWAWAY ComfyUI started with `--enable-manager`, e.g.
 * `python main.py --port 8189 --cpu --enable-manager --base-directory /tmp/c2`,
 * and run `HARUSPEX_MANAGER_URL=http://127.0.0.1:8189 npx vitest run provision.live`.
 */
import { describe, it, expect } from 'vitest';
import type { ComfyModelSet } from '$lib/ipc/gen/ComfyModelSet';
import { installViaManager, managerApi, missingFiles } from './provision';

declare const process: { env: Record<string, string | undefined> };

const url = process.env.HARUSPEX_MANAGER_URL;

const VAE_ONLY: ComfyModelSet = {
	family: 'ming',
	label: 'Ming-Image VAE',
	license: 'MIT',
	license_url: 'https://huggingface.co/inclusionAI/Ming-Image-0.1-Design',
	commercial_use: true,
	vram_mb: 0,
	ram_mb: 0,
	files: [
		{
			folder: 'vae',
			filename: 'ming_image_vae_bf16.safetensors',
			url: 'https://huggingface.co/Comfy-Org/Ming-Image/resolve/main/vae/ming_image_vae_bf16.safetensors',
			sha256: '7f5bed402dc8c77dc2e0ab1929a85d4df433b7cf7b599dfa8c353da98db0b90a',
			size_bytes: 253_816_696
		}
	]
};

describe.skipIf(!url)('ComfyUI-Manager, live', () => {
	const cfg = { baseUrl: url ?? '', apiKey: '' };

	it('installs a missing file, which the server then lists', { timeout: 600_000 }, async () => {
		const which = await managerApi(cfg);
		expect(which).not.toBeNull();
		const before = await missingFiles(cfg, VAE_ONLY);
		expect(before.map((f) => f.folder)).toContain('vae');
		await installViaManager(cfg, which!, before, () => {});
		const after = await missingFiles(cfg, VAE_ONLY);
		expect(after.map((f) => f.folder)).not.toContain('vae');
	});
});
