import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
	deleteSecret,
	savedSecretPlaceholder,
	secretStoreAvailable,
	secretStoreKind
} from './secrets';

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('secret store helpers', () => {
	it('report no store when Rust cannot be asked', async () => {
		mocks.invoke.mockImplementation(async () => {
			throw new Error('no IPC');
		});
		expect(await secretStoreAvailable()).toBe(false);
		expect(await secretStoreKind()).toBe('none');
	});

	it('name the keychain only when that is where the secret went', () => {
		expect(savedSecretPlaceholder('keychain')).toBe('Saved in the system keychain');
		expect(savedSecretPlaceholder('file')).toBe('Saved in Haruspex');
	});

	it('do not throw when a delete fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.invoke.mockImplementation(async () => {
			throw new Error('locked');
		});
		await expect(deleteSecret('dav:a')).resolves.toBeUndefined();
	});
});
