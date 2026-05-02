import Database from "@tauri-apps/plugin-sql";

let _db: Database | null = null;
let _loading: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (_db) return _db;
  
  // If already loading, wait for that same promise instead of starting a new one
  if (_loading) return _loading;
  
  _loading = Database.load("sqlite:noveltrackr.db").then((db) => {
    _db = db;
    _loading = null;
    return db;
  });

  return _loading;
}