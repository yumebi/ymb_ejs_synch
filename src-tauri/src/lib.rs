mod fsops;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, State};

/// 画面側(JS)が操作してよい、2 つのルートフォルダ。`set_roots` で決まり、
/// ファイル操作は、必ず、この中の相対パスで行う(ルートの外には、触れない)。
#[derive(Default)]
struct Roots {
    ejs: Option<PathBuf>,
    html: Option<PathBuf>,
}

#[derive(Default)]
struct RootState(Mutex<Roots>);

impl RootState {
    fn root(&self, which: &str) -> Result<PathBuf, String> {
        let roots = self.0.lock().map_err(|_| "内部エラー(ロック)".to_string())?;
        let found = match which {
            "ejs" => roots.ejs.clone(),
            "html" => roots.html.clone(),
            _ => return Err("ルートの種類が正しくありません".into()),
        };
        found.ok_or_else(|| "フォルダが設定されていません".to_string())
    }
}

fn canonical_dir(path: &str, label: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(PathBuf::from(path)).map_err(|_| format!("{}のフォルダが見つかりません", label))?;
    if !canonical.is_dir() {
        return Err(format!("{}はフォルダを指定してください", label));
    }
    // Windows の `\\?\` 接頭辞は、表示に使うパスから外す。
    let display = canonical.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    Ok(PathBuf::from(display))
}

/// 2 つのルートを設定する。`html` は空でもよい(公開サーバーから直接取得するとき)。
#[tauri::command]
fn set_roots(state: State<RootState>, ejs: String, html: Option<String>) -> Result<(), String> {
    let ejs_dir = canonical_dir(&ejs, "EJSソース")?;
    let html_dir = match html.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => Some(canonical_dir(h, "公開HTML")?),
        None => None,
    };
    let mut roots = state.0.lock().map_err(|_| "内部エラー(ロック)".to_string())?;
    roots.ejs = Some(ejs_dir);
    roots.html = html_dir;
    Ok(())
}

#[tauri::command]
fn dir_exists(state: State<RootState>, which: String, rel: String) -> Result<bool, String> {
    let root = state.root(&which)?;
    if rel.is_empty() {
        return Ok(root.is_dir());
    }
    Ok(fsops::resolve_in_root(&root, &rel)?.is_dir())
}

#[tauri::command]
fn list_ejs(state: State<RootState>, scope: String) -> Result<Vec<String>, String> {
    Ok(fsops::list_ejs(&state.root("ejs")?, &scope))
}

#[tauri::command]
fn list_html(state: State<RootState>, scope: String) -> Result<Vec<String>, String> {
    Ok(fsops::list_html_all(&state.root("html")?, &scope))
}

