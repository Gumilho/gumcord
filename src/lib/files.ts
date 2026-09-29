// Files people give the app: chosen in a file dialog, or pasted (a screenshot, a picture copied
// from a page, a file copied from a folder).

// The file chosen in an <input type="file">. The input is reset, so choosing the same file again still counts.
export function chosenFile(e: Event): File | null {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = "";
  return file;
}

// The file in a paste, if there's one `accept` takes, in which case the paste is taken over;
// otherwise null, and the paste goes ahead as usual (text into a field).
export function pastedFile(e: ClipboardEvent, accept: (file: File) => boolean = () => true): File | null {
  if (e.defaultPrevented) return null; // already taken, by the message box say
  const file = e.clipboardData?.files[0];
  if (!file || !accept(file)) return null;
  e.preventDefault();
  return file;
}

export const isImage = (file: File) => file.type.startsWith("image/");
export const isAudio = (file: File) => file.type.startsWith("audio/");
