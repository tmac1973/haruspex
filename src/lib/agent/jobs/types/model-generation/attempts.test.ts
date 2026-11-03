import { describe, expect, it } from 'vitest';
import { attemptDir, better } from './attempts';
import { attemptsLine } from './report';

const rank = (done: boolean, built: boolean, problems: number) => ({
	done,
	built,
	problems: Array.from({ length: problems }, (_, i) => `p${i}`)
});

describe('better', () => {
	it('takes any attempt over none', () => {
		expect(better(rank(false, false, 5), null)).toBe(true);
	});

	it('ranks done, then built, then fewer problems', () => {
		expect(better(rank(true, true, 0), rank(false, true, 1))).toBe(true);
		expect(better(rank(false, true, 3), rank(false, false, 1))).toBe(true);
		expect(better(rank(false, false, 1), rank(false, true, 3))).toBe(false);
		expect(better(rank(false, true, 1), rank(false, true, 2))).toBe(true);
	});

	it('keeps the earlier attempt on a tie', () => {
		expect(better(rank(false, true, 2), rank(false, true, 2))).toBe(false);
		expect(better(rank(true, true, 0), rank(true, true, 0))).toBe(false);
	});
});

describe('attemptDir', () => {
	it('numbers attempts by stage, with or without a trailing slash', () => {
		expect(attemptDir({ dir: 'assets/generated/model/knight/' }, 'animate', 3)).toBe(
			'assets/generated/model/knight/attempts/animate-03/'
		);
		expect(attemptDir({ dir: 'models/knight' }, 'create', 12)).toBe(
			'models/knight/attempts/create-12/'
		);
	});
});

describe('attemptsLine', () => {
	const entry = { dir: 'assets/generated/model/knight/' };

	it('names each stage’s count and the attempt kept', () => {
		expect(
			attemptsLine(entry, {
				attempts: 1,
				kept: 1,
				clips: { status: 'needs_work', problems: [], rounds: 3, sheets: [], attempts: 7, kept: 2 }
			})
		).toBe(
			'Creation: 1 attempt, kept `assets/generated/model/knight/attempts/create-01/`. ' +
				'Animation: 7 attempts, kept `assets/generated/model/knight/attempts/animate-02/`.'
		);
	});

	it('says nothing for an entry no stage judged', () => {
		expect(attemptsLine(entry, { attempts: 0, kept: null, clips: null })).toBeNull();
	});
});
