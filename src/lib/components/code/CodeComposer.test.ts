import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import CodeComposer from './CodeComposer.svelte';
import type { CodeSession } from '#lib/stores/code.svelte.ts';
import type { SlashHost } from '#lib/slash/slash.ts';

const host: SlashHost = {
	projectRoot: async () => null,
	codeMode: () => true,
	newConversation: vi.fn(),
	addNote: vi.fn()
};

function fakeSession(over: Partial<Record<string, unknown>> = {}): CodeSession {
	return {
		messages: [],
		busy: true,
		returnedSteering: [],
		returnedImages: [],
		takeReturnedSteering: vi.fn(() => []),
		takeReturnedImages: vi.fn(() => []),
		setDraftReader: vi.fn(() => () => {}),
		folderMissing: false,
		root: '/proj',
		send: vi.fn(async () => {}),
		stop: vi.fn(),
		...over
	} as unknown as CodeSession;
}

describe('CodeComposer steering', () => {
	it('queues Enter as a steering message while the agent works', async () => {
		const session = fakeSession();
		render(CodeComposer, { session, slashHost: host });
		const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
		expect(box.placeholder).toMatch(/Steer the agent/);
		await fireEvent.input(box, { target: { value: 'try the other file' } });
		await fireEvent.keyDown(box, { key: 'Enter' });
		expect(session.send).toHaveBeenCalledWith('try the other file');
		expect(box.value).toBe('');
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
	});

	it('Esc stops the turn', async () => {
		const session = fakeSession();
		render(CodeComposer, { session, slashHost: host });
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Escape' });
		expect(session.stop).toHaveBeenCalled();
	});

	it('puts steering the turn never delivered back in the box', () => {
		const session = fakeSession({
			busy: false,
			returnedSteering: ['one', 'two'],
			takeReturnedSteering: vi.fn(() => ['one', 'two'])
		});
		render(CodeComposer, { session, slashHost: host });
		const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
		expect(box.value).toBe('one\n\ntwo');
		expect(session.takeReturnedSteering).toHaveBeenCalled();
	});

	it('puts a message stopped in the queue back, images included', () => {
		const session = fakeSession({
			busy: false,
			returnedSteering: ['fix it'],
			returnedImages: ['data:image/png;base64,x'],
			takeReturnedSteering: vi.fn(() => ['fix it']),
			takeReturnedImages: vi.fn(() => ['data:image/png;base64,x'])
		});
		render(CodeComposer, { session, slashHost: host });
		const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
		expect(box.value).toBe('fix it');
		expect(screen.getByAltText('attachment').getAttribute('src')).toBe('data:image/png;base64,x');
	});
});

describe('CodeComposer unsent input', () => {
	it('lets the session read what is typed and attached', async () => {
		let read: (() => { text: string; images: string[] }) | null = null;
		const session = fakeSession({
			busy: false,
			setDraftReader: vi.fn((fn: () => { text: string; images: string[] }) => {
				read = fn;
				return () => {};
			})
		});
		render(CodeComposer, { session, slashHost: host });
		const box = screen.getByRole('textbox', { name: 'Message' });
		await fireEvent.input(box, { target: { value: 'half a thought' } });
		expect(read!()).toEqual({ text: 'half a thought', images: [] });
	});
});

describe('CodeComposer with the folder gone', () => {
	it('is disabled and says why', async () => {
		const session = fakeSession({ busy: false, folderMissing: true, root: '/gone' });
		render(CodeComposer, { session, slashHost: host });
		const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
		expect(box.disabled).toBe(true);
		expect(box.placeholder).toBe('Folder not found: /gone');
		const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(send.title).toBe('Folder not found: /gone');
		await fireEvent.keyDown(box, { key: 'Enter' });
		expect(session.send).not.toHaveBeenCalled();
	});
});
