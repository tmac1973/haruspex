//! Spreadsheet read/write: XLSX (via rust_xlsxwriter) and ODS (hand-rolled
//! ODF zip). Both formats share the `XlsxSheet` wire shape — a name plus a
//! 2D Vec<Vec<String>> — because the Tauri command surface treats them as
//! interchangeable except for the output format.

use super::markdown_inline::escape_xml;
use super::path::{
    refuse_if_exists, resolve_in_workdir, stat_within_limit, workdir_path, write_bytes_to_workdir,
    MAX_DOC_READ_BYTES,
};

#[derive(serde::Deserialize)]
pub struct XlsxSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

/// Decide whether a cell string is numeric. The ODS and XLSX writers must
/// agree on this so a value lands as a number in one format and text in the
/// other — route both through this one classifier.
fn cell_as_number(cell: &str) -> Option<f64> {
    // "NaN"/"inf" parse as f64 but are not representable spreadsheet
    // numbers — emitting office:value="NaN" produces an invalid document.
    cell.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Build a minimal OpenDocument Spreadsheet (.ods) file from a slice of
/// sheets. Each `XlsxSheet` becomes a `<table:table>` with rows and cells.
/// Numeric strings are emitted as `office:value-type="float"` (same
/// number-vs-text detection as the xlsx writer); everything else is a
/// `string` cell. Same ODF first-entry-stored-mimetype requirement as
/// `build_odt`.
pub(super) fn build_ods(sheets: &[XlsxSheet]) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let (stored, deflated) = super::odf::odf_options();

        zip.start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.spreadsheet")
            .map_err(|e| e.to_string())?;

        zip.start_file("META-INF/manifest.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>"#,
        )
        .map_err(|e| e.to_string())?;

        zip.start_file("meta.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(super::odf::ODF_META_XML)
            .map_err(|e| e.to_string())?;

        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.2">
<office:styles/>
</office:document-styles>"#,
        )
        .map_err(|e| e.to_string())?;

        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.2">
<office:body><office:spreadsheet>"#,
        );
        for sheet in sheets {
            let num_cols = sheet.rows.iter().map(|r| r.len()).max().unwrap_or(0).max(1);
            body_xml.push_str(&format!(
                r#"<table:table table:name="{}"><table:table-column table:number-columns-repeated="{}"/>"#,
                escape_xml(&sheet.name),
                num_cols
            ));
            for row in &sheet.rows {
                body_xml.push_str("<table:table-row>");
                for cell in row {
                    if let Some(n) = cell_as_number(cell) {
                        body_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="float" office:value="{}"><text:p>{}</text:p></table:table-cell>"#,
                            n,
                            escape_xml(cell)
                        ));
                    } else {
                        body_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="string"><text:p>{}</text:p></table:table-cell>"#,
                            escape_xml(cell)
                        ));
                    }
                }
                body_xml.push_str("</table:table-row>");
            }
            body_xml.push_str("</table:table>");
        }
        body_xml.push_str("</office:spreadsheet></office:body></office:document-content>");

        zip.start_file("content.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(body_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

#[tauri::command]
pub async fn fs_write_xlsx(
    workdir: String,
    rel_path: String,
    sheets: Vec<XlsxSheet>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if sheets.is_empty() {
        return Err("At least one sheet is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let resolved_str = resolved.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use rust_xlsxwriter::Workbook;

        let mut workbook = Workbook::new();
        for sheet_data in &sheets {
            let worksheet = workbook.add_worksheet();
            worksheet
                .set_name(&sheet_data.name)
                .map_err(|e| format!("Failed to set sheet name: {}", e))?;
            for (row_idx, row) in sheet_data.rows.iter().enumerate() {
                for (col_idx, cell) in row.iter().enumerate() {
                    if let Some(n) = cell_as_number(cell) {
                        worksheet
                            .write_number(row_idx as u32, col_idx as u16, n)
                            .map_err(|e| format!("Failed to write cell: {}", e))?;
                    } else {
                        worksheet
                            .write_string(row_idx as u32, col_idx as u16, cell)
                            .map_err(|e| format!("Failed to write cell: {}", e))?;
                    }
                }
            }
        }
        workbook
            .save(&resolved_str)
            .map_err(|e| format!("Failed to save xlsx: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("xlsx write task failed: {}", e))??;

    Ok(())
}

#[tauri::command]
pub async fn fs_write_ods(
    workdir: String,
    rel_path: String,
    sheets: Vec<XlsxSheet>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if sheets.is_empty() {
        return Err("At least one sheet is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let bytes =
        tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> { build_ods(&sheets) })
            .await
            .map_err(|e| format!("ods build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}

#[tauri::command]
pub async fn fs_read_xlsx(
    workdir: String,
    rel_path: String,
    sheet: Option<String>,
) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    stat_within_limit(&resolved, MAX_DOC_READ_BYTES, "xlsx").await?;

    let resolved_clone = resolved.clone();
    let sheet_name = sheet.clone();
    let csv = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use calamine::{open_workbook_auto, Data, Reader};

        let mut workbook = open_workbook_auto(&resolved_clone)
            .map_err(|e| format!("Failed to open xlsx: {}", e))?;

        let sheet_names = workbook.sheet_names().to_vec();
        if sheet_names.is_empty() {
            return Err("xlsx has no sheets".to_string());
        }

        let target_sheet = match sheet_name {
            Some(name) => {
                if !sheet_names.iter().any(|s| s == &name) {
                    return Err(format!(
                        "Sheet '{}' not found. Available sheets: {}",
                        name,
                        sheet_names.join(", ")
                    ));
                }
                name
            }
            None => sheet_names[0].clone(),
        };

        let range = workbook
            .worksheet_range(&target_sheet)
            .map_err(|e| format!("Failed to read sheet '{}': {}", target_sheet, e))?;

        let mut out = String::new();
        if sheet_names.len() > 1 {
            out.push_str(&format!("# Sheet: {}\n", target_sheet));
            out.push_str(&format!(
                "# Available sheets: {}\n\n",
                sheet_names.join(", ")
            ));
        }

        for row in range.rows() {
            let row_text: Vec<String> = row
                .iter()
                .map(|cell| match cell {
                    Data::Empty => String::new(),
                    Data::String(s) => {
                        if s.contains(',') || s.contains('"') || s.contains('\n') {
                            format!("\"{}\"", s.replace('"', "\"\""))
                        } else {
                            s.clone()
                        }
                    }
                    Data::Float(f) => f.to_string(),
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => b.to_string(),
                    Data::DateTime(dt) => dt.to_string(),
                    Data::DateTimeIso(s) => s.clone(),
                    Data::DurationIso(s) => s.clone(),
                    Data::Error(e) => format!("#ERR:{:?}", e),
                })
                .collect();
            out.push_str(&row_text.join(","));
            out.push('\n');
        }

        Ok(out)
    })
    .await
    .map_err(|e| format!("xlsx extraction task failed: {}", e))??;

    const MAX_XLSX_CHARS: usize = 500_000;
    if csv.len() > MAX_XLSX_CHARS {
        return Ok(format!(
            "{}\n\n[... truncated: {} characters total, showing first {}]",
            crate::text_util::truncate_at_char_boundary(&csv, MAX_XLSX_CHARS),
            csv.len(),
            MAX_XLSX_CHARS
        ));
    }

    Ok(csv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_tools::test_support::{assert_odf_mimetype, read_zip_entry};

    #[test]
    fn build_ods_produces_valid_odf_zip() {
        let sheets = vec![XlsxSheet {
            name: "Report".to_string(),
            rows: vec![
                vec!["Name".to_string(), "Count".to_string()],
                vec!["alpha".to_string(), "42".to_string()],
                vec!["beta".to_string(), "3.14".to_string()],
            ],
        }];
        let bytes = build_ods(&sheets).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.spreadsheet");

        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"table:name="Report""#));
        assert!(content.contains(r#"office:value-type="float""#));
        assert!(content.contains(r#"office:value="42""#));
        assert!(content.contains(r#"office:value="3.14""#));
        assert!(content.contains(r#"office:value-type="string""#));
        assert!(content.contains("<text:p>Name</text:p>"));
        assert!(content.contains("<text:p>alpha</text:p>"));
    }

    #[test]
    fn build_ods_handles_multiple_sheets_and_ragged_rows() {
        let sheets = vec![
            XlsxSheet {
                name: "A".to_string(),
                rows: vec![
                    vec!["x".to_string(), "y".to_string(), "z".to_string()],
                    vec!["1".to_string(), "2".to_string()],
                ],
            },
            XlsxSheet {
                name: "B".to_string(),
                rows: vec![vec!["only".to_string()]],
            },
        ];
        let bytes = build_ods(&sheets).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"table:name="A""#));
        assert!(content.contains(r#"table:name="B""#));
        assert!(content.contains(r#"table:number-columns-repeated="3""#));
        assert!(content.contains(r#"table:number-columns-repeated="1""#));
    }

    fn temp_workdir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_xlsx_test_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn fs_write_then_read_xlsx_round_trip() {
        let dir = temp_workdir("roundtrip");
        let wd = dir.to_string_lossy().to_string();
        let sheets = vec![XlsxSheet {
            name: "Data".to_string(),
            rows: vec![
                vec!["Name".to_string(), "Count".to_string()],
                vec!["alpha, beta".to_string(), "42".to_string()],
            ],
        }];
        fs_write_xlsx(wd.clone(), "t.xlsx".to_string(), sheets, None)
            .await
            .expect("write xlsx");
        let csv = fs_read_xlsx(wd, "t.xlsx".to_string(), None)
            .await
            .expect("read xlsx");
        assert!(csv.contains("Name,Count"));
        // Comma-bearing cell is CSV-quoted; "42" round-trips as a number.
        assert!(csv.contains("\"alpha, beta\",42"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn fs_read_xlsx_truncates_multibyte_content_on_char_boundary() {
        // MAX_XLSX_CHARS (500_000) is local to fs_read_xlsx.
        const MAX: usize = 500_000;
        // One 3-byte header row ("ab\n") shifts every following row to an
        // odd byte offset; rows of 2-byte chars then guarantee the even
        // truncation index lands mid-codepoint. A raw `&csv[..MAX]` slice
        // would panic here — the char-boundary backoff must kick in.
        let cell = "é".repeat(30_000); // 60_000 bytes per cell
        let mut rows = vec![vec!["ab".to_string()]];
        for _ in 0..9 {
            rows.push(vec![cell.clone()]);
        }
        // Reconstruct the CSV fs_read_xlsx will produce and verify the
        // premise: the cap index is NOT a char boundary.
        let mut expected_csv = String::from("ab\n");
        for _ in 0..9 {
            expected_csv.push_str(&cell);
            expected_csv.push('\n');
        }
        assert!(expected_csv.len() > MAX);
        assert!(
            !expected_csv.is_char_boundary(MAX),
            "fixture must straddle the cap with a multibyte char"
        );

        let dir = temp_workdir("truncate_multibyte");
        let wd = dir.to_string_lossy().to_string();
        let sheets = vec![XlsxSheet {
            name: "Big".to_string(),
            rows,
        }];
        fs_write_xlsx(wd.clone(), "big.xlsx".to_string(), sheets, None)
            .await
            .expect("write xlsx");
        let out = fs_read_xlsx(wd, "big.xlsx".to_string(), None)
            .await
            .expect("read xlsx must not panic on multibyte truncation");
        assert!(out.contains("[... truncated:"));
        assert!(out.starts_with("ab\n"));
        // Truncated body is capped at MAX bytes (minus the backed-off char).
        let body = out.split("\n\n[... truncated:").next().unwrap();
        assert!(body.len() <= MAX);
        assert!(body.len() >= MAX - 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
