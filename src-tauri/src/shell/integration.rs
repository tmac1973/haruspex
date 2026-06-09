// OSC 133 marker parser + output ring for the Shell tab.
//
// The shell-integration scripts emit:
//   - ESC ] 133 ; A BEL         prompt start
//   - ESC ] 133 ; B BEL         prompt end (command-line start)
//   - ESC ] 133 ; C BEL         command output start
//   - ESC ] 133 ; D ; <code> BEL command end + exit code
//   - ESC ] 7 ; file://host/path BEL  cwd update
//
// We treat BEL (0x07) and ESC \ as String Terminator (ST).
//
// For each chunk of PTY output we (a) forward it to the frontend
// unchanged and (b) feed it to this parser. The parser keeps a bounded
// ring of recent output bytes (for retrieving command output later) and
// a ring of recently observed markers (their position within the output
// ring's absolute byte offset).

use std::collections::VecDeque;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;

pub const DEFAULT_OUTPUT_CAPACITY: usize = 1 << 20; // 1 MiB
pub const DEFAULT_MARKER_CAPACITY: usize = 256;
const MAX_OSC_PAYLOAD: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerKind {
    PromptStart,  // A
    CommandStart, // B
    OutputStart,  // C
    OutputEnd,    // D
}

#[derive(Debug, Clone)]
pub struct Marker {
    pub kind: MarkerKind,
    /// Absolute offset of the ESC that started the OSC sequence.
    pub seq_start: u64,
    /// Absolute offset of the byte after ST.
    pub seq_end: u64,
    pub exit_code: Option<i32>,
    pub cwd: Option<String>,
    /// For `C` markers, the command line as bash/zsh reported it via
    /// the `cl=<base64>` attribute. Only set when the shell hook is
    /// new enough to emit it; otherwise capture falls back to slicing
    /// the bytes the terminal echoed between B and C.
    pub command_line: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRegion {
    pub command_line: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub cwd: Option<String>,
    /// True if either range fell off the end of the output ring.
    pub truncated: bool,
    /// True for an in-flight command: a `C` (output start) with no `D`
    /// (output end) yet — i.e. the command is still running. `exit_code`
    /// is None and `output` holds whatever has been emitted so far.
    pub pending: bool,
}

enum ParserState {
    Normal,
    EscSeen { seq_start: u64 },
    OscPayload { seq_start: u64, buf: Vec<u8> },
    OscEsc { seq_start: u64, buf: Vec<u8> },
}

pub struct Integration {
    /// Ring of recent output bytes (everything that passed through the
    /// reader thread, OSC sequences included).
    output: VecDeque<u8>,
    output_capacity: usize,
    /// Absolute offset of the first byte currently in `output`.
    output_first_offset: u64,
    /// Total bytes ingested over the session's lifetime.
    total_offset: u64,
    /// Ring of markers, oldest first.
    markers: VecDeque<Marker>,
    marker_capacity: usize,
    /// Monotonic count of D (OutputEnd) markers seen over the session's whole
    /// lifetime — i.e. completed commands. Unlike `markers.len()` this never
    /// caps when the ring saturates, so callers can detect "a new command
    /// finished" by waiting for it to increase (used by the Run auto-submit).
    output_end_total: u64,
    /// Most recent cwd announced via OSC 7.
    current_cwd: Option<String>,
    state: ParserState,
}

impl Integration {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_OUTPUT_CAPACITY, DEFAULT_MARKER_CAPACITY)
    }

    pub fn with_capacity(output_capacity: usize, marker_capacity: usize) -> Self {
        Self {
            output: VecDeque::with_capacity(output_capacity),
            output_capacity,
            output_first_offset: 0,
            total_offset: 0,
            markers: VecDeque::with_capacity(marker_capacity),
            marker_capacity,
            output_end_total: 0,
            current_cwd: None,
            state: ParserState::Normal,
        }
    }

    pub fn current_cwd(&self) -> Option<&str> {
        self.current_cwd.as_deref()
    }

    pub fn ingest(&mut self, chunk: &[u8]) {
        for (i, &b) in chunk.iter().enumerate() {
            self.feed(b, self.total_offset + i as u64);
        }
        self.append_output(chunk);
        self.total_offset += chunk.len() as u64;
    }

    fn append_output(&mut self, chunk: &[u8]) {
        for &b in chunk {
            if self.output.len() == self.output_capacity {
                self.output.pop_front();
                self.output_first_offset += 1;
            }
            self.output.push_back(b);
        }
    }

    fn feed(&mut self, b: u8, abs_offset: u64) {
        match &mut self.state {
            ParserState::Normal => {
                if b == 0x1B {
                    self.state = ParserState::EscSeen {
                        seq_start: abs_offset,
                    };
                }
            }
            ParserState::EscSeen { seq_start } => {
                let seq_start = *seq_start;
                if b == b']' {
                    self.state = ParserState::OscPayload {
                        seq_start,
                        buf: Vec::with_capacity(32),
                    };
                } else {
                    self.state = ParserState::Normal;
                }
            }
            ParserState::OscPayload { seq_start, buf } => {
                let seq_start_v = *seq_start;
                if b == 0x07 {
                    let payload = std::mem::take(buf);
                    self.handle_osc(&payload, seq_start_v, abs_offset + 1);
                    self.state = ParserState::Normal;
                } else if b == 0x1B {
                    let payload = std::mem::take(buf);
                    self.state = ParserState::OscEsc {
                        seq_start: seq_start_v,
                        buf: payload,
                    };
                } else if buf.len() < MAX_OSC_PAYLOAD {
                    buf.push(b);
                } else {
                    // Overflow — abandon this sequence.
                    self.state = ParserState::Normal;
                }
            }
            ParserState::OscEsc { seq_start, buf } => {
                let seq_start_v = *seq_start;
                if b == b'\\' {
                    let payload = std::mem::take(buf);
                    self.handle_osc(&payload, seq_start_v, abs_offset + 1);
                    self.state = ParserState::Normal;
                } else {
                    // The ESC inside the OSC payload wasn't a real ST.
                    // Treat as abandoned to keep the parser simple.
                    self.state = ParserState::Normal;
                }
            }
        }
    }

    fn handle_osc(&mut self, payload: &[u8], seq_start: u64, seq_end: u64) {
        let Ok(s) = std::str::from_utf8(payload) else {
            return;
        };
        let mut iter = s.splitn(2, ';');
        let code = iter.next().unwrap_or("");
        let rest = iter.next().unwrap_or("");
        match code {
            "133" => self.handle_133(rest, seq_start, seq_end),
            "7" => self.handle_7(rest),
            _ => {}
        }
    }

    fn handle_133(&mut self, rest: &str, seq_start: u64, seq_end: u64) {
        let mut parts = rest.splitn(2, ';');
        let kind_str = parts.next().unwrap_or("");
        let data = parts.next().unwrap_or("");
        let kind = match kind_str {
            "A" => MarkerKind::PromptStart,
            "B" => MarkerKind::CommandStart,
            "C" => MarkerKind::OutputStart,
            "D" => MarkerKind::OutputEnd,
            _ => return,
        };
        let exit_code = if matches!(kind, MarkerKind::OutputEnd) {
            // D payload is just the exit code (no `;` further).
            data.parse::<i32>().ok()
        } else {
            None
        };
        let command_line = if matches!(kind, MarkerKind::OutputStart) {
            decode_cl_attribute(data)
        } else {
            None
        };
        self.push_marker(Marker {
            kind,
            seq_start,
            seq_end,
            exit_code,
            cwd: self.current_cwd.clone(),
            command_line,
        });
    }

    fn handle_7(&mut self, rest: &str) {
        // rest looks like "file://hostname/path/to/dir"
        let Some(after_scheme) = rest.strip_prefix("file://") else {
            return;
        };
        if let Some(slash) = after_scheme.find('/') {
            self.current_cwd = Some(after_scheme[slash..].to_string());
        }
    }

    fn push_marker(&mut self, marker: Marker) {
        if marker.kind == MarkerKind::OutputEnd {
            self.output_end_total = self.output_end_total.saturating_add(1);
        }
        if self.markers.len() == self.marker_capacity {
            self.markers.pop_front();
        }
        self.markers.push_back(marker);
    }

    /// Monotonic count of completed commands (D markers) over the session's
    /// lifetime. Never resets or caps — see the field comment.
    pub fn output_end_total(&self) -> u64 {
        self.output_end_total
    }

    #[allow(dead_code)] // Used by tests + future debug overlay
    pub fn markers(&self) -> impl Iterator<Item = &Marker> {
        self.markers.iter()
    }

    /// How many fully completed B→C→D cycles we could currently capture
    /// if `capture_recent_commands(usize::MAX)` were called. This is the
    /// "number of completed commands the auto-attach has to work with" —
    /// distinct from the raw marker count, which also includes A+B
    /// pairs from prompt redraws that never followed a command.
    pub fn completed_command_count(&self) -> usize {
        // Walk D markers backwards, count one for each that has a
        // matching C and B before it in the ring.
        let markers: Vec<&Marker> = self.markers.iter().collect();
        let mut count = 0;
        let mut search_end = markers.len();
        while let Some(d_offset) = markers[..search_end]
            .iter()
            .rposition(|m| m.kind == MarkerKind::OutputEnd)
        {
            let Some(c_offset) = markers[..d_offset]
                .iter()
                .rposition(|m| m.kind == MarkerKind::OutputStart)
            else {
                break;
            };
            let Some(b_offset) = markers[..c_offset]
                .iter()
                .rposition(|m| m.kind == MarkerKind::CommandStart)
            else {
                break;
            };
            count += 1;
            search_end = b_offset;
        }
        count
    }

    /// Returns bytes in [start, end) sliced from the output ring, or
    /// None if the requested range fell off the front.
    fn slice_output(&self, start: u64, end: u64) -> Option<Vec<u8>> {
        if start < self.output_first_offset {
            return None;
        }
        if end < start {
            return None;
        }
        let from = (start - self.output_first_offset) as usize;
        let to = (end - self.output_first_offset) as usize;
        if to > self.output.len() {
            return None;
        }
        // VecDeque has two slices; concat the relevant portions.
        let (a, b) = self.output.as_slices();
        let mut out = Vec::with_capacity(to - from);
        if from < a.len() {
            let a_end = to.min(a.len());
            out.extend_from_slice(&a[from..a_end]);
            if to > a.len() {
                let b_to = to - a.len();
                out.extend_from_slice(&b[..b_to]);
            }
        } else {
            let from_in_b = from - a.len();
            let to_in_b = to - a.len();
            out.extend_from_slice(&b[from_in_b..to_in_b]);
        }
        Some(out)
    }

    /// Find the most recent completed command cycle in the marker ring.
    pub fn capture_last_command(&self) -> Option<CapturedRegion> {
        self.capture_recent_commands(1).into_iter().next_back()
    }

    /// Walk the marker ring backwards collecting up to `limit` complete
    /// B → C → D cycles. Returns them in chronological order (oldest
    /// first) so the caller can render them as a transcript without
    /// reversing.
    /// Resolve a command's text from its `B` (CommandStart) and `C`
    /// (OutputStart) markers. Prefer the command line the shell hook reported
    /// via `cl=` on the `C` marker — it's the exact text bash/zsh executed and
    /// isn't subject to terminal-echo distortion (backspace, history
    /// navigation, inline autosuggestions). Fall back to slicing the byte
    /// stream between `B` and `C` for older hook versions or other
    /// integrations. Returns `(command_line, truncated)`.
    fn resolve_command_line(&self, b: &Marker, c: &Marker) -> (String, bool) {
        if let Some(cl) = c.command_line.as_ref() {
            (cl.clone(), false)
        } else {
            let cmd_bytes = self.slice_output(b.seq_end, c.seq_start);
            let truncated = cmd_bytes.is_none();
            (
                bytes_to_clean_text(cmd_bytes.as_deref().unwrap_or(&[])),
                truncated,
            )
        }
    }

    pub fn capture_recent_commands(&self, limit: usize) -> Vec<CapturedRegion> {
        if limit == 0 {
            return Vec::new();
        }
        let markers: Vec<&Marker> = self.markers.iter().collect();
        let mut regions: Vec<CapturedRegion> = Vec::new();
        let mut search_end = markers.len();
        while regions.len() < limit {
            let Some(d_offset) = markers[..search_end]
                .iter()
                .rposition(|m| m.kind == MarkerKind::OutputEnd)
            else {
                break;
            };
            let d = markers[d_offset];
            let Some(c_offset) = markers[..d_offset]
                .iter()
                .rposition(|m| m.kind == MarkerKind::OutputStart)
            else {
                break;
            };
            let c = markers[c_offset];
            let Some(b_offset) = markers[..c_offset]
                .iter()
                .rposition(|m| m.kind == MarkerKind::CommandStart)
            else {
                break;
            };
            let b = markers[b_offset];

            let out_bytes = self.slice_output(c.seq_end, d.seq_start);
            let (command_line, cmd_truncated) = self.resolve_command_line(b, c);
            let truncated = cmd_truncated || out_bytes.is_none();

            regions.push(CapturedRegion {
                command_line,
                output: bytes_to_clean_text(out_bytes.as_deref().unwrap_or(&[])),
                exit_code: d.exit_code,
                cwd: d
                    .cwd
                    .clone()
                    .or_else(|| c.cwd.clone())
                    .or_else(|| b.cwd.clone()),
                truncated,
                pending: false,
            });

            search_end = b_offset;
        }
        regions.reverse();
        regions
    }

    /// Like `capture_recent_commands`, but if a command is currently
    /// in flight (a `C` marker with no matching `D` yet — the user ran
    /// something that hasn't returned to the prompt), append it as a
    /// `pending` region holding the output emitted so far. This lets the
    /// auto-attach include the command the user just kicked off, instead
    /// of waiting for the next prompt to draw (which is what emits `D`).
    pub fn capture_recent_commands_with_pending(&self, limit: usize) -> Vec<CapturedRegion> {
        let mut regions = self.capture_recent_commands(limit);
        if let Some(pending) = self.pending_command() {
            regions.push(pending);
        }
        regions
    }

    /// The in-flight command, if any: the most recent `C` that has no `D`
    /// after it (and a `B` before it). Output runs from the `C` to the
    /// current end of the stream; exit code is unknown. Returns None when
    /// the shell is sitting idle at a prompt (the trailing marker is a
    /// `B`, not a `C`).
    fn pending_command(&self) -> Option<CapturedRegion> {
        let markers: Vec<&Marker> = self.markers.iter().collect();
        let c_offset = markers
            .iter()
            .rposition(|m| m.kind == MarkerKind::OutputStart)?;
        // If any D follows this C, the command already completed — not pending.
        if markers[c_offset + 1..]
            .iter()
            .any(|m| m.kind == MarkerKind::OutputEnd)
        {
            return None;
        }
        let c = markers[c_offset];
        let b_offset = markers[..c_offset]
            .iter()
            .rposition(|m| m.kind == MarkerKind::CommandStart)?;
        let b = markers[b_offset];

        let out_bytes = self.slice_output(c.seq_end, self.total_offset);
        let (command_line, cmd_truncated) = self.resolve_command_line(b, c);
        Some(CapturedRegion {
            command_line,
            output: bytes_to_clean_text(out_bytes.as_deref().unwrap_or(&[])),
            exit_code: None,
            cwd: c.cwd.clone().or_else(|| b.cwd.clone()),
            truncated: cmd_truncated || out_bytes.is_none(),
            pending: true,
        })
    }
}

