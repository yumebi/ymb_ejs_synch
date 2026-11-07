//! ローカルのファイル操作。画面側(JS)からは、選択済みのルートフォルダの中の、相対パスでしか触れない。
//! Electron 版の `htmlSync.js` と `atomicWrite.js` の、入出力の部分に相当する。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 相対パス(`/` 区切り)を検証して、ルートの中のパスにする。
/// 空、絶対パス、`..`、ドライブ指定(`C:`)、`\` を含むものは、拒否する。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("パスが空です".into());
    }
    if rel.contains('\\') {
        return Err("パスに \\ は使えません".into());
    }
    let mut out = root.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err("ルートの外を指すパスは使えません".into()),
        }
    }
    if out == root {
        return Err("パスが空です".into());
    }
    Ok(out)
}

/// EJS のページ(`*.ejs`)を再帰的に列挙する。`module` という名前のもの(共通パーツ置き場)と、
/// `_` で始まるファイル(部分テンプレート)は、ページ単体としては対象外。
pub fn list_ejs(root: &Path, start_rel: &str) -> Vec<String> {
    let start = if start_rel.is_empty() {
        root.to_path_buf()
    } else {
        match resolve_in_root(root, start_rel) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        }
    };
    let mut out = Vec::new();
    if start.is_dir() {
        walk_ejs(&start, root, &mut out);
    }
    out.sort();
    out
}

fn walk_ejs(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "module" {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_ejs(&path, root, out);
        } else if ft.is_file() && name.ends_with(".ejs") && !name.starts_with('_') {
            push_rel(&path, root, out);
        }
    }
}

/// 公開 HTML のルートの下の `*.html`(大文字小文字は区別しない)を、再帰的に列挙する。
/// EJS 側と違って、除外のルールは無い(先頭が `.` のものも含む)。
pub fn list_html_all(root: &Path, start_rel: &str) -> Vec<String> {
    let start = if start_rel.is_empty() {
        root.to_path_buf()
    } else {
        match resolve_in_root(root, start_rel) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        }
    };
    let mut out = Vec::new();
    if start.is_dir() {
        walk_html_all(&start, root, &mut out);
    }
    out.sort();
    out
}

fn walk_html_all(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_html_all(&path, root, out);
        } else if ft.is_file() && name.to_lowercase().ends_with(".html") {
            push_rel(&path, root, out);
        }
    }
}

fn push_rel(path: &Path, root: &Path, out: &mut Vec<String>) {
    if let Ok(rel) = path.strip_prefix(root) {
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
        out.push(parts.join("/"));
    }
}

fn temp_path_for(file: &Path) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    file.with_file_name(format!(".{}.{}.{}.tmp", name, std::process::id(), nanos))
}

fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    // Windows では、ウイルス対策ソフトなどがファイルを一瞬つかんでいて、rename に失敗することがある。
    let mut attempt = 1u32;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retryable = matches!(e.kind(), std::io::ErrorKind::PermissionDenied);
                if !retryable || attempt >= 6 {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt as u64));
                attempt += 1;
            }
        }
    }
}

/// 同じフォルダの一時ファイルに書き込み、ディスクに反映してから、rename で置き換える。
/// 途中で落ちても、元のファイルは壊れない。失敗したときは、一時ファイルを消す。
pub fn atomic_write(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = temp_path_for(file);
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        rename_with_retry(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `.bak` が無いときだけ、上書き前の内容を `.bak` に残す(初回のバックアップを、守る)。
pub fn ensure_backup(file: &Path) -> std::io::Result<()> {
    let mut bak = file.as_os_str().to_os_string();
    bak.push(".bak");
    let bak = PathBuf::from(bak);
    if !bak.exists() {
        fs::copy(file, &bak)?;
    }
    Ok(())
}

pub fn backup_path(file: &Path) -> PathBuf {
    let mut bak = file.as_os_str().to_os_string();
    bak.push(".bak");
    PathBuf::from(bak)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escape_and_absolute() {
        let root = Path::new("/r");
        assert!(resolve_in_root(root, "a/b.html").is_ok());
        assert!(resolve_in_root(root, "./a.html").is_ok());
        assert!(resolve_in_root(root, "../a.html").is_err());
        assert!(resolve_in_root(root, "a/../../b.html").is_err());
        assert!(resolve_in_root(root, "/etc/passwd").is_err());
        assert!(resolve_in_root(root, "a\\b.html").is_err());
        assert!(resolve_in_root(root, "").is_err());
        assert!(resolve_in_root(root, ".").is_err());
    }

    #[test]
    fn list_ejs_skips_module_and_underscore_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("module")).unwrap();
        fs::create_dir_all(root.join("a/module")).unwrap();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("index.ejs"), "x").unwrap();
        fs::write(root.join("_part.ejs"), "x").unwrap();
        fs::write(root.join("module/_head.ejs"), "x").unwrap();
        fs::write(root.join("a/module/foot.ejs"), "x").unwrap();
        fs::write(root.join("a/b/page.ejs"), "x").unwrap();
        fs::write(root.join("a/readme.txt"), "x").unwrap();
        fs::write(root.join("a/Upper.EJS"), "x").unwrap();
        assert_eq!(list_ejs(root, ""), vec!["a/b/page.ejs", "index.ejs"]);
        assert_eq!(list_ejs(root, "a"), vec!["a/b/page.ejs"]);
        assert!(list_ejs(root, "../x").is_empty());
    }

    #[test]
    fn list_html_all_includes_dot_dirs_and_any_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("a.html"), "x").unwrap();
        fs::write(root.join("B.HTML"), "x").unwrap();
        fs::write(root.join(".hidden/c.html"), "x").unwrap();
        fs::write(root.join("d.txt"), "x").unwrap();
        assert_eq!(list_html_all(root, ""), vec![".hidden/c.html", "B.HTML", "a.html"]);
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("a.html");
        atomic_write(&file, "一回目".as_bytes()).unwrap();
        atomic_write(&file, "二回目".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "二回目");
        let names: Vec<String> = fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.html"]);
    }

    #[test]
    fn backup_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.html");
        fs::write(&file, "元の内容").unwrap();
        ensure_backup(&file).unwrap();
        fs::write(&file, "二回目の内容").unwrap();
        ensure_backup(&file).unwrap();
        assert_eq!(fs::read_to_string(backup_path(&file)).unwrap(), "元の内容");
    }
}
