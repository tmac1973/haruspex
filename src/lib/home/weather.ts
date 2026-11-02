/**
 * Weather for Home, from Open-Meteo (no key, no account), fetched through the
 * network proxy in Settings → Network. The place is looked up once, when the
 * card is added; later fetches use its coordinates.
 */
import { invoke } from '@tauri-apps/api/core';
import type { FetchedPage } from '#lib/ipc/gen/FetchedPage.ts';
import { getSettings } from '#lib/stores/settings.ts';

export type Units = 'metric' | 'imperial';

export interface WeatherConfig {
	/** The place as the user picked it ("Halifax, Nova Scotia, Canada"). */
	place: string;
	lat: number;
	lon: number;
	units: Units;
}

export interface Place {
	name: string;
	lat: number;
	lon: number;
}

export interface DayForecast {
	max: number;
	min: number;
	/** Chance of rain, 0–100; null when the forecast has none. */
	rain: number | null;
	code: number;
}

export interface WeatherResult {
	now: { temp: number; code: number; wind: number };
	today: DayForecast;
	tomorrow: DayForecast | null;
	units: Units;
}

/** Fetch JSON through the network proxy. */
async function getJson(url: string): Promise<unknown> {
	const page = await invoke<FetchedPage>('proxy_fetch', {
		url,
		caller: 'home-weather',
		proxy: getSettings().proxy
	});
	try {
		return JSON.parse(page.text);
	} catch {
		throw new Error('Open-Meteo sent something that is not JSON.');
	}
}

/** Up to five places matching a name. */
export async function geocode(name: string): Promise<Place[]> {
	const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.trim())}&count=5`;
	const body = (await getJson(url)) as {
		results?: {
			name: string;
			admin1?: string;
			country?: string;
			latitude: number;
			longitude: number;
		}[];
	};
	return (body.results ?? []).map((r) => ({
		name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
		lat: r.latitude,
		lon: r.longitude
	}));
}

export function forecastUrl(config: Pick<WeatherConfig, 'lat' | 'lon' | 'units'>): string {
	const base =
		`https://api.open-meteo.com/v1/forecast?latitude=${config.lat}&longitude=${config.lon}` +
		'&current=temperature_2m,weather_code,wind_speed_10m' +
		'&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
		'&timezone=auto&forecast_days=2';
	// Open-Meteo answers in °C and km/h unless asked otherwise.
	return config.units === 'imperial'
		? `${base}&temperature_unit=fahrenheit&wind_speed_unit=mph`
		: base;
}

interface ForecastBody {
	current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
	daily?: {
		temperature_2m_max: number[];
		temperature_2m_min: number[];
		precipitation_probability_max?: (number | null)[];
		weather_code: number[];
	};
}

/** The parts of a forecast reply the card shows. */
export function parseForecast(body: unknown, units: Units): WeatherResult {
	const b = body as ForecastBody;
	if (!b.current || !b.daily?.temperature_2m_max?.length) {
		throw new Error('Open-Meteo sent a forecast with no current weather.');
	}
	const day = (i: number): DayForecast | null =>
		i < b.daily!.temperature_2m_max.length
			? {
					max: b.daily!.temperature_2m_max[i],
					min: b.daily!.temperature_2m_min[i],
					rain: b.daily!.precipitation_probability_max?.[i] ?? null,
					code: b.daily!.weather_code[i]
				}
			: null;
	return {
		now: {
			temp: b.current.temperature_2m,
			code: b.current.weather_code,
			wind: b.current.wind_speed_10m
		},
		today: day(0)!,
		tomorrow: day(1),
		units
	};
}

export async function fetchWeather(config: WeatherConfig): Promise<WeatherResult> {
	return parseForecast(await getJson(forecastUrl(config)), config.units);
}

/** A WMO weather code as a word or two and an icon. */
export function weatherLabel(code: number): { label: string; icon: string } {
	if (code === 0) return { label: 'Clear', icon: '☀️' };
	if (code <= 2) return { label: 'Partly cloudy', icon: '⛅' };
	if (code === 3) return { label: 'Overcast', icon: '☁️' };
	if (code === 45 || code === 48) return { label: 'Fog', icon: '🌫️' };
	if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: '🌦️' };
	if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82))
		return { label: 'Rain', icon: '🌧️' };
	if ((code >= 71 && code <= 77) || code === 85 || code === 86)
		return { label: 'Snow', icon: '🌨️' };
	if (code >= 95) return { label: 'Thunderstorm', icon: '⛈️' };
	return { label: 'Unknown', icon: '❔' };
}
