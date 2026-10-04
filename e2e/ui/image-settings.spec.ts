import { test, expect } from './fixtures';

test.use({
	settings: {
		imageBackendKind: 'comfyui',
		imageBackendBaseUrl: 'http://127.0.0.1:8188',
		imageComfyCheckpoint: 'e2e-sd15.safetensors'
	}
});

test('Settings → Image probes ComfyUI and lists its model', async ({ app }) => {
	await app.getByRole('button', { name: 'Settings' }).click();
	await app.getByRole('button', { name: 'Image', exact: true }).click();
	await app.getByRole('button', { name: 'Probe' }).click();
	await expect(app.getByText('Connected — E2E GPU.')).toBeVisible();
	await expect(app.getByLabel(/Model/)).toContainText('e2e-sd15.safetensors');
	await expect(app.getByText(/Supports: transparency/)).toBeVisible();
});
