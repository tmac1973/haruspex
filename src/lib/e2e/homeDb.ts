/**
 * The Home tab's tables, in memory, for the UI end-to-end tests: just enough
 * of `src-tauri/src/db/home_cards.rs` for Home to seed, list and arrange its
 * cards. The main window loads them at startup, for Notify on new items.
 */
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

type Args = Record<string, unknown> | undefined;

let cards: HomeCard[] = [];

export const HOME_DB: Record<string, (a: Args) => unknown> = {
	db_home_cards_list: () => cards,
	db_home_cards_create: (a) => {
		const card: HomeCard = {
			id: a?.id as string,
			card_type: a?.cardType as string,
			job_id: (a?.jobId as number | null) ?? null,
			position: cards.length,
			size: (a?.size as string) ?? 'normal',
			config: (a?.config as string) ?? '{}',
			notify: false,
			last_result: null,
			updated_at: null,
			created_at: Date.now()
		};
		cards = [...cards, card];
		return card;
	},
	db_home_cards_update: (a) => {
		cards = cards.map((c) =>
			c.id === a?.id
				? {
						...c,
						size: (a?.size as string) ?? c.size,
						config: (a?.config as string) ?? c.config,
						notify: (a?.notify as boolean) ?? c.notify
					}
				: c
		);
		return null;
	},
	db_home_cards_set_result: (a) => {
		cards = cards.map((c) =>
			c.id === a?.id
				? { ...c, last_result: a?.lastResult as string, updated_at: a?.updatedAt as number }
				: c
		);
		return null;
	},
	db_home_cards_delete: (a) => {
		cards = cards.filter((c) => c.id !== a?.id);
		return null;
	},
	db_home_cards_reorder: (a) => {
		const ids = a?.ids as string[];
		cards = [...cards].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
		return null;
	},
	db_job_runs_list_recent: () => [],
	db_job_runs_set_result: () => null
};
