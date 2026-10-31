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
	/** Every other table row, behind the text. */
	surface: string;
	/** Table borders and chart gridlines. */
	line: string;
	/** Chart series (or pie slices) in order; a chart with more reuses them. */
	series: string[];
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
		surface: 'F3F4F6',
		line: 'D1D5DB',
		series: ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6', '06B6D4', 'EC4899', '84CC16'],
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
		surface: '1F2937',
		line: '374151',
		series: ['38BDF8', 'FBBF24', '34D399', 'F87171', 'A78BFA', '22D3EE', 'F472B6', 'A3E635'],
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
		surface: 'F2F2F2',
		line: 'D4D4D4',
		series: ['E11D48', '111111', '6B7280', 'F59E0B', '0EA5E9', '10B981', '8B5CF6', 'F97316'],
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
		surface: 'F3EADF',
		line: 'E2D5C3',
		series: ['C2410C', '0F766E', 'CA8A04', '7C3AED', '65A30D', '9D174D', '475569', 'B45309'],
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
		surface: 'E6EEEC',
		line: 'C9D8D5',
		series: ['0F766E', '0EA5E9', '84CC16', 'F59E0B', '6366F1', 'DB2777', '14B8A6', '64748B'],
		headFont: 'Calibri',
		bodyFont: 'Calibri'
	}
};
