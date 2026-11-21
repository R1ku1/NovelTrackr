import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  version: string;
  notes: string;
  installer_url: string;
  sha256: string;
  size?: number;
}

export function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke("check_for_update");
}

export function installUpdate(update: UpdateInfo): Promise<string> {
  return invoke("download_update", { update });
}
