use tauri::{
    Manager,
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    WindowEvent,
};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri_plugin_sql::{Migration, MigrationKind};

mod backup;
mod server;
mod stats;

/// The database the app and its local API share, handed to commands that read it
pub struct DbPath(pub String);

#[tauri::command]
fn save_export(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Replaces the library with a JSON export. What is about to be replaced is
/// snapshotted first, so restoring the wrong file is recoverable.
#[tauri::command]
fn import_library(path: String, db: tauri::State<'_, DbPath>) -> Result<backup::RestoreReport, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| format!("couldn't read {path}: {e}"))?;
    backup::snapshot_before_restore(&db.0)?;
    backup::restore(&db.0, &json)
}

#[tauri::command]
fn get_stats(path: tauri::State<'_, DbPath>) -> Result<stats::Stats, String> {
    stats::build_stats(&path.0)
}

#[tauri::command]
fn get_novel_history(id: i64, path: tauri::State<'_, DbPath>) -> Result<stats::NovelHistory, String> {
    stats::novel_history(&path.0, id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "sources unique index",
            sql: include_str!("../migrations/002_sources_unique.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "aliases novel index",
            sql: include_str!("../migrations/003_aliases_index.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "metadata columns and reading log",
            sql: include_str!("../migrations/004_metadata_reading_log.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "rating and drop reason",
            sql: include_str!("../migrations/005_rating_and_drop_reason.sql"),
            kind: MigrationKind::Up,
        },
    ];

    // Never panic at startup — fall back to the temp dir if the platform won't tell us
    let data_dir = dirs::data_dir().unwrap_or_else(std::env::temp_dir);

    let db_path = data_dir
        .join("com.aweso.noveltrackr")
        .join("noveltrackr.db")
        .to_string_lossy()
        .to_string();

    // One snapshot a day, taken before anything else touches the file. A failed
    // backup must never stop the app from starting.
    match backup::daily_snapshot(&db_path, backup::KEEP_DAILY) {
        Ok(Some(path)) => eprintln!("[noveltrackr] backed up to {}", path.display()),
        Ok(None) => {}
        Err(e) => eprintln!("[noveltrackr] could not back up the database: {}", e),
    }

    server::start_server(db_path.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When user tries to open a second instance, focus the existing window instead
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_sql::Builder::default()
            .add_migrations("sqlite:noveltrackr.db", migrations)
            .build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DbPath(db_path))
        .invoke_handler(tauri::generate_handler![save_export, get_stats, get_novel_history, import_library])
        .setup(|app| {
            let quit = MenuItemBuilder::new("Quit Noveltrackr").id("quit").build(app)?;
            let show = MenuItemBuilder::new("Open").id("show").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Noveltrackr")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}