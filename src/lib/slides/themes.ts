/**
 * The looks a deck can take (`fs_write_slides`'s `theme`). Colours are hex
 * without the `#`, as PptxGenJS takes them. Fonts are ones PowerPoint ships
 * and LibreOffice maps to a metric-compatible twin (Calibri → Carlito,
 * Georgia → Gelasio), so a deck lays out the same in both.
 */

export const SLIDE_THEMES = ['light', 'dark', 'bold', 'warm', 'calm'] as const;

export type SlideTheme = (typeof SLIDE_THEMES)[number];

export interface Theme {
	/** A content slide's background. */
	background: string;
	text: string;
	/** Subtitles, attributions and slide numbers. */
	muted: string;
	/** The rule under a title, quote marks and big numbers. */
	accent: string;
	/** A cover slide's background, and the strip an image slide's title sits on. */
	band: string;
	bandText: string;
	headFont: string;
	bodyFont: string;
}

export const THEMES: Record<SlideTheme, Theme> = {
	light: {
		background: 'FFFFFF',
		text: '1F2937',
		muted: '6B7280',
		accent: '2563EB',
		band: '1E3A8A',
		bandText: 'FFFFFF',
		headFont: 'Calibri',
		bodyFont: 'Calibri'
	},
	dark: {
		background: '111827',
		text: 'F3F4F6',
		muted: '9CA3AF',
		accent: '38BDF8',
		band: '020617',
		bandText: 'F8FAFC',
		headFont: 'Calibri',
		bodyFont: 'Calibri'
	},
	bold: {
		background: 'FFFFFF',
		text: '111111',
		muted: '555555',
		accent: 'E11D48',
		band: '111111',
		bandText: 'FFFFFF',
		headFont: 'Arial',
		bodyFont: 'Arial'
	},
	warm: {
		background: 'FBF7F0',
		text: '3B2F2A',
		muted: '8A7B70',
		accent: 'C2410C',
		band: '7C2D12',
		bandText: 'FFF7ED',
		headFont: 'Georgia',
		bodyFont: 'Calibri'
	},
	calm: {
		background: 'F4F7F6',
		text: '1F3A3D',
		muted: '5F7A7C',
		accent: '0F766E',
		band: '134E4A',
		bandText: 'ECFDF5',
		headFont: 'Calibri',
		bodyFont: 'Calibri'
	}
};