impl Default for Integration {
    fn default() -> Self {
        Self::new()
    }
}

/// Lossy UTF-8 decode + ANSI/OSC strip. Keeps printable text, newlines,
/// and tabs; drops control bytes that would clutter the LLM's view.
fn bytes_to_clean_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    strip_ansi(&text)
}

/// Parse a `133;C` payload that may carry a `cl=<base64>` attribute
/// (other attributes separated by `;` are ignored). Returns the decoded
/// UTF-8 command line, or None when no `cl=` is present or decoding
/// fails.
fn decode_cl_attribute(data: &str) -> Option<String> {
    for attr in data.split(';') {
        if let Some(b64) = attr.strip_prefix("cl=") {
            let bytes = BASE64.decode(b64).ok()?;
            return Some(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    None
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1B' {
            // CSI: ESC [ ... letter
            // OSC: ESC ] ... BEL or ESC \
            // Two-char ESC sequences: ESC X (where X is most other chars)
            match chars.next() {
                Some('[') => {
                    for nc in chars.by_ref() {
                        if nc.is_ascii_alphabetic() || nc == '~' {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // skip until BEL or ESC \
                    while let Some(nc) = chars.next() {
                        if nc == '\x07' {
                            break;
                        }
                        if nc == '\x1B' {
                            // expect '\\'
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    // single-char ESC sequence, already consumed
                }
                None => break,
            }
        } else if c == '\r' {
            // Common in PTY output as part of CRLF; collapse it so
            // the LLM doesn't see literal carriage returns.
            // We keep the next \n if present.
            continue;
        } else if c.is_control() && c != '\n' && c != '\t' {
            // drop other control bytes (BEL, backspace, etc.)
            continue;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker_kinds(integ: &Integration) -> Vec<MarkerKind> {
        integ.markers().map(|m| m.kind).collect()
    }

    #[test]
    fn parses_133_a_b_c_d() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;A\x07");
        integ.ingest(b"prompt$ \x1B]133;B\x07ls\n\x1B]133;C\x07");
        integ.ingest(b"file1 file2\n\x1B]133;D;0\x07");
        assert_eq!(
            marker_kinds(&integ),
            vec![
                MarkerKind::PromptStart,
                MarkerKind::CommandStart,
                MarkerKind::OutputStart,
                MarkerKind::OutputEnd,
            ]
        );
        let captured = integ.capture_last_command().expect("region");
        assert_eq!(captured.command_line, "ls\n");
        assert_eq!(captured.output, "file1 file2\n");
        assert_eq!(captured.exit_code, Some(0));
        assert!(!captured.truncated);
    }

    #[test]
    fn output_end_total_is_monotonic_past_marker_cap() {
        // Small ring so the cap is easy to exceed; output_end_total must keep
        // climbing even after markers.len() saturates (the Run auto-submit
        // relies on this to detect command completion on long-lived shells).
        let mut integ = Integration::with_capacity(DEFAULT_OUTPUT_CAPACITY, 8);
        for _ in 0..50 {
            integ.ingest(b"\x1B]133;B\x07cmd\n\x1B]133;C\x07out\n\x1B]133;D;0\x07");
        }
        assert_eq!(integ.output_end_total(), 50);
        // The marker ring itself is capped...
        assert!(integ.markers().count() <= 8);
    }

    #[test]
    fn handles_st_via_esc_backslash() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;A\x1B\\");
        assert_eq!(marker_kinds(&integ), vec![MarkerKind::PromptStart]);
    }

    #[test]
    fn osc_7_updates_cwd() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]7;file://myhost/home/me\x07");
        assert_eq!(integ.current_cwd(), Some("/home/me"));
        integ.ingest(b"\x1B]133;A\x07");
        let m = integ.markers().next().unwrap();
        assert_eq!(m.cwd.as_deref(), Some("/home/me"));
    }

    #[test]
    fn captures_exit_code() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;B\x07false\n\x1B]133;C\x07\x1B]133;D;1\x07");
        let cap = integ.capture_last_command().expect("region");
        assert_eq!(cap.exit_code, Some(1));
    }

    #[test]
    fn split_across_chunks() {
        let mut integ = Integration::new();
        // Split mid-sequence on purpose.
        integ.ingest(b"\x1B]13");
        integ.ingest(b"3;A\x07");
        assert_eq!(marker_kinds(&integ), vec![MarkerKind::PromptStart]);
    }

    #[test]
    fn ignores_unknown_osc_codes() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]0;some title\x07\x1B]133;A\x07");
        assert_eq!(marker_kinds(&integ), vec![MarkerKind::PromptStart]);
    }

    #[test]
    fn captures_returns_none_until_full_cycle() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;A\x07prompt$ \x1B]133;B\x07ls\n\x1B]133;C\x07output\n");
        assert!(integ.capture_last_command().is_none());
        integ.ingest(b"\x1B]133;D;0\x07");
        assert!(integ.capture_last_command().is_some());
    }

    #[test]
    fn strips_ansi_color_codes_from_output() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;B\x07ls\n\x1B]133;C\x07\x1B[31mred\x1B[0m\n\x1B]133;D;0\x07");
        let cap = integ.capture_last_command().unwrap();
        assert_eq!(cap.output, "red\n");
    }

    #[test]
    fn truncates_when_output_falls_off_ring() {
        // Tiny ring forces eviction.
        let mut integ = Integration::with_capacity(64, 64);
        integ.ingest(b"\x1B]133;B\x07ls\n\x1B]133;C\x07");
        // Spam enough bytes to evict the C marker's start.
        for _ in 0..10 {
            integ.ingest(&[b'X'; 32]);
        }
        integ.ingest(b"\x1B]133;D;0\x07");
        let cap = integ.capture_last_command().unwrap();
        assert!(cap.truncated);
    }

    #[test]
    fn overflowing_payload_is_abandoned() {
        let mut integ = Integration::new();
        let mut payload = b"\x1B]133;A".to_vec();
        // Way past MAX_OSC_PAYLOAD with no terminator.
        payload.extend(std::iter::repeat(b'X').take(MAX_OSC_PAYLOAD + 100));
        integ.ingest(&payload);
        // Now send a real marker.
        integ.ingest(b"\x1B]133;B\x07");
        // Only the second one should land.
        assert_eq!(marker_kinds(&integ), vec![MarkerKind::CommandStart]);
    }

    #[test]
    fn collapses_carriage_returns_in_captured_output() {
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;B\x07cmd\n\x1B]133;C\x07line1\r\nline2\r\n\x1B]133;D;0\x07");
        let cap = integ.capture_last_command().unwrap();
        assert_eq!(cap.output, "line1\nline2\n");
    }

    fn run_cycle(integ: &mut Integration, cmd: &str, out: &str, exit: u8) {
        integ.ingest(b"\x1B]133;A\x07prompt$ \x1B]133;B\x07");
        integ.ingest(cmd.as_bytes());
        integ.ingest(b"\n\x1B]133;C\x07");
        integ.ingest(out.as_bytes());
        integ.ingest(format!("\x1B]133;D;{}\x07", exit).as_bytes());
    }

    #[test]
    fn capture_recent_commands_returns_oldest_first() {
        let mut integ = Integration::new();
        run_cycle(&mut integ, "ls", "a b c\n", 0);
        run_cycle(&mut integ, "echo hi", "hi\n", 0);
        run_cycle(&mut integ, "false", "", 1);

        let three = integ.capture_recent_commands(3);
        assert_eq!(three.len(), 3);
        assert_eq!(three[0].command_line.trim(), "ls");
        assert_eq!(three[1].command_line.trim(), "echo hi");
        assert_eq!(three[2].command_line.trim(), "false");
        assert_eq!(three[2].exit_code, Some(1));
    }

    #[test]
    fn capture_recent_commands_caps_at_limit() {
        let mut integ = Integration::new();
        for i in 0..5 {
            run_cycle(&mut integ, &format!("cmd{}", i), "ok\n", 0);
        }
        let two = integ.capture_recent_commands(2);
        assert_eq!(two.len(), 2);
        // Most recent two should be cmd3 and cmd4 in chronological order.
        assert_eq!(two[0].command_line.trim(), "cmd3");
        assert_eq!(two[1].command_line.trim(), "cmd4");
    }

    #[test]
    fn pending_command_captured_while_running() {
        // A C with no D yet — the user kicked off a command that hasn't
        // returned to the prompt.
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;A\x07$ \x1B]133;B\x07");
        integ.ingest(b"sleep 5\n\x1B]133;C;cl=c2xlZXAgNQ==\x07partial output\n");
        // completed-only capture sees nothing
        assert!(integ.capture_recent_commands(5).is_empty());
        // with-pending sees the in-flight command
        let with_pending = integ.capture_recent_commands_with_pending(5);
        assert_eq!(with_pending.len(), 1);
        let p = &with_pending[0];
        assert_eq!(p.command_line, "sleep 5");
        assert_eq!(p.output, "partial output\n");
        assert_eq!(p.exit_code, None);
        assert!(p.pending);
    }

    #[test]
    fn pending_appended_after_completed_commands() {
        let mut integ = Integration::new();
        run_cycle(&mut integ, "ls", "a b\n", 0);
        // now a running command
        integ.ingest(b"\x1B]133;A\x07$ \x1B]133;B\x07top\n\x1B]133;C\x07loading\n");
        let regions = integ.capture_recent_commands_with_pending(5);
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].command_line.trim(), "ls");
        assert!(!regions[0].pending);
        assert_eq!(regions[1].command_line.trim(), "top");
        assert!(regions[1].pending);
    }

    #[test]
    fn no_pending_when_idle_at_prompt() {
        // Trailing marker is B (prompt drawn, nothing running).
        let mut integ = Integration::new();
        run_cycle(&mut integ, "ls", "a\n", 0);
        integ.ingest(b"\x1B]133;A\x07$ \x1B]133;B\x07");
        let regions = integ.capture_recent_commands_with_pending(5);
        assert_eq!(regions.len(), 1);
        assert!(!regions[0].pending);
    }

    #[test]
    fn capture_recent_commands_zero_limit_is_empty() {
        let mut integ = Integration::new();
        run_cycle(&mut integ, "ls", "a\n", 0);
        assert!(integ.capture_recent_commands(0).is_empty());
    }

    #[test]
    fn c_marker_cl_attribute_overrides_byte_slice() {
        // Simulates the new bash hook: the user typed `cd plate` then
        // backspaced "te" then typed "nets" — the terminal echo bytes
        // contain stray characters, but the cl= attribute carries the
        // actual command bash executed.
        let mut integ = Integration::new();
        let cmd_b64 = BASE64.encode("cd planets");
        let payload = format!(
            "\x1B]133;A\x07$ \x1B]133;B\x07cd plate\x08 \x08\x08 \x08nets\n\x1B]133;C;cl={}\x07\x1B]133;D;0\x07",
            cmd_b64
        );
        integ.ingest(payload.as_bytes());
        let cap = integ.capture_last_command().unwrap();
        assert_eq!(cap.command_line, "cd planets");
        assert!(!cap.truncated);
    }

    #[test]
    fn c_marker_without_cl_attribute_falls_back_to_byte_slice() {
        // Older hook versions / non-bash integrations emit plain
        // 133;C with no attributes. Capture should still work.
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]133;A\x07$ \x1B]133;B\x07echo hi\n\x1B]133;C\x07hi\n\x1B]133;D;0\x07");
        let cap = integ.capture_last_command().unwrap();
        assert_eq!(cap.command_line.trim(), "echo hi");
    }

    #[test]
    fn d_marker_pairs_with_post_command_cwd() {
        // Hook ordering: OSC 7 fires before D, so D should be stamped
        // with the new cwd, not the previous one.
        let mut integ = Integration::new();
        integ.ingest(b"\x1B]7;file://localhost/home/tim\x07");
        integ.ingest(b"\x1B]133;A\x07$ \x1B]133;B\x07cd projects\n\x1B]133;C\x07");
        // emit cwd then D, matching the new precmd ordering
        integ.ingest(b"\x1B]7;file://localhost/home/tim/projects\x07\x1B]133;D;0\x07");
        let cap = integ.capture_last_command().unwrap();
        assert_eq!(cap.cwd.as_deref(), Some("/home/tim/projects"));
    }
}
