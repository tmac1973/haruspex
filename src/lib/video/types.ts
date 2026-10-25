/** The format a new video project is made in (Settings → Video). */
export type VideoPreset = '1080p30' | '1080p60' | '1440p60' | '2160p30';

export const VIDEO_PRESETS: { id: VideoPreset; label: string }[] = [
	{ id: '1080p30', label: '1080p, 30 fps' },
	{ id: '1080p60', label: '1080p, 60 fps' },
	{ id: '1440p60', label: '1440p, 60 fps' },
	{ id: '2160p30', label: '4K, 30 fps' }
];
