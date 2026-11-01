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
	// The single backend set before the list is its first model.
	await app.getByRole('button', { name: /^e2e-sd15/ }).click();
	await app.getByRole('button', { name: 'Probe' }).click();
	await expect(app.getByText('Connected — E2E GPU.')).toBeVisible();
	await expect(app.getByLabel(/Model/)).toContainText('e2e-sd15.safetensors');
	// What Haruspex can do with an SD checkpoint on ComfyUI, in words: in the
	// open editor, and kept on the model's row.
	await expect(
		app.getByText(
			"Can: draw pictures, extend pictures, tiling textures, LoRAs (up to 2). Can't: edit pictures, upscale pictures, transparent backgrounds."
		)
	).toHaveCount(2);
});

test('Settings → Image adds, orders and removes image models', async ({ app }) => {
	await app.getByRole('button', { name: 'Settings' }).click();
	await app.getByRole('button', { name: 'Image', exact: true }).click();
	await app.getByRole('button', { name: 'Add model' }).click();
	// A new one opens, and only one editor is open at a time.
	await expect(app.getByLabel('Name:')).toHaveCount(1);
	await expect(app.getByLabel('Name:')).toHaveValue('ComfyUI');
	await app.getByLabel('Backend:').selectOption('lemonade');
	await expect(app.getByLabel('Name:')).toHaveValue('Lemonade');

	await app.getByRole('button', { name: 'Move Lemonade up' }).click();
	const rows = app.locator('.entry-name strong');
	await expect(rows).toHaveText(['Lemonade', 'e2e-sd15']);

	await app.getByRole('button', { name: 'Remove Lemonade' }).click();
	await expect(rows).toHaveText(['e2e-sd15']);
	await expect(app.getByLabel('Name:')).toHaveCount(0);
});
