# Extract to Note

Select text in a note, run **Extract selection to new note**, and the plugin will:

1. Create a note named after the selected text
2. Replace the selection with a link to the new note
3. Open the new note
4. Put a backlink to the source note at the top of the new note

## Install (manual)
```
npm install
npm run build
```
Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/extract-to-note/`, then enable it under Settings → Community plugins.

## Hotkey
Settings → Hotkeys → search "Extract selection to new note".

## Settings
- **Destination folder**: defaults to vault root; created automatically if missing.

## Notes
- Characters illegal in filenames or links (`\ / : * ? " < > | # ^ [ ]`) are stripped from the note name; the original text is kept as the link's display text.
- Names are capped at 100 characters.
- If a note with that name already exists, it's linked and opened, not overwritten.
