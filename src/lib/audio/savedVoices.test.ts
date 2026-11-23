import { describe, it, expect, afterEach } from 'vitest';
import { _setSavedVoicesForTests, savedVoiceNames, savedVoicesNote } from './savedVoices';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';

const voice = (name: string) => ({
	id: name.toLowerCase(),
	name,
	source: 'file',
	sourcePath: null,
	fromSecs: null,
	toSecs: null,
	refText: '',
	secs: 8,
	consentedAt: 1
});

afterEach(() => {
	updateSettings({ speechBackendKind: 'kokoro' });
	_setSavedVoicesForTests([]);
});

describe('the saved voices in the prompt', () => {
	it('starts on Kokoro, which needs no note', () => {
		expect(getSettings().speechBackendKind).toBe('kokoro');
		_setSavedVoicesForTests([voice('Tim')]);
		expect(savedVoicesNote()).toBe('');
	});

	it('names them when a llama.cpp server speaks', () => {
		updateSettings({ speechBackendKind: 'llama-server' });
		_setSavedVoicesForTests([voice('Tim'), voice('Narrator')]);
		expect(savedVoiceNames()).toEqual(['Tim', 'Narrator']);
		expect(savedVoicesNote()).toContain('"Tim", "Narrator"');
		_setSavedVoicesForTests([]);
		expect(savedVoicesNote()).toContain('No voices are saved');
	});
});
