import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

const settings = vi.hoisted(() => ({ homeSeeded: false }));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => settings,
	updateSettings: (partial: Partial<typeof settings>) => Object.assign(settings, partial)
}));

const jobs = vi.hoisted(() => ({ deleteJob: vi.fn(async () => true) }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({ deleteJob: jobs.deleteJob }));

import {
	_resetForTests,
	addCard,
	getHomeCards,
	loadHomeCards,
	moveCard,
	removeCard,
	setCardSize
} from './homeCards.svelte';

/** A table in memory, behind the same commands the store calls. */
let rows: HomeCard[] = [];

function row(id: string, cardType: string, size = 'normal', jobId: number | null = null): HomeCard {
	return {
		id,
		card_type: cardType,
		job_id: jobId,
		position: rows.length,
		size,
		config: '{}',
		notify: false,
		last_result: null,
		updated_at: null,
		created_at: 0
	};
}

function types(): string[] {
	return getHomeCards().map((c) => c.card_type);
}

beforeEach(() => {
	_resetForTests();
	settings.homeSeeded = false;
	rows = [];
	tauri.invoke.mockReset();
	jobs.deleteJob.mockClear();
	tauri.invoke.mockImplementation(
		invokeRouter({
			db_home_cards_list: () => rows.map((r) => ({ ...r })),
			db_home_cards_create: (a) => {
				const r = row(
					String(a!.id),
					String(a!.cardType),
					String(a!.size),
					(a!.jobId as number | null) ?? null
				);
				rows.push(r);
				return r;
			},
			db_home_cards_delete: (a) => {
				rows = rows.filter((r) => r.id !== a!.id);
			},
			db_home_cards_reorder: (a) => {
				const ids = a!.ids as string[];
				rows.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
			},
			db_home_cards_update: (a) => {
				const r = rows.find((x) => x.id === a!.id)!;
				if (a!.size) r.size = String(a!.size);
			}
		})
	);
});

describe('homeCards', () => {
	it('starts a new Home with the Jobs and Code sessions cards, once', async () => {
		await loadHomeCards();
		expect(types()).toEqual(['jobs', 'code_sessions']);
		expect(settings.homeSeeded).toBe(true);

		await removeCard(getHomeCards()[0].id);
		await removeCard(getHomeCards()[0].id);
		_resetForTests();
		await loadHomeCards();
		expect(types()).toEqual([]);
	});

	it('does not add the starting cards to a Home that already has cards', async () => {
		rows.push(row('x', 'pinned_job'));
		await loadHomeCards();
		expect(types()).toEqual(['pinned_job']);
		expect(settings.homeSeeded).toBe(true);
	});

	it('moves a card up and down, and does nothing at either end', async () => {
		settings.homeSeeded = true;
		await addCard('a');
		await addCard('b');
		await addCard('c');
		const [a, , c] = getHomeCards();

		await moveCard(a.id, -1);
		await moveCard(c.id, 1);
		expect(types()).toEqual(['a', 'b', 'c']);
		expect(tauri.invoke).not.toHaveBeenCalledWith('db_home_cards_reorder', expect.anything());

		await moveCard(a.id, 1);
		expect(types()).toEqual(['b', 'a', 'c']);
		await moveCard(c.id, -1);
		expect(types()).toEqual(['b', 'c', 'a']);
	});

	it('switches a card between normal and wide', async () => {
		settings.homeSeeded = true;
		const card = await addCard('jobs');
		await setCardSize(card!.id, 'wide');
		expect(getHomeCards()[0].size).toBe('wide');
		await setCardSize(card!.id, 'normal');
		expect(getHomeCards()[0].size).toBe('normal');
	});

	it('removes a pinned card and keeps its job, unless asked to delete it too', async () => {
		settings.homeSeeded = true;
		const kept = await addCard('pinned_job', {}, 7);
		const gone = await addCard('pinned_job', {}, 8);

		await removeCard(kept!.id);
		expect(jobs.deleteJob).not.toHaveBeenCalled();

		await removeCard(gone!.id, { deleteJob: true });
		expect(jobs.deleteJob).toHaveBeenCalledWith(8);
		expect(getHomeCards()).toEqual([]);
	});
});
