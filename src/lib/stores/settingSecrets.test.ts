import { describe, it, expect, vi, beforeEach } from 'vitest';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);
const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { getSettings, updateSettings } from './settings';
import { settingSecret } from './settingSecrets';

// Any string field and its flag will do; the Brave key's are real ones.
const key = settingSecret('test:key', 'braveApiKey', 'braveApiKeySaved');
const realSet = secrets.routes.secret_set;

beforeEach(() => {
	secrets.reset();
	updateSettings({ braveApiKey: '', braveApiKeySaved: false });
});

describe('settingSecret', () => {
	it('keeps the value in the store and only a flag in the settings', async () => {
		await key.save('abc');
		expect(secrets.stored.get('test:key')).toBe('abc');
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
		expect(key.configured()).toBe(true);
	});

	it('never leaves the value in the settings, even where no store lasts', async () => {
		// Rust holds it in memory for the session then.
		secrets.available = false;
		await key.save('abc');
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
	});

	it('forgets both on remove', async () => {
		await key.save('abc');
		await key.remove();
		expect(secrets.stored.has('test:key')).toBe(false);
		expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: false });
		expect(key.configured()).toBe(false);
	});

	describe('migrate', () => {
		it('moves an inline value into the store', async () => {
			updateSettings({ braveApiKey: 'old' });
			await key.migrate();
			expect(secrets.stored.get('test:key')).toBe('old');
			expect(getSettings()).toMatchObject({ braveApiKey: '', braveApiKeySaved: true });
		});

		it('does nothing when there is nothing inline, or no store', async () => {
			await key.migrate();
			expect(secrets.stored.size).toBe(0);
			updateSettings({ braveApiKey: 'old' });
			secrets.available = false;
			await key.migrate();
			expect(secrets.stored.size).toBe(0);
			expect(getSettings().braveApiKey).toBe('old');
		});

		it('keeps the inline value when the store refuses it', async () => {
			updateSettings({ braveApiKey: 'old' });
			secrets.refuseSet = true;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			await key.migrate();
			expect(getSettings()).toMatchObject({ braveApiKey: 'old', braveApiKeySaved: false });
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it('keeps a value the user typed while it was moving', async () => {
			updateSettings({ braveApiKey: 'old' });
			secrets.routes.secret_set = (a) => {
				updateSettings({ braveApiKey: 'typed meanwhile' });
				return realSet(a);
			};
			try {
				await key.migrate();
			} finally {
				secrets.routes.secret_set = realSet;
			}
			expect(getSettings().braveApiKey).toBe('typed meanwhile');
		});
	});

	it('counts an inline value as configured too', () => {
		expect(key.configured({ ...getSettings(), braveApiKey: 'x' })).toBe(true);
		expect(key.configured()).toBe(false);
	});
});
