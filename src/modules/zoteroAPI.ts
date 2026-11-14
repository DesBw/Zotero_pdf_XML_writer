import { config } from "../../package.json";

/**
 * Registration bookkeeping for the preference pane.
 *
 * This is implemented directly against `Zotero.PreferencePanes` instead of
 * going through zotero-plugin-toolkit: the toolkit is a 1 MB bundle that is
 * fully evaluated at plugin load (React bindings, debug bridge, plugin bridge,
 * an `AddonManager.jsm` import), and any breakage inside it prevents the
 * plugin's own code from ever running.
 */

export function registerPrefs() {
  const panes: any = (Zotero as any).PreferencePanes;
  if (!panes?.register) {
    Zotero.debug(`${config.addonName}: Zotero.PreferencePanes unavailable`);
    return;
  }
  const doRegister = (src: string) =>
    // `register` returns a promise (Zotero 8+); swallow rejections so a pane
    // problem can never break startup.
    Promise.resolve(
      panes.register({
        pluginID: config.addonID,
        src,
        // Label is resolved from the plugin's FTL file by Zotero; the English
        // fallback is only used if localisation is unavailable.
        label: getPrefsLabel(),
        image: `chrome://${config.addonRef}/content/icons/favicon.png`,
        defaultXUL: true,
      }),
    ).catch((e: unknown) => {
      Zotero.logError(e as Error);
      Zotero.debug(`${config.addonName}: preference pane registration failed`);
    });

  try {
    // Zotero resolves fragments relative to the plugin root, so a relative
    // path is preferred; the absolute URI keeps older versions working.
    doRegister("chrome/content/preferences.xhtml").then((id) => {
      Zotero.debug(`${config.addonName}: preference pane registered (${id})`);
    });
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

function getPrefsLabel(): string {
  try {
    const l10n = addon.data.locale?.current;
    const pattern = l10n?.formatMessagesSync([
      { id: `${config.addonRef}-prefs-title` },
    ])[0];
    if (pattern?.value) {
      return pattern.value;
    }
  } catch (e) {
    /* fall through to the static label */
  }
  return config.addonName;
}

/**
 * Small, non-blocking status notification.
 *
 * Uses Zotero's own ProgressWindow with an item-type icon. Zotero 8+ no longer
 * accepts arbitrary icon URLs there, but item types still map to built-in
 * icons, so this degrades gracefully across versions.
 */
export function notify(text: string) {
  try {
    const ProgressWindow = (Zotero as any).ProgressWindow as any;
    if (!ProgressWindow) {
      Zotero.debug(`${config.addonName}: ${text}`);
      return;
    }
    const win = new ProgressWindow({ closeOnClick: true, closeTime: 4000 });
    win.changeHeadline?.(config.addonName);
    win.createLine({
      icon: "document",
      text,
    });
    win.show();
    win.startCloseTimer?.(4000);
  } catch (e) {
    // Notification failures must never affect the actual work.
    try {
      Zotero.debug(`${config.addonName}: ${text}`);
    } catch (inner) {
      /* ignore */
    }
  }
}
