//! Test-only helpers shared across the fs_tools format tests (docx / odt /
//! odp / pptx / xlsx). Reading entries out of a generated zip and asserting
//! the ODF stored-mimetype invariant were copy-pasted into two test modules;
//! they live here once.

use std::io::Read;

/// Open `bytes` as a zip and assert the ODF first-entry-stored-mimetype
/// invariants: (1) the first entry is named `mimetype`, (2) it uses Stored
/// (uncompressed) compression, (3) its contents equal `expected_mime`.
pub(crate) fn assert_odf_mimetype(bytes: &[u8], expected_mime: &str) {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
    let mut first = zip.by_index(0).expect("at least one entry");
    assert_eq!(first.name(), "mimetype", "first entry must be mimetype");
    assert_eq!(
        first.compression(),
        zip::CompressionMethod::Stored,
        "mimetype must be stored uncompressed"
    );
    let mut content = String::new();
    first.read_to_string(&mut content).unwrap();
    assert_eq!(content, expected_mime);
}

/// Read an entire zip entry as a UTF-8 string.
pub(crate) fn read_zip_entry(bytes: &[u8], name: &str) -> String {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
    let mut entry = zip
        .by_name(name)
        .unwrap_or_else(|_| panic!("{} missing", name));
    let mut content = String::new();
    entry.read_to_string(&mut content).unwrap();
    content
}

/// Read a zip entry's raw bytes (for verifying binary parts verbatim).
pub(crate) fn read_zip_entry_bytes(bytes: &[u8], name: &str) -> Vec<u8> {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
    let mut entry = zip
        .by_name(name)
        .unwrap_or_else(|_| panic!("{} missing", name));
    let mut out = Vec::new();
    entry.read_to_end(&mut out).unwrap();
    out
}
