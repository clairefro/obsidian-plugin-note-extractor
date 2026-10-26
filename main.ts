import {
  AbstractInputSuggest,
  App,
  Editor,
  MarkdownFileInfo,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

interface ExtractToNoteSettings {
  /** Vault-relative folder for new notes. Empty string = vault root. */
  destinationFolder: string;
}

const DEFAULT_SETTINGS: ExtractToNoteSettings = {
  destinationFolder: "",
};

const MAX_NAME_CHARS = 100;
const MAX_NAME_BYTES = 200; // filesystems cap names at 255 bytes; leave room for ".md"
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn arbitrary selected text into a safe note name.
 * Returns "" if nothing usable is left (caller supplies a fallback).
 */
function toFilename(text: string): string {
  let name = text
    .normalize("NFC")
    // control chars, zero-width and bidi-override chars -> space
    .replace(
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,
      " ",
    )
    // ":" reads best as " - "  ("Note: idea" -> "Note - idea")
    .replace(/\s*:\s*/g, " - ")
    // path separators and pipe -> dash  ("and/or" -> "and-or")
    .replace(/\s*[\\/|]\s*/g, "-")
    // characters that are illegal or break links: drop them
    .replace(/[*?"<>#^[\]]/g, "")
    .replace(/\s+/g, " ")
    // no leading/trailing dots, spaces or dashes (Windows rejects trailing dots/spaces)
    .replace(/^[.\s-]+|[.\s-]+$/g, "");

  name = truncate(name);

  // "CON.md", "NUL.md" etc. are reserved on Windows
  if (name && WINDOWS_RESERVED.test(name.split(".")[0])) name += "_";

  return name;
}

/** Local time as "YYYY-MM-DD HHmmss", used for fallback note names. */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Truncate by characters and UTF-8 bytes, without splitting emoji/surrogate pairs. */
function truncate(name: string): string {
  const encoder = new TextEncoder();
  const chars = Array.from(name);
  if (
    chars.length <= MAX_NAME_CHARS &&
    encoder.encode(name).length <= MAX_NAME_BYTES
  ) {
    return name;
  }

  let kept = chars.slice(0, MAX_NAME_CHARS);
  while (kept.length && encoder.encode(kept.join("")).length > MAX_NAME_BYTES)
    kept.pop();
  let out = kept.join("");

  // Prefer cutting at a word boundary if it doesn't lose too much
  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > out.length * 0.6) out = out.slice(0, lastSpace);

  return out.replace(/[.\s-]+$/, "");
}

export default class ExtractToNotePlugin extends Plugin {
  settings: ExtractToNoteSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    // Exposed as a command so it can be bound to a hotkey in
    // Settings -> Hotkeys (search "Extract selection to new note").
    this.addCommand({
      id: "extract-selection-to-note",
      name: "Extract selection to new note",
      editorCheckCallback: (checking, editor, view) => {
        const hasSelection = editor.getSelection().trim().length > 0;
        if (!hasSelection || !view.file) return false;
        if (!checking) void this.extract(editor, view);
        return true;
      },
    });

    this.addSettingTab(new ExtractToNoteSettingTab(this.app, this));
  }

  async extract(editor: Editor, view: MarkdownFileInfo) {
    const sourceFile = view.file;
    if (!sourceFile) return;

    const selection = editor.getSelection();
    const title = toFilename(selection) || `Extract ${timestamp()}`;

    try {
      const folder = await this.ensureFolder(this.settings.destinationFolder);
      const newPath = normalizePath(
        folder ? `${folder}/${title}.md` : `${title}.md`,
      );

      // Reuse the note if it already exists rather than overwriting it.
      const existing = this.app.vault.getAbstractFileByPath(newPath);
      if (existing && !(existing instanceof TFile)) {
        new Notice(`"${newPath}" exists and isn't a note.`);
        return;
      }

      let file: TFile;
      if (existing instanceof TFile) {
        file = existing;
        new Notice(`Linked to existing note "${file.basename}".`);
      } else {
        // Backlink at top of the new note, honoring the user's link format settings.
        const backlink = this.app.fileManager.generateMarkdownLink(
          sourceFile,
          newPath,
        );
        file = await this.app.vault.create(newPath, `${backlink}\n\n`);
      }

      // Keep the original text as the link's display text when the filename differs.
      // Strip characters that would break a link's alias.
      const displayText = selection
        .replace(/\s+/g, " ")
        .replace(/[|[\]]/g, "")
        .trim();
      const alias =
        displayText && displayText !== file.basename ? displayText : undefined;

      editor.replaceSelection(
        this.app.fileManager.generateMarkdownLink(
          file,
          sourceFile.path,
          undefined,
          alias,
        ),
      );

      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (err) {
      console.error("Extract to Note failed:", err);
      new Notice(`Extract to Note failed: ${(err as Error).message}`);
    }
  }

  /** Create the folder (and parents) if missing. Returns normalized path ("" = root). */
  private async ensureFolder(folder: string): Promise<string> {
    const clean = normalizePath(folder.trim()).replace(/^\/+|\/+$/g, "");
    if (!clean || clean === ".") return "";

    let current = "";
    for (const part of clean.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
    return clean;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** Type-ahead dropdown of existing vault folders attached to a text input. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private el: HTMLInputElement,
    private onPick: (path: string) => void,
  ) {
    super(app, el);
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase().trim();
    return this.app.vault
      .getAllLoadedFiles()
      .filter(
        (f): f is TFolder =>
          f instanceof TFolder && f.path.toLowerCase().includes(q),
      )
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.isRoot() ? "/ (vault root)" : folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    const path = folder.isRoot() ? "" : folder.path;
    this.el.value = path;
    this.onPick(path);
    this.close();
  }
}

class ExtractToNoteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ExtractToNotePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Destination folder")
      .setDesc(
        "Where new notes are created. Start typing to pick an existing folder, or enter a new path (it will be created). Leave empty for the vault root.",
      )
      .addSearch((search) => {
        const save = async (value: string) => {
          this.plugin.settings.destinationFolder = value.trim();
          await this.plugin.saveSettings();
        };
        search
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.destinationFolder)
          .onChange(save);
        new FolderSuggest(this.app, search.inputEl, save);
      });
  }
}
