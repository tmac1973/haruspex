<script lang="ts">
	/** Home's Weather card: now, today and tomorrow for one place, from Open-Meteo. */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import { weatherLabel, type DayForecast, type WeatherResult } from '#lib/home/weather.ts';
	import { getCardError } from '#lib/home/fetchedCards.svelte.ts';

	let { card }: { card: HomeCard } = $props();

	const result = $derived.by((): WeatherResult | null => {
		try {
			return card.last_result ? (JSON.parse(card.last_result) as WeatherResult) : null;
		} catch {
			return null;
		}
	});
	const place = $derived.by(() => {
		try {
			return (JSON.parse(card.config) as { place?: string }).place ?? '';
		} catch {
			return '';
		}
	});
	const error = $derived(getCardError(card.id));
	const deg = $derived(result?.units === 'imperial' ? '°F' : '°C');
	const speed = $derived(result?.units === 'imperial' ? 'mph' : 'km/h');

	function day(d: DayForecast): string {
		const rain = d.rain === null ? '' : ` · ${d.rain}% rain`;
		return `${weatherLabel(d.code).label}, ${Math.round(d.min)}–${Math.round(d.max)}${deg}${rain}`;
	}
</script>

{#if place}
	<p class="place" title={place}>{place}</p>
{/if}
{#if error}
	<p class="error" title={error}>{error}</p>
{/if}
{#if result}
	{@const now = weatherLabel(result.now.code)}
	<div class="now">
		<span class="icon" aria-hidden="true">{now.icon}</span>
		<span class="temp">{Math.round(result.now.temp)}{deg}</span>
		<span class="detail">{now.label} · wind {Math.round(result.now.wind)} {speed}</span>
	</div>
	<p class="day"><strong>Today</strong> {day(result.today)}</p>
	{#if result.tomorrow}
		<p class="day"><strong>Tomorrow</strong> {day(result.tomorrow)}</p>
	{/if}
{:else if !error}
	<p class="muted">Getting the forecast…</p>
{/if}

<style>
	.place,
	.muted,
	.detail {
		color: var(--text-secondary);
	}

	.place {
		margin: 0 0 6px;
		font-size: 0.78rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.now {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 6px;
	}

	.icon {
		font-size: 1.4rem;
	}

	.temp {
		font-size: 1.5rem;
		font-weight: 600;
	}

	.detail {
		font-size: 0.8rem;
	}

	.day {
		margin: 2px 0;
		font-size: 0.82rem;
	}

	.muted,
	.error {
		margin: 4px 0;
	}

	.error {
		color: var(--error-text);
	}
</style>
