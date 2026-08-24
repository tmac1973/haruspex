import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/memory.svelte', () => ({ refreshMemoryCount: vi.fn() }));

import MemoryRecallStep from './MemoryRecallStep.svelte';

function step(memories: unknown[]) {
	return {
		id: 'memory-recall-1',
		toolName: 'memory_recall',
		query: `${memories.length} memories recalled`,
		status: 'done' as const,
		args: { memories }
	};
}

const TABS = {
	id: 'mem-1',
	content: 'Prefers tabs over spaces.',
	category: 'preference',
	score: 0.8
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.invoke.mockResolvedValue(undefined);
});

describe('MemoryRecallStep', () => {
	it('summarises without listing until expanded', async () => {
		// On a turn where recall worked this is noise; it earns its space only
		// when an answer is surprising.
		render(MemoryRecallStep, { step: step([TABS]) });
		expect(screen.getByText(/Recalled 1/)).toBeTruthy();
		expect(screen.queryByText('Prefers tabs over spaces.')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /Recalled 1/ }));
		expect(screen.getByText('Prefers tabs over spaces.')).toBeTruthy();
	});

	it('renders nothing when the step carries no memories', () => {
		render(MemoryRecallStep, { step: step([]) });
		expect(screen.queryByText(/Recalled/)).toBeNull();
	});

	it('survives a step whose args are not the expected shape', () => {
		// Steps persist to the DB and are read back; a row written by an older
		// build must not take the chat view down.
		render(MemoryRecallStep, {
			step: { ...step([]), args: { memories: 'not an array' } }
		});
		expect(screen.queryByText(/Recalled/)).toBeNull();
	});

	/**
	 * The answer above was already generated with this memory in its prompt.
	 * Forgetting affects later turns; saying otherwise would be the opposite
	 * of the transparency this view exists for.
	 */
	it('forgets a memory and says the change applies to future chats', async () => {
		render(MemoryRecallStep, { step: step([TABS]) });
		await fireEvent.click(screen.getByRole('button', { name: /Recalled 1/ }));

		await fireEvent.click(screen.getByText('Forget this'));

		expect(mocks.invoke).toHaveBeenCalledWith('memory_delete', { id: 'mem-1' });
		expect(screen.getByText(/future chats only/)).toBeTruthy();
	});

	it('leaves the row listed when the delete fails', async () => {
		mocks.invoke.mockRejectedValueOnce(new Error('db locked'));
		render(MemoryRecallStep, { step: step([TABS]) });
		await fireEvent.click(screen.getByRole('button', { name: /Recalled 1/ }));

		await fireEvent.click(screen.getByText('Forget this'));

		expect(screen.queryByText(/future chats only/)).toBeNull();
		expect(screen.getByText('Forget this')).toBeTruthy();
	});
});
