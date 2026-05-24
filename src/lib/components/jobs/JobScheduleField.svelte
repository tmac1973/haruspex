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
</script>

<div class="schedule-field">
	<label class="row">
		<span class="label">Schedule</span>
		<select
			value={schedule.kind}
			onchange={(e) => changeKind((e.currentTarget as HTMLSelectElement).value as ScheduleKind)}
		>
			<option value="manual">Manual only</option>
			<option value="hourly">Every hour</option>
			<option value="daily">Daily</option>
			<option value="weekly">Weekly</option>
			<option value="interval">Every N minutes/hours</option>
		</select>
	</label>

	{#if schedule.kind === 'daily'}
		<label class="row sub">
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
		<label class="row sub">
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
		<label class="row sub">
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
		<label class="row sub">
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
</style>
