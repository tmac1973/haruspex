//! A Shotcut project's main track as spans: see `video::timeline`.

use super::doc::Doc;
use crate::video::timeline::Span;
use std::path::Path;

/// The main track's clips as spans, in order, each with the stretch the
/// crossfades at its sides play.
pub fn spans(doc: &Doc) -> Vec<Span> {
    let fps = doc.fps;
    doc.items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let resource = doc.resource(&item.chain);
            let p = Path::new(&resource);
            let file = if p.is_absolute() {
                p.to_path_buf()
            } else {
                Path::new(&doc.root_dir).join(p)
            };
            Span {
                index: i + 1,
                file,
                start: fps.secs(item.start),
                source_in: fps.secs(item.in_frame),
                source_out: fps.secs(item.out_frame + 1),
                audio: false,
            }
        })
        .collect()
}
