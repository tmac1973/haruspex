import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listSkills: vi.fn(),
	readSkillForTurn: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
// jsdom draws nothing: a picture is "downscaled" by marking it.
vi.mock('#lib/utils/image.ts', () => ({ downscaleDataUrl: async (u: string) => `${u}#small` }));
vi.mock('#lib/skills/client.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/skills/client.ts')>()),
	listSkills: mocks.listSkills,
	readSkillForTurn: mocks.readSkillForTurn
}));

import { attachImages, MAX_IMAGES, slashFor } from './attach.ts';

const HASH = 'a'.repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.listSkills.mockReset().mockResolvedValue([
		{
			name: 'fix-picture',
			description: 'Change a picture.',
			needs: [],
			codeModeOnly: false,
			shadowed: false,
			error: null
		}
	]);
	mocks.readSkillForTurn.mockReset().mockResolvedValue({ name: 'fix-picture', body: 'Steps.' });
});

describe('attachImages', () => {
	it('takes none', async () => {
		expect(await attachImages(undefined)).toEqual([]);
		expect(await attachImages([])).toEqual([]);
	});

	it('reads an uploaded picture by hash, as a data URL of its own type', async () => {
		mocks.invoke.mockResolvedValue(JPEG.buffer);
		const [url] = await attachImages([HASH]);
		expect(mocks.invoke).toHaveBeenCalledWith('image_read_bytes', { hash: HASH });
		expect(url).toBe('data:image/jpeg;base64,/9j/4A==#small');
	});

	it("takes the app's own image URLs and data URLs too", async () => {
		mocks.invoke.mockResolvedValue(new Uint8Array([0x89, 0x50]).buffer);
		const out = await attachImages([
			`haruspex-img://localhost/${HASH}`,
			'data:image/png;base64,AA'
		]);
		expect(out[0]).toMatch(/^data:image\/png;base64,/);
		expect(out[1]).toBe('data:image/png;base64,AA#small');
	});

	it('refuses what is not a picture, one the cache has lost, and too many', async () => {
		await expect(attachImages('x')).rejects.toThrow('a list of picture hashes');
		await expect(attachImages(['https://example.com/cat.png'])).rejects.toThrow('upload it first');
		await expect(attachImages(['data:text/html;base64,AA'])).rejects.toThrow('upload it first');
		mocks.invoke.mockRejectedValue(new Error('Image not found'));
		await expect(attachImages([HASH])).rejects.toThrow('upload it again');
		await expect(attachImages(Array(MAX_IMAGES + 1).fill(HASH))).rejects.toThrow(
			`at most ${MAX_IMAGES}`
		);
	});
});

describe('slashFor', () => {
	const host =
		(made = 'new-chat') =>
		() => ({
			projectRoot: async () => null,
			newConversation: async () => made
		});

	it('sends plain text as it is', async () => {
		expect(await slashFor('make it night', host())).toEqual({ kind: 'send' });
		expect(mocks.listSkills).not.toHaveBeenCalled();
	});

	it('sends a skill the /name names, with the message', async () => {
		expect(await slashFor('/fix-picture make it night', host())).toEqual({
			kind: 'send',
			skill: { name: 'fix-picture', body: 'Steps.' }
		});
	});

	it('answers what /skills would show, and the chat /new made', async () => {
		const skills = await slashFor('/skills', host());
		expect(skills.kind).toBe('handled');
		expect(skills.kind === 'handled' && skills.note).toContain('`/fix-picture`');
		expect(await slashFor('/new', host('c9'))).toEqual({ kind: 'handled', id: 'c9' });
	});

	it('sends a sentence that only looks like a command', async () => {
		expect(await slashFor('/etc/hosts is broken', host())).toEqual({ kind: 'send' });
	});
});
