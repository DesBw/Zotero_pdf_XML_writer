import { config } from "../../package.json";

/**
 * Called when the preferences pane is loaded.
 * See addon/chrome/content/preferences.xhtml onload.
 */
export async function registerPrefsScripts(win: Window) {
  if (!win?.document.getElementById(`zotero-prefpane-${config.addonRef}`)) {
    return;
  }
  bindPrefEvents(win);
  syncPrefsUI(win);
}

const AUTO_WRITE_PREF = `${config.prefsPrefix}.autoWrite`;
const DEBOUNCE_PREF = `${config.prefsPrefix}.debounceMs`;

function syncPrefsUI(win: Window) {
  const doc = win.document;

  const autoWrite = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-auto-write`,
  ) as XUL.Checkbox | null;
  if (autoWrite) {
    const value = Zotero.Prefs.get(AUTO_WRITE_PREF, true);
    autoWrite.checked = value === undefined ? true : Boolean(value);
  }

  const debounce = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-debounce`,
  ) as HTMLInputElement | null;
  if (debounce) {
    const value = Zotero.Prefs.get(DEBOUNCE_PREF, true);
    debounce.value = String(value ?? 1500);
  }
}

function bindPrefEvents(win: Window) {
  const doc = win.document;

  doc
    .getElementById(`zotero-prefpane-${config.addonRef}-auto-write`)
    ?.addEventListener("command", (e) => {
      const checkbox = e.target as XUL.Checkbox;
      Zotero.Prefs.set(AUTO_WRITE_PREF, Boolean(checkbox.checked), true);
    });

  doc
    .getElementById(`zotero-prefpane-${config.addonRef}-debounce`)
    ?.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const value = Number(input.value);
      // Guard against empty / negative / non-numeric input.
      const safe = Number.isFinite(value) && value >= 0 ? value : 1500;
      input.value = String(safe);
      Zotero.Prefs.set(DEBOUNCE_PREF, safe, true);
    });
}
