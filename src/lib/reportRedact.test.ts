import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings.value
	})
);

import { redactForReport } from './reportRedact.ts';

describe('redactForReport', () => {
	it('sends the inline settings secrets along with the lines', async () => {
		settings.value = {
			integrations: { email: { accounts: [{ id: 'e1', password: 'inline-pw-123' }] } }
		};
		vi.mocked(invoke).mockResolvedValue(['[redacted]']);
		const out = await redactForReport(['inline-pw-123']);
		expect(out).toEqual(['[redacted]']);
		expect(invoke).toHaveBeenCalledWith('feedback_redact', {
			lines: ['inline-pw-123'],
			inline: ['inline-pw-123']
		});
	});
});
