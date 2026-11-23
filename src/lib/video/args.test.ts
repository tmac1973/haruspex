import { describe, expect, it } from 'vitest';
import { episodeArg, parseChapters, parseRange, parseTime } from './args';

describe('parseTime', () => {
	it('reads seconds, m:ss and h:mm:ss, with a fraction', () => {
		expect(parseTime(75)).toBe(75);
		expect(parseTime('75')).toBe(75);
		expect(parseTime('1:15')).toBe(75);
		expect(parseTime('1:15.5')).toBe(75.5);
		expect(parseTime('0:01:15')).toBe(75);
	});

	it('is null for anything else', () => {
		for (const v of [undefined, null, '', 'soon', '1:2:3:4', '1:150', ':15', '1:15.']) {
			expect(parseTime(v), String(v)).toBeNull();
		}
	});
});

describe('parseRange', () => {
	it('takes from, to and a gain, muting when the gain is left out', () => {
		expect(parseRange({ from: '0:01', to: '0:02', gain_db: -6 }, '')).toEqual({
			fromSecs: 1,
			toSecs: 2,
			gainDb: -6
		});
		expect(parseRange({ range_from: 1, range_to: 2 }, '')).toEqual({
			fromSecs: 1,
			toSecs: 2,
			gainDb: -70
		});
	});

	it('needs to after from', () => {
		expect(parseRange({ from: 2, to: 2 }, 'items[0] ')).toBe(
			'items[0] needs from and to, times in the clip with to after from.'
		);
		expect(parseRange({ from: 3, to: 2 }, '')).toMatch(/to after from/);
		expect(parseRange({ from: 1 }, '')).toMatch(/to after from/);
	});

	it('keeps the gain between -70 and +20 dB', () => {
		expect(parseRange({ from: 0, to: 1, gain_db: 20 }, '')).toMatchObject({ gainDb: 20 });
		expect(parseRange({ from: 0, to: 1, gain_db: -70 }, '')).toMatchObject({ gainDb: -70 });
		expect(parseRange({ from: 0, to: 1, gain_db: 21 }, '')).toBe('gain_db is -70 (mute) to +20.');
		expect(parseRange({ from: 0, to: 1, gain_db: -71 }, '')).toBe('gain_db is -70 (mute) to +20.');
	});
});

describe('parseChapters', () => {
	it('reads titles and times', () => {
		expect(
			parseChapters([
				{ title: ' Intro ', at: 0 },
				{ title: 'Setup', at: '1:23' }
			])
		).toEqual([
			{ title: 'Intro', atSecs: 0 },
			{ title: 'Setup', atSecs: 83 }
		]);
	});

	it('names the chapter that is missing something, and needs at least one', () => {
		expect(
			parseChapters([
				{ title: 'A', at: 0 },
				{ title: '', at: 5 }
			])
		).toBe('chapters[1] needs "title" and "at" (a time like 1:23).');
		expect(parseChapters([{ title: 'A', at: 'later' }])).toMatch(/^chapters\[0\]/);
		expect(parseChapters([])).toBe('video_chapters needs "chapters".');
		expect(parseChapters(undefined)).toBe('video_chapters needs "chapters".');
	});
});

describe('episodeArg', () => {
	it('is the episode when it is a string, else empty', () => {
		expect(episodeArg({ episode: 'ep010' })).toBe('ep010');
		expect(episodeArg({ episode: 10 })).toBe('');
		expect(episodeArg({})).toBe('');
	});
});
