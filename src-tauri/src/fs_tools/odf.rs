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

/// The opening of an ODF `META-INF/manifest.xml`: the `<manifest:manifest>`
/// element plus the four fixed file-entries (root `/`, content.xml, styles.xml,
/// meta.xml). `root_mime` is the document's media type. Callers append any
/// image `file-entry` rows and the closing `</manifest:manifest>`.
pub(super) fn manifest_prologue(root_mime: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="{root_mime}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
"#
    )
}

/// The two compression options every ODF writer uses: `Stored` for the
/// leading `mimetype` entry (ODF requires it uncompressed) and `Deflated`
/// for everything else.
pub(super) fn odf_options() -> (SimpleFileOptions, SimpleFileOptions) {
    (
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
}
