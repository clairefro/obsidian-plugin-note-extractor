import {
  App,
  Editor,
  MarkdownFileInfo,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";

interface ExtractToNoteSettings {
  /** Vault-relative folder for new notes. Empty string = vault root. */
  destinationFolder: string;
}

const DEFAULT_SETTINGS: ExtractToNoteSettings = {
  destinationFolder: "",
};

export default class ExtractToNotePlugin extends Plugin {
  settings: ExtractToNoteSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    // Exposed as a command, so it can be bound to a hotkey in
    // Settings → Hotkeys (search "Extract selection to new note").
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
    const title = this.toFilename(selection);
    if (!title) {
      new Notice("Selection can't be turned into a valid note name.");
      return;
    }

    try {
      const folder = await this.ensureFolder(this.settings.destinationFolder);
      const newPath = normalizePath(folder ? `${folder}/${title}.md` : `${title}.md`);

      // Reuse the note if it already exists rather than overwriting it.
      let newFile = this.app.vault.getAbstractFileByPath(newPath);
      let created = false;
      if (newFile && !(newFile instanceof TFile)) {
        new Notice(`"${newPath}" exists and isn't a note.`);
        return;
      }
      if (!newFile) {
        // Backlink at top of the new note, honoring the user's link format settings.
        const backlink = this.app.fileManager.generateMarkdownLink(sourceFile, newPath);
        newFile = await this.app.vault.create(newPath, `${backlink}\n\n`);
        created = true;
      }
      const file = newFile as TFile;

      // Replace the selection with a link. Keep the original text as the
      // display alias if the filename had to be altered.
      const displayText = selection.replace(/\s+/g, " ").trim();
      const alias = displayText !== file.basename ? displayText : undefined;
      const link = this.app.fileManager.generateMarkdownLink(
        file,
        sourceFile.path,
        undefined,
        alias
      );
      editor.replaceSelection(link);

      // Open the new note.
      await this.app.workspace.getLeaf("tab").openFile(file);

      if (!created) new Notice(`Linked to existing note "${file.basename}".`);
    } catch (err) {
      console.error("Extract to Note failed:", err);
      new Notice(`Extract to Note failed: ${(err as Error).message}`);
    }
  }

  /** Strip characters that are illegal in filenames or break wikilinks. */
  private toFilename(text: string): string {
    return text
      .replace(/[\\/:*?"<>|#^[\]]/g, "") // illegal / link-breaking chars
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "") // no leading dots
      .slice(0, 100)
      .trim();
  }

  /** Create the folder (and parents) if missing. Returns normalized path ("" = root). */
  private async ensureFolder(folder: string): Promise<string> {
    const clean = normalizePath(folder.trim()).replace(/^\/+|\/+$/g, "");
    if (!clean || clean === ".") return "";

    const parts = clean.split("/");
    let current = "";
    for (const part of parts) {
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

class ExtractToNoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ExtractToNotePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Destination folder")
      .setDesc(
        "Where new notes are created, relative to the vault root (e.g. \"Extracts\" or \"Notes/Atomic\"). Leave empty for the root. The folder is created if it doesn't exist."
      )
      .addText((text) =>
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.destinationFolder)
          .onChange(async (value) => {
            this.plugin.settings.destinationFolder = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
