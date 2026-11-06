import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ proxy: { mode: 'manual', url: 'http://proxy:3128' } })
	})
);

import { fetchWeather, forecastUrl, geocode, parseForecast, weatherLabel } from './weather';

/** A recorded Open-Meteo forecast reply, trimmed to the fields asked for. */
const FORECAST = {
	latitude: 44.65,
	longitude: -63.57,
	current: {
		time: '2026-11-02T10:00',
		temperature_2m: 7.4,
		weather_code: 61,
		wind_speed_10m: 18.2
	},
	daily: {
		time: ['2026-11-02', '2026-11-03'],
		temperature_2m_max: [9.1, 11.6],
		temperature_2m_min: [3.2, 4.8],
		precipitation_probability_max: [80, null],
		weather_code: [61, 2]
	}
};

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('forecastUrl', () => {
	it('asks for °F and mph only in imperial, since metric is the default', () => {
		const metric = forecastUrl({ lat: 44.65, lon: -63.57, units: 'metric' });
		expect(metric).toContain('latitude=44.65&longitude=-63.57');
		expect(metric).not.toContain('temperature_unit');
		const imperial = forecastUrl({ lat: 1, lon: 2, units: 'imperial' });
		expect(imperial).toContain('&temperature_unit=fahrenheit&wind_speed_unit=mph');
	});
});

describe('parseForecast', () => {
	it('reads now, today and tomorrow', () => {
		expect(parseForecast(FORECAST, 'metric')).toEqual({
			now: { temp: 7.4, code: 61, wind: 18.2 },
			today: { max: 9.1, min: 3.2, rain: 80, code: 61 },
			tomorrow: { max: 11.6, min: 4.8, rain: null, code: 2 },
			units: 'metric'
		});
	});

	it('refuses a reply without current weather', () => {
		expect(() => parseForecast({ error: true }, 'metric')).toThrow(/no current weather/);
	});
});

describe('weatherLabel', () => {
	it.each([
		[0, 'Clear'],
		[2, 'Partly cloudy'],
		[45, 'Fog'],
		[53, 'Drizzle'],
		[81, 'Rain'],
		[75, 'Snow'],
		[96, 'Thunderstorm'],
		[42, 'Unknown']
	])('maps WMO code %i to %s', (code, label) => {
		expect(weatherLabel(code).label).toBe(label);
	});
});

describe('fetching', () => {
	it('goes through the network proxy and parses the reply text', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ proxy_fetch: { text: JSON.stringify(FORECAST), full_length: 1 } })
		);
		const out = await fetchWeather({ place: 'Halifax', lat: 44.65, lon: -63.57, units: 'metric' });
		expect(out.now.temp).toBe(7.4);
		expect(invoke).toHaveBeenCalledWith(
			'proxy_fetch',
			expect.objectContaining({
				caller: 'home-weather',
				proxy: { mode: 'manual', url: 'http://proxy:3128' }
			})
		);
	});

	it('names each place with its region and country', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				proxy_fetch: {
					text: JSON.stringify({
						results: [
							{
								name: 'Halifax',
								admin1: 'Nova Scotia',
								country: 'Canada',
								latitude: 44.6,
								longitude: -63.5
							},
							{ name: 'Halifax', country: 'United Kingdom', latitude: 53.7, longitude: -1.8 }
						]
					})
				}
			})
		);
		expect(await geocode('Halifax')).toEqual([
			{ name: 'Halifax, Nova Scotia, Canada', lat: 44.6, lon: -63.5 },
			{ name: 'Halifax, United Kingdom', lat: 53.7, lon: -1.8 }
		]);
	});

	it('says so when the reply is not JSON', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ proxy_fetch: { text: '<html>blocked</html>' } })
		);
		await expect(geocode('x')).rejects.toThrow(/not JSON/);
	});
});
