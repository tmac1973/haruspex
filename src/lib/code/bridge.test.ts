import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	OPEN_CODE_EVENT,
	openCodeAt,
	registerCodeOpener,
	relayToMain,
	useCodeRelay
} from './bridge';

const undo: (() => void)[] = [];
afterEach(() => {
	while (undo.length) undo.pop()!();
});

describe('Open in Code bridge', () => {
	it('hands the folder to the Code store’s opener', async () => {
		const opener = vi.fn(async () => {});
		undo.push(registerCodeOpener(opener));
		await openCodeAt('/home/tim/app');
		expect(opener).toHaveBeenCalledWith('/home/tim/app');
	});

	it('fails plainly when nothing can open a Code session', async () => {
		await expect(openCodeAt('/x')).rejects.toThrow('not available');
	});

	it('in a detached Shell window, sends the folder to the main window instead', async () => {
		const opener = vi.fn(async () => {});
		undo.push(registerCodeOpener(opener));
		const api = { emitToMain: vi.fn(async () => {}), raiseMain: vi.fn(async () => {}) };
		undo.push(useCodeRelay(relayToMain(api)));

		await openCodeAt('/home/tim/app');

		expect(opener).not.toHaveBeenCalled();
		expect(api.emitToMain).toHaveBeenCalledWith(OPEN_CODE_EVENT, { root: '/home/tim/app' });
		expect(api.raiseMain).toHaveBeenCalled();
	});
});
