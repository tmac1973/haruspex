import { describe, expect, it } from 'vitest';
import {
	cleanAlertAddresses,
	MAX_WATCH_RULE_CHARS,
	MAX_WATCH_RULES,
	normalizeAlertConfig,
	normalizeCameraAlerts
} from './alertConfig';

describe('normalizeAlertConfig', () => {
	it('fills in an older camera with the defaults', () => {
		expect(normalizeAlertConfig(undefined)).toEqual({
			enabled: false,
			usualPeople: 1,
			watchRules: []
		});
	});

	it('keeps rules to their limits and drops blank ones', () => {
		const rules = ['  door open ', '', 'x'.repeat(400), ...Array(30).fill('r')];
		const out = normalizeAlertConfig({ enabled: true, usualPeople: 3.4, watchRules: rules });
		expect(out.enabled).toBe(true);
		expect(out.usualPeople).toBe(3);
		expect(out.watchRules).toHaveLength(MAX_WATCH_RULES);
		expect(out.watchRules[0]).toBe('door open');
		expect(out.watchRules[1]).toHaveLength(MAX_WATCH_RULE_CHARS);
	});

	it('clamps the usual number of people', () => {
		expect(normalizeAlertConfig({ usualPeople: -2 }).usualPeople).toBe(0);
		expect(normalizeAlertConfig({ usualPeople: 99 }).usualPeople).toBe(20);
		expect(normalizeAlertConfig({ usualPeople: NaN }).usualPeople).toBe(1);
	});

	it('keeps quiet hours only when both rows have 24 hours', () => {
		const day = Array(24).fill(false);
		expect(normalizeAlertConfig({ quietHours: { weekday: day, weekend: day } }).quietHours).toEqual(
			{ weekday: day, weekend: day }
		);
		expect(normalizeAlertConfig({ quietHours: { weekday: day, weekend: [] } })).not.toHaveProperty(
			'quietHours'
		);
		expect(normalizeAlertConfig({ quietHours: null })).not.toHaveProperty('quietHours');
	});
});

describe('alert addresses', () => {
	it('drops invalid and repeated addresses and keeps five', () => {
		expect(
			cleanAlertAddresses([
				' tim@example.com ',
				'TIM@example.com',
				'not an address',
				'a@b',
				'x@evil.test, y@evil.test',
				'b@example.com',
				'c@example.com',
				'd@example.com',
				'e@example.com',
				'f@example.com'
			])
		).toEqual([
			'tim@example.com',
			'b@example.com',
			'c@example.com',
			'd@example.com',
			'e@example.com'
		]);
	});

	it('normalizes the whole blob', () => {
		expect(normalizeCameraAlerts({ enabled: 'yes', to: 'a@b.c' })).toEqual({
			enabled: false,
			accountId: '',
			to: []
		});
	});
});
