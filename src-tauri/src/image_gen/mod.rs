//! Mechanical image normalization: the coherence layer that does not depend on
//! the model behaving.
//!
//! Reference conditioning gets a generation into the right neighbourhood and
//! can drift, weaken, or be unavailable entirely on a backend that cannot do
//! it. Palette and grid do not care. Forcing every asset through the same
//! sixteen colours and the same pixel grid is what actually makes forty
//! sprites look like one game — measured, not asserted: an IP-Adapter pass on
//! SD1.5 transfers palette and feel rather than fine rendering detail, so this
//! is the half that finishes the job.
//!
//! `profile.rs` holds every tunable the pipeline has, `palette.rs` the colour
//! work, `normalize.rs` the pass itself, `stats.rs` what it measured on the
//! way past, `checks.rs` the thresholds those measurements are judged
//! against, `sheet.rs` the contact sheet a run is reviewed through, and
//! `commands.rs` the thin Tauri wrappers.

pub mod checks;
pub mod commands;
pub mod normalize;
pub mod palette;
pub mod profile;
pub mod sheet;
pub mod stats;