#[tauri::command]
fn abs_path(state: State<RootState>, which: String, rel: String) -> Result<String, String> {
    let p = fsops::resolve_in_root(&state.root(&which)?, &rel)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn path_exists(state: State<RootState>, which: String, rel: String) -> Result<bool, String> {
    let p = fsops::resolve_in_root(&state.root(&which)?, &rel)?;
    Ok(p.is_file())
}

#[tauri::command]
fn read_text(state: State<RootState>, which: String, rel: String) -> Result<String, String> {
    let p = fsops::resolve_in_root(&state.root(&which)?, &rel)?;
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// EJS ソースを書き換える。`backup` が真なら、初回だけ `.bak` を残す。書き込みは、原子的に行う。
#[tauri::command]
fn write_ejs(state: State<RootState>, rel: String, text: String, backup: bool) -> Result<(), String> {
    let p = fsops::resolve_in_root(&state.root("ejs")?, &rel)?;
    if backup {
        fsops::ensure_backup(&p).map_err(|e| e.to_string())?;
    }
    fsops::atomic_write(&p, text.as_bytes()).map_err(|e| e.to_string())
}

/// `.bak` があれば復元する。復元したら true、`.bak` が無ければ false。
#[tauri::command]
fn restore_ejs(state: State<RootState>, rel: String) -> Result<bool, String> {
    let p = fsops::resolve_in_root(&state.root("ejs")?, &rel)?;
    let bak = fsops::backup_path(&p);
    if !bak.exists() {
        return Ok(false);
    }
    std::fs::copy(&bak, &p).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn reveal(state: State<RootState>, which: String, rel: String) -> Result<(), String> {
    let p = fsops::resolve_in_root(&state.root(&which)?, &rel)?;
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

/// ファイル内の文字位置(JS の文字列の位置 = UTF-16 のコードユニット)から、1 始まりの行番号を出す。
fn line_number(content: &str, src_start: usize) -> usize {
    let mut units = 0usize;
    let mut line = 1usize;
    for ch in content.chars() {
        if units >= src_start {
            break;
        }
        if ch == '\n' {
            line += 1;
        }
        units += ch.len_utf16();
    }
    line
}

#[cfg(windows)]
fn resolve_vscode_executable() -> Option<PathBuf> {
    // Windows の VS Code のインストール本体(Code.exe)を探す。見つかれば、シェルを使わずに直接起動できる
    // ので、コマンドインジェクションを防げる。
    let mut roots: Vec<PathBuf> = Vec::new();
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(v) = std::env::var_os(key) {
            roots.push(PathBuf::from(v));
        }
    }
    roots
        .into_iter()
        .map(|r| r.join("Programs").join("Microsoft VS Code").join("Code.exe"))
        .find(|p| p.exists())
}

#[cfg(not(windows))]
fn resolve_vscode_executable() -> Option<PathBuf> {
    None
}

/// VS Code でファイルを開く(`-g ファイル:行`)。起動できなければ、フォルダを開く。
/// 戻り値は、エラーの文(エディタで開けたときは null)。
#[tauri::command]
fn open_in_editor(state: State<RootState>, rel: String, src_start: Option<usize>) -> Result<Option<String>, String> {
    let file = fsops::resolve_in_root(&state.root("ejs")?, &rel)?;
    if !file.is_file() {
        return Err("ファイルが見つかりません".into());
    }
    let file_str = file.to_string_lossy().to_string();
    // シェル経由で code(.cmd)を起動する場合に備えて、シェルのメタ文字を含むパスは拒否する(コマンドインジェクションの防止)。
    if file_str.chars().any(|c| c.is_control() || "&|<>^%!\"".contains(c)) {
        return Err("サポートされない文字を含むパスです".into());
    }
    let line = std::fs::read(&file)
        .ok()
        .map(|b| line_number(&String::from_utf8_lossy(&b), src_start.unwrap_or(0)))
        .unwrap_or(1);
    let target = format!("{}:{}", file_str, line);

    let exe = resolve_vscode_executable();
    let mut cmd = match (&exe, cfg!(windows)) {
        (Some(path), _) => {
            let mut c = std::process::Command::new(path);
            c.arg("-g").arg(&target);
            c
        }
        (None, true) => {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "code", "-g"]).arg(&target);
            c
        }
        (None, false) => {
            let mut c = std::process::Command::new("code");
            c.arg("-g").arg(&target);
            c
        }
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: 黒いコンソールを出さない
    }
    match cmd.spawn() {
        Ok(_) => Ok(None),
        Err(_) => {
            let _ = tauri_plugin_opener::reveal_item_in_dir(&file);
            Ok(Some("VSCodeの起動に失敗したためフォルダを開きました".into()))
        }
    }
}

#[derive(Serialize)]
struct FetchError {
    message: String,
    status: Option<u16>,
}

fn fetch_err(message: impl Into<String>, status: Option<u16>) -> FetchError {
    FetchError { message: message.into(), status }
}

/// 公開サーバーのテキストを取る。Basic 認証・タイムアウト・サイズ上限を守る。
#[tauri::command]
async fn fetch_text(url: String, auth: Option<String>, timeout_ms: u64, max_bytes: u64) -> Result<String, FetchError> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| fetch_err("URL が正しくありません", None))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(fetch_err("http:// または https:// の URL だけ指定できます", None));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent("ymb-ejs-sync")
        .build()
        .map_err(|e| fetch_err(e.to_string(), None))?;
    let mut req = client.get(parsed);
    if let Some(a) = auth.filter(|a| !a.is_empty()) {
        req = req.header(reqwest::header::AUTHORIZATION, a);
    }
    let mut res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            fetch_err("タイムアウトしました", None)
        } else {
            fetch_err(e.to_string(), None)
        }
    })?;
    let status = res.status();
    if !status.is_success() {
        return Err(fetch_err(format!("HTTPステータス {}", status.as_u16()), Some(status.as_u16())));
    }
    let too_large = || fetch_err(format!("レスポンスが大きすぎます({}MB上限)", max_bytes / (1024 * 1024)), None);
    if res.content_length().map(|n| n > max_bytes).unwrap_or(false) {
        return Err(too_large());
    }
    let mut body: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                if (body.len() + chunk.len()) as u64 > max_bytes {
                    return Err(too_large());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                if e.is_timeout() {
                    return Err(fetch_err("タイムアウトしました", None));
                }
                return Err(fetch_err(e.to_string(), None));
            }
        }
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 二重起動を防ぐ。2つ開くと、同じソースに対するパッチの適用や復元が同時に走って、書き込みが競合する。
        // 2つ目の起動では、先に起動している本体を前面に出す。単一起動のプラグインは、先に登録する。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // ウインドウの位置・大きさ・最大化の状態を保存して、次回の起動で復元する。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // EJS テンプレートの JavaScript を実行する、隔離した枠のページ。本体の画面の CSP には eval を許さず、
        // この専用のスキームから、この枠だけに許す(通信は不可: default-src 'none')。
        .register_uri_scheme_protocol("ymbsandbox", |_ctx, _request| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header(
                    "Content-Security-Policy",
                    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'",
                )
                .header("Cache-Control", "no-store")
                .body(include_str!("../sandbox.html").as_bytes().to_vec())
                .unwrap()
        })
        .manage(RootState::default())
        .invoke_handler(tauri::generate_handler![
            set_roots,
            dir_exists,
            list_ejs,
            list_html,
            abs_path,
            path_exists,
            read_text,
            write_ejs,
            restore_ejs,
            reveal,
            open_in_editor,
            fetch_text,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::line_number;

    #[test]
    fn line_number_counts_newlines_before_position() {
        let text = "a\nbb\nccc";
        assert_eq!(line_number(text, 0), 1);
        assert_eq!(line_number(text, 2), 2);
        assert_eq!(line_number(text, 5), 3);
        assert_eq!(line_number(text, 999), 3);
    }

    #[test]
    fn line_number_uses_utf16_positions_like_javascript() {
        // JS の位置は UTF-16。絵文字(サロゲートペア)は、2 つ分として数える。
        let text = "😀\nx";
        assert_eq!(line_number(text, 2), 1); // 絵文字の直後(改行の手前)
        assert_eq!(line_number(text, 3), 2);
    }
}
