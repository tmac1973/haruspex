import { describe, it, expect, beforeEach } from 'vitest';
import {
	closeSettings,
	getSettingsNav,
	openSettings,
	settingsNavHandled,
	toggleSettings
} from './settingsNav.svelte';

describe('settingsNav', () => {
	beforeEach(() => closeSettings());

	it('opens at a section and anchor', () => {
		openSettings('general', 'lean-mode');
		expect({ ...getSettingsNav() }).toEqual({
			open: true,
			category: 'general',
			anchor: 'lean-mode'
		});
	});

	it('keeps the panel open once it has shown the section', () => {
		openSettings('general', 'lean-mode');
		settingsNavHandled();
		expect({ ...getSettingsNav() }).toEqual({ open: true, category: null, anchor: null });
	});

	it('toggles open and closed with no section', () => {
		toggleSettings();
		expect(getSettingsNav().open).toBe(true);
		expect(getSettingsNav().category).toBeNull();
		toggleSettings();
		expect(getSettingsNav().open).toBe(false);
	});

	it('forgets a pending section on close', () => {
		openSettings('network');
		closeSettings();
		expect({ ...getSettingsNav() }).toEqual({ open: false, category: null, anchor: null });
	});
});
