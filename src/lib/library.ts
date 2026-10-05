// Emotes, stickers and soundboard sounds: things a server's members upload for the server to share.
// The lists themselves update from the server's broadcast, which reaches this client too.
import { t } from "./i18n.svelte.ts";
import { session } from "./session.svelte.ts";
import type { Library, ServerItem } from "./types.ts";

// Each answers with an error to show, or "".
export function addLibraryItem(serverId: number | undefined, library: Library, name: string, file: File): Promise<string> | string {
  if (serverId === undefined) return t("No server open.");
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  return session.submit(`/servers/${serverId}/${library}`, "POST", form);
}

export function removeLibraryItem(serverId: number | undefined, library: Library, item: ServerItem): Promise<string> | string {
  if (serverId === undefined) return t("No server open.");
  return session.submit(`/servers/${serverId}/${library}/${item.id}`, "DELETE");
}
