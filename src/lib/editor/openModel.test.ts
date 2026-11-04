import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { splitFilePath } from './openModel';

describe('splitFilePath', () => {
	it('splits on either separator', () => {
		expect(splitFilePath('/home/t/knight/knight.glb')).toEqual(['/home/t/knight', 'knight.glb']);
		expect(splitFilePath('C:\\models\\imp.glb')).toEqual(['C:\\models', 'imp.glb']);
		expect(splitFilePath('/imp.glb')).toEqual(['/', 'imp.glb']);
	});
});
