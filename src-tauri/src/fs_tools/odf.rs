//! Shared OpenDocument Format (ODF) zip scaffolding for the .odt / .odp /
//! .ods writers. Only the byte-identical pieces live here — the per-format
//! manifest entries, styles, and body are assembled by each builder.

use zip::write::SimpleFileOptions;

/// The `meta.xml` body every ODF document ships — minimal metadata naming
/// Haruspex as the generator. Byte-identical across odt/odp/ods.
pub(super) const ODF_META_XML: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
<office:meta><meta:generator>Haruspex</meta:generator></office:meta>
</office:document-meta>"#;

/// The two compression options every ODF writer uses: `Stored` for the
/// leading `mimetype` entry (ODF requires it uncompressed) and `Deflated`
/// for everything else.
pub(super) fn odf_options() -> (SimpleFileOptions, SimpleFileOptions) {
    (
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
}
