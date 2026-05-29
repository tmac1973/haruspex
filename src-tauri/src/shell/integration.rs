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
            data.parse::<i32>().ok()
        } else {
            None
        };
        self.push_marker(Marker {
            kind,
            seq_start,
            seq_end,
            exit_code,
            cwd: self.current_cwd.clone(),
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
        if self.markers.len() == self.marker_capacity {
            self.markers.pop_front();
        }
        self.markers.push_back(marker);
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
        loop {
            let Some(d_offset) = markers[..search_end]
                .iter()
                .rposition(|m| m.kind == MarkerKind::OutputEnd)
            else {
                break;
            };
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

            let cmd_bytes = self.slice_output(b.seq_end, c.seq_start);
            let out_bytes = self.slice_output(c.seq_end, d.seq_start);
            let truncated = cmd_bytes.is_none() || out_bytes.is_none();

            regions.push(CapturedRegion {
                command_line: bytes_to_clean_text(cmd_bytes.as_deref().unwrap_or(&[])),
                output: bytes_to_clean_text(out_bytes.as_deref().unwrap_or(&[])),
                exit_code: d.exit_code,
                cwd: d
                    .cwd
                    .clone()
                    .or_else(|| c.cwd.clone())
                    .or_else(|| b.cwd.clone()),
                truncated,
            });

            search_end = b_offset;
        }
        regions.reverse();
        regions
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
    fn capture_recent_commands_zero_limit_is_empty() {
        let mut integ = Integration::new();
        run_cycle(&mut integ, "ls", "a\n", 0);
        assert!(integ.capture_recent_commands(0).is_empty());
    }
}
