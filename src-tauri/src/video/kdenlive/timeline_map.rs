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
            let speed = doc.speed(&e.chain);
            let (src_in, src_out) =
                crate::video::mlt::warp::to_source(e.in_frame, e.out_frame, speed);
            let resource = doc.resource(&e.chain);
            let p = Path::new(&resource);
            let file = if p.is_absolute() {
                p.to_path_buf()
            } else {
                Path::new(&doc.root_dir).join(p)
            };
            Span {
                index: i + 1,
                file,
                start: fps.secs(e.start),
                source_in: fps.secs(src_in),
                source_out: fps.secs(src_out + 1),
                speed,
                audio: false,
            }
        })
        .collect()
}
