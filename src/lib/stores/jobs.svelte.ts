import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '$lib/debug-log';

export type ScheduleKind = 'manual' | 'hourly' | 'daily' | 'weekly' | 'interval';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type Schedule =
	| { kind: 'manual' }
	| { kind: 'hourly' }
	| { kind: 'daily'; time: string }
	| { kind: 'weekly'; day: Weekday; time: string }
	| { kind: 'interval'; minutes: number };

export interface JobStep {
	id: number;
	ordering: number;
	prompt: string;
	deep_research: boolean;
}

export interface JobStepInput {
	prompt: string;
	deep_research: boolean;
}

export interface JobSummary {
	id: number;
	name: string;
	description: string | null;
	working_dir: string;
	auto_approve_tools: boolean;
	schedule_kind: ScheduleKind;
	schedule_config: string | null;
	next_due_at: number | null;
	created_at: number;
	updated_at: number;
	step_count: number;
}

export interface JobWithSteps {
	id: number;
	name: string;
	description: string | null;
	working_dir: string;
	auto_approve_tools: boolean;
	schedule_kind: ScheduleKind;
	schedule_config: string | null;
	next_due_at: number | null;
	created_at: number;
	updated_at: number;
	steps: JobStep[];
}

export interface JobInput {
	name: string;
	description: string | null;
	working_dir: string;
	auto_approve_tools: boolean;
	schedule_kind: ScheduleKind;
	schedule_config: string | null;
}

export function scheduleToConfigJson(schedule: Schedule): string | null {
	switch (schedule.kind) {
		case 'manual':
		case 'hourly':
			return null;
		case 'daily':
			return JSON.stringify({ time: schedule.time });
		case 'weekly':
			return JSON.stringify({ day: schedule.day, time: schedule.time });
		case 'interval':
			return JSON.stringify({ minutes: schedule.minutes });
	}
}

export function configJsonToSchedule(
	kind: ScheduleKind,
	configJson: string | null
): Schedule | null {
	if (kind === 'manual') return { kind: 'manual' };
	if (kind === 'hourly') return { kind: 'hourly' };
	if (!configJson) return null;
	try {
		const parsed = JSON.parse(configJson);
		if (kind === 'daily' && typeof parsed.time === 'string') {
			return { kind: 'daily', time: parsed.time };
		}
		if (kind === 'weekly' && typeof parsed.day === 'string' && typeof parsed.time === 'string') {
			return { kind: 'weekly', day: parsed.day as Weekday, time: parsed.time };
		}
		if (kind === 'interval' && typeof parsed.minutes === 'number') {
			return { kind: 'interval', minutes: parsed.minutes };
		}
	} catch {
		// fall through
	}
	return null;
}

let jobs = $state<JobSummary[]>([]);
let loaded = $state(false);

export function getJobs(): JobSummary[] {
	return jobs;
}

export function isJobsLoaded(): boolean {
	return loaded;
}

export async function loadJobs(): Promise<void> {
	try {
		jobs = await invoke<JobSummary[]>('db_list_jobs');
		loaded = true;
	} catch (e) {
		logDebug('jobs', 'loadJobs failed', { error: String(e) });
		jobs = [];
		loaded = true;
	}
}

export async function createJob(input: JobInput): Promise<number | null> {
	try {
		const id = await invoke<number>('db_create_job', { input });
		await loadJobs();
		return id;
	} catch (e) {
		logDebug('jobs', 'createJob failed', { error: String(e) });
		return null;
	}
}

export async function updateJob(id: number, input: JobInput): Promise<boolean> {
	try {
		await invoke('db_update_job', { id, input });
		await loadJobs();
		return true;
	} catch (e) {
		logDebug('jobs', 'updateJob failed', { id, error: String(e) });
		return false;
	}
}

export async function deleteJob(id: number): Promise<boolean> {
	try {
		await invoke('db_delete_job', { id });
		await loadJobs();
		return true;
	} catch (e) {
		logDebug('jobs', 'deleteJob failed', { id, error: String(e) });
		return false;
	}
}

export async function getJob(id: number): Promise<JobWithSteps | null> {
	try {
		return await invoke<JobWithSteps>('db_get_job', { id });
	} catch (e) {
		logDebug('jobs', 'getJob failed', { id, error: String(e) });
		return null;
	}
}

export async function replaceJobSteps(jobId: number, steps: JobStepInput[]): Promise<boolean> {
	try {
		await invoke('db_replace_job_steps', { jobId, steps });
		return true;
	} catch (e) {
		logDebug('jobs', 'replaceJobSteps failed', { jobId, error: String(e) });
		return false;
	}
}
