import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import {
	deleteSecret,
	savedSecretPlaceholder,
	secretStoreHint,
	secretStoreAvailable,
	secretStoreKind
} from './secrets';

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('secret store helpers', () => {
	it('report no store when Rust cannot be asked', async () => {
		vi.mocked(invoke).mockImplementation(async () => {
			throw new Error('no IPC');
		});
		expect(await secretStoreAvailable()).toBe(false);
		expect(await secretStoreKind()).toBe('none');
	});

	it('say where the secret went, including when it lasts only for the session', () => {
		expect(savedSecretPlaceholder('keychain')).toBe('Saved in the system keychain');
		expect(savedSecretPlaceholder('file')).toBe("Saved in Haruspex's encrypted file");
		expect(savedSecretPlaceholder('none')).toBe('Kept until Haruspex closes');
		expect(secretStoreHint('file')).toMatch(/anything that can read your files/);
		expect(secretStoreHint('none')).toMatch(/after Haruspex restarts/);
	});

	it('do not throw when a delete fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.mocked(invoke).mockImplementation(async () => {
			throw new Error('locked');
		});
		await expect(deleteSecret('dav:a')).resolves.toBeUndefined();
	});
});
