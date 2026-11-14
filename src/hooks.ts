import { PdfXmlFactory } from "./modules/pdfXml";
import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";

const MENU_ID = `zotero-itemmenu-${config.addonRef}-write-pdf-xml`;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();

  PdfXmlFactory.enable();
  PdfXmlFactory.registerPrefs();
  PdfXmlFactory.registerNotifier();

  // `onStartup` runs once per session; register UI for every window that is
  // already open, then rely on `onMainWindowLoad` for later windows.
  for (const win of Zotero.getMainWindows()) {
    if (win && !win.closed) {
      await onMainWindowLoad(win as Window);
    }
  }
}

/**
 * Called once per main window (including every re-open of the window).
 * Registration must be idempotent: `onMainWindowLoad` can be reached both from
 * `onStartup` and from the bootstrap window listener.
 */
async function onMainWindowLoad(win: Window): Promise<void> {
  const doc = win.document;

  // Register the context menu item once per document.
  if (!doc.getElementById(MENU_ID)) {
    ztoolkit.Menu.register(
      "item",
      {
        tag: "menuitem",
        id: MENU_ID,
        label: "Write PDF XML",
        icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
        commandListener: () => {
          void onWritePdfXmlCommand(win);
        },
      },
      "before",
      (doc.querySelector("#zotero-itemmenu-separator") as XUL.Element) ??
        undefined,
    );
  }
}

/**
 * Context-menu handler: writes immediately for the current selection and
 * reports the outcome, since the user explicitly asked for it.
 */
async function onWritePdfXmlCommand(win: Window) {
  try {
    const pane = (win as any).ZoteroPane ?? Zotero.getActiveZoteroPane();
    const items = (pane?.getSelectedItems?.() ?? []) as Zotero.Item[];
    if (!items.length) {
      return;
    }
    const ids = items.map((item) => item.id);
    await PdfXmlFactory.writeNow(ids);
    PdfXmlFactory.notify([
      { text: `Write PDF XML: processed ${ids.length} item(s)` },
    ]);
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Only tear down this window's UI; `ztoolkit` is global to the addon and
  // unregisterAll() here would strip the menu from the other windows too.
  try {
    win.document.getElementById(MENU_ID)?.remove();
  } catch (e) {
    // Window may already be gone.
  }
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  PdfXmlFactory.unregisterNotifier();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  delete Zotero[config.addonInstance];
}

/**
 * Dispatcher for Notifier events. Keep this cheap: the PDF writing is queued
 * and executed outside the notifier callback.
 */
async function onNotify(
  event: string,
  type: string,
  ids: number[] | string[], //Array<number | string>,
  extraData: { [key: string]: any },
) {
  if (type === "item" && event === "modify") {
    PdfXmlFactory.queue(ids as number[]);
  }
}

/**
 * Dispatcher for Preference UI events.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintian.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
