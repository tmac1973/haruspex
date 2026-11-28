import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));

import {
	handleSendToChat,
	holds,
	pickConversation,
	type Candidate,
	type ChatTargets
} from './chatBridge';

const list: Candidate[] = [
	{ kind: 'chat', id: 'old', folder: '/v', updatedAt: 1 },
	{ kind: 'code', id: 'code', folder: '/v/ep012', updatedAt: 5 },
	{ kind: 'chat', id: 'other', folder: '/elsewhere', updatedAt: 9 },
	{ kind: 'chat', id: 'none', folder: null, updatedAt: 10 }
];

function targets(cands: Candidate[]) {
	return {
		candidates: vi.fn(async () => cands),
		fillChat: vi.fn(async () => {}),
		fillCode: vi.fn(async () => {}),
		newChat: vi.fn(),
		raise: vi.fn(async () => {})
	} satisfies ChatTargets;
}

const payload = {
	folder: '/v/ep012',
	command: '/fix-speech apply',
	path: '/v/ep012/.haruspex/edits/obs.edits.json'
};

describe('send to chat', () => {
	it('knows which folders hold which', () => {
		expect(holds('/v', '/v/ep012')).toBe(true);
		expect(holds('/v/', '/v')).toBe(true);
		expect(holds('/v', '/vx')).toBe(false);
		expect(holds('C:\\v', 'C:\\v\\ep')).toBe(true);
	});

	it('picks the most recent conversation whose folder holds the file', () => {
		expect(pickConversation(list, '/v/ep012')?.id).toBe('code');
		expect(pickConversation(list, '/v/ep013')?.id).toBe('old');
		expect(pickConversation(list, '/nowhere')).toBeNull();
	});

	it('fills that conversation with the path relative to its folder, and raises the window', async () => {
		const t = targets(list);
		await handleSendToChat(payload, t);
		expect(t.fillCode).toHaveBeenCalledWith(
			'code',
			'/fix-speech apply .haruspex/edits/obs.edits.json'
		);
		expect(t.raise).toHaveBeenCalled();
		const chats = targets([list[0]]);
		await handleSendToChat(payload, chats);
		expect(chats.fillChat).toHaveBeenCalledWith(
			'old',
			'/fix-speech apply ep012/.haruspex/edits/obs.edits.json'
		);
	});

	it('starts a Chat in the folder when none works there', async () => {
		const t = targets([]);
		await handleSendToChat(payload, t);
		expect(t.newChat).toHaveBeenCalledWith(
			'/v/ep012',
			'/fix-speech apply .haruspex/edits/obs.edits.json'
		);
	});
});
