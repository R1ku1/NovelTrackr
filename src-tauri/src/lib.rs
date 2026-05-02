use tauri_plugin_sql::{Migration, MigrationKind};
mod server;

#[tauri::command]
fn save_export(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
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
    ];

    let db_path = format!(
        "{}/noveltrackr.db",
        dirs::data_dir()
            .unwrap()
            .join("com.aweso.noveltrackr")
            .to_string_lossy()
    );

    server::start_server(db_path);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:noveltrackr.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_export])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}