//! A Kdenlive project's main track as spans: see `video::timeline`.

use super::doc::Doc;
use crate::video::timeline::Span;
use std::path::Path;

/// The main track's items as spans, in order.
pub fn spans(doc: &Doc) -> Vec<Span> {
    let fps = doc.fps;
    doc.items()
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let e = item.any();
            let resource = doc
                .tree
                .by_id(&e.chain)
                .and_then(|c| doc.tree.property(c, "resource"))
                .unwrap_or("");
            let p = Path::new(resource);
            let file = if p.is_absolute() {
                p.to_path_buf()
            } else {
                Path::new(&doc.root_dir).join(p)
            };
            Span {
                index: i + 1,
                file,
                start: fps.secs(e.start),
                source_in: fps.secs(e.in_frame),
                source_out: fps.secs(e.out_frame + 1),
                audio: false,
            }
        })
        .collect()
}
