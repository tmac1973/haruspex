<script lang="ts">
	import type { Schedule, ScheduleKind, Weekday } from '$lib/stores/jobs.svelte';

	interface Props {
		schedule: Schedule;
		onchange: (next: Schedule) => void;
	}

	const { schedule, onchange }: Props = $props();

	const weekdays: { value: Weekday; label: string }[] = [
		{ value: 'mon', label: 'Monday' },
		{ value: 'tue', label: 'Tuesday' },
		{ value: 'wed', label: 'Wednesday' },
		{ value: 'thu', label: 'Thursday' },
		{ value: 'fri', label: 'Friday' },
		{ value: 'sat', label: 'Saturday' },
		{ value: 'sun', label: 'Sunday' }
	];

	function changeKind(kind: ScheduleKind) {
		switch (kind) {
			case 'manual':
				onchange({ kind: 'manual' });
				return;
			case 'hourly':
				onchange({ kind: 'hourly' });
				return;
			case 'daily':
				onchange({ kind: 'daily', time: defaultTime() });
				return;
			case 'weekly':
				onchange({ kind: 'weekly', day: defaultDay(), time: defaultTime() });
				return;
			case 'interval':
				onchange({ kind: 'interval', minutes: defaultMinutes() });
				return;
		}
	}

	function defaultTime(): string {
		if (schedule.kind === 'daily' || schedule.kind === 'weekly') return schedule.time;
		return '09:00';
	}

	function defaultDay(): Weekday {
		if (schedule.kind === 'weekly') return schedule.day;
		return 'mon';
	}

	function defaultMinutes(): number {
		if (schedule.kind === 'interval') return schedule.minutes;
		return 30;
	}

	const SCHEDULE_TOOLTIP =
		"When to run the job automatically. IMPORTANT: Haruspex must be open and running for the scheduler to fire — there's no background service. Schedules that come due while the app is closed are dropped, not retro-run on next launch. Use 'Manual only' if you only want to kick the job off yourself.";
</script>

<div class="schedule-field">
	<label class="row" title={SCHEDULE_TOOLTIP}>
		<span class="label">Schedule</span>
		<select
			value={schedule.kind}
			onchange={(e) => changeKind((e.currentTarget as HTMLSelectElement).value as ScheduleKind)}
			title={SCHEDULE_TOOLTIP}
		>
			<option value="manual">Manual only</option>
			<option value="hourly">Every hour</option>
			<option value="daily">Daily</option>
			<option value="weekly">Weekly</option>
			<option value="interval">Every N minutes/hours</option>
		</select>
	</label>

	{#if schedule.kind !== 'manual'}
		<p class="schedule-warning">
			⚠ Haruspex must be open and running for the scheduler to fire. Missed runs while the app is
			closed are dropped — they don't catch up on next launch.
		</p>
	{/if}

	{#if schedule.kind === 'daily'}
		<label class="row sub" title="Local time of day this job fires every day.">
			<span class="label">At</span>
			<input
				type="time"
				value={schedule.time}
				onchange={(e) =>
					onchange({ kind: 'daily', time: (e.currentTarget as HTMLInputElement).value })}
			/>
		</label>
	{/if}

	{#if schedule.kind === 'weekly'}
		<label class="row sub" title="Day of the week this job fires.">
			<span class="label">On</span>
			<select
				value={schedule.day}
				onchange={(e) =>
					onchange({
						kind: 'weekly',
						day: (e.currentTarget as HTMLSelectElement).value as Weekday,
						time: schedule.time
					})}
			>
				{#each weekdays as wd (wd.value)}
					<option value={wd.value}>{wd.label}</option>
				{/each}
			</select>
		</label>
		<label class="row sub" title="Local time of day on the chosen weekday.">
			<span class="label">At</span>
			<input
				type="time"
				value={schedule.time}
				onchange={(e) =>
					onchange({
						kind: 'weekly',
						day: schedule.day,
						time: (e.currentTarget as HTMLInputElement).value
					})}
			/>
		</label>
	{/if}

	{#if schedule.kind === 'interval'}
		<label
			class="row sub"
			title="The job fires this many minutes after its previous due time, regardless of how long the run itself took — cadence stays steady even if a run runs long."
		>
			<span class="label">Every</span>
			<input
				type="number"
				min="1"
				step="1"
				value={schedule.minutes}
				onchange={(e) => {
					const n = parseInt((e.currentTarget as HTMLInputElement).value, 10);
					onchange({ kind: 'interval', minutes: Number.isFinite(n) && n > 0 ? n : 1 });
				}}
			/>
			<span class="unit">minutes</span>
		</label>
	{/if}
</div>

<style>
	.schedule-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.row.sub {
		padding-left: 16px;
	}

	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
		min-width: 70px;
	}

	select,
	input[type='time'],
	input[type='number'] {
		padding: 4px 8px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.85rem;
		/* Tells the native widget renderer (GTK on Linux, Quartz on macOS)
		   to follow the user's color scheme — without this the closed
		   select shows the OS default's light-on-white selection color
		   even though our own colors are dark. */
		color-scheme: light dark;
	}

	input[type='number'] {
		width: 80px;
	}

	.unit {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.schedule-warning {
		margin: 2px 0 0 0;
		padding: 6px 10px;
		background: color-mix(in srgb, #f59e0b 12%, transparent);
		border: 1px solid color-mix(in srgb, #f59e0b 40%, var(--border));
		border-radius: 4px;
		font-size: 0.78rem;
		color: var(--text-primary);
		line-height: 1.35;
	}
</style>
