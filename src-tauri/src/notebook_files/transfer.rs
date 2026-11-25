//! Notebook export and import: writing an exported file where the Save
//! dialog chose, and reading a spreadsheet's sheets for import. Only paths
//! from those dialogs reach these.

use serde::Serialize;
use std::path::PathBuf;

/// The largest export written (a notebook with its files, zipped).
const MAX_EXPORT_BYTES: usize = 500 * 1_048_576;
/// Rows read from one sheet on import (a table holds 5,000).
const MAX_IMPORT_ROWS: usize = 5000;

/// One sheet of an imported spreadsheet: its name and its cells as text.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImportedSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

pub(crate) fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("No {name} was given."))?;
    urlencoding::decode(raw)
        .map(|s| s.into_owned())
        .map_err(|e| format!("{name} is not valid UTF-8: {e}"))
}

/// Write an export (the raw body) to `x-path`, the file the Save dialog
/// chose (which already asked about replacing one).
#[tauri::command]
pub async fn notebook_export_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The export must be sent as raw bytes.".into());
    };
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("The export is too large to write.".into());
    }
    let path = PathBuf::from(header(&request, "x-path")?);
    if !path.is_absolute() {
        return Err("Export needs a full path.".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, &bytes)
            .map_err(|e| format!("Could not write {}: {e}", path.display()))
    })
    .await
    .map_err(|e| format!("export task panicked: {e}"))?
}

/// The text of a Markdown or CSV file the Open dialog chose, for import.
#[tauri::command]
pub async fn notebook_import_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let size = std::fs::metadata(p)
            .map_err(|e| format!("Can't read {path}: {e}"))?
            .len();
        if size > 20 * 1_048_576 {
            return Err("That file is too large to import (over 20 MB).".into());
        }
        let bytes = std::fs::read(p).map_err(|e| format!("Can't read {path}: {e}"))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| format!("import task panicked: {e}"))?
}

/// Every sheet of a spreadsheet (.xlsx, .xls, .ods) as rows of text.
pub fn read_sheets(path: &std::path::Path) -> Result<Vec<ImportedSheet>, String> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut workbook =
        open_workbook_auto(path).map_err(|e| format!("Couldn't open the spreadsheet: {e}"))?;
    let mut sheets = Vec::new();
    for name in workbook.sheet_names().to_vec() {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue;
        };
        let rows: Vec<Vec<String>> = range
            .rows()
            .take(MAX_IMPORT_ROWS + 1)
            .map(|row| {
                row.iter()
                    .map(|cell| match cell {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => f.to_string(),
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(dt) => dt.to_string(),
                        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
                        Data::Error(e) => format!("#ERR:{e:?}"),
                    })
                    .collect()
            })
            .filter(|r: &Vec<String>| r.iter().any(|c| !c.is_empty()))
            .collect();
        if !rows.is_empty() {
            sheets.push(ImportedSheet { name, rows });
        }
    }
    Ok(sheets)
}

/// The sheets of a spreadsheet the Open dialog chose, for import.
#[tauri::command]
pub async fn notebook_import_xlsx(path: String) -> Result<Vec<ImportedSheet>, String> {
    tauri::async_runtime::spawn_blocking(move || read_sheets(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("import task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn reads_every_non_empty_sheet() {
        use rust_xlsxwriter::Workbook;
        let dir = temp_dir("nb-import-xlsx");
        let path = dir.join("book.xlsx");
        let mut wb = Workbook::new();
        let a = wb.add_worksheet().set_name("Prices").unwrap();
        a.write_string(0, 0, "Name").unwrap();
        a.write_string(0, 1, "Price").unwrap();
        a.write_string(1, 0, "JBL").unwrap();
        a.write_number(1, 1, 129.5).unwrap();
        wb.add_worksheet().set_name("Empty").unwrap();
        let c = wb.add_worksheet().set_name("Notes").unwrap();
        c.write_string(0, 0, "hello").unwrap();
        wb.save(&path).unwrap();

        let sheets = read_sheets(&path).unwrap();
        assert_eq!(
            sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["Prices", "Notes"]
        );
        assert_eq!(
            sheets[0].rows[1],
            vec!["JBL".to_string(), "129.5".to_string()]
        );
    }
}
