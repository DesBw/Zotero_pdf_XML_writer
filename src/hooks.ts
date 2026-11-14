import { PdfXmlFactory } from "./modules/pdfXml";
import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { notify, registerPrefs } from "./modules/zoteroAPI";

/** Id used for the official Zotero 8+ menu API. */
const MENU_ID = `${config.addonRef}-write-pdf-xml`;
/** Legacy DOM id, used only by the pre-Zotero-8 fallback path. */
const LEGACY_MENU_ID = `zotero-itemmenu-${MENU_ID}`;
const MENU_ICON = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;
const MENU_FALLBACK_LABEL = "Write PDF XML";

/** True when the official menu API (Zotero 8+) is available. */
function hasMenuManager(): boolean {
  return typeof (Zotero as any).MenuManager?.registerMenu === "function";
}

/** Localised menu label, with a hard-coded fallback. */
function menuLabel(): string {
  const value = getString("write-pdf-xml-menu");
  // getString returns the message id when the string is missing.
  if (!value || value.startsWith(`${config.addonRef}-`)) {
    return MENU_FALLBACK_LABEL;
  }
  return value;
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();

  PdfXmlFactory.enable();
  registerPrefs();
  PdfXmlFactory.registerNotifier();

  registerMenus();

  addon.data.initialized = true;
  Zotero.debug(`${config.addonName}: startup complete`);
}

/**
 * Register the context menu (and a Tools menu entry as a fallback entry point).
 *
 * Zotero 8+ replaced per-window DOM injection with `Zotero.MenuManager`. Items
 * injected the old way are not reliably kept by Zotero 10's rebuilt item menu,
 * so the official API is used whenever it is available.
 */
function registerMenus() {
  if (hasMenuManager()) {
    registerMenuManagerMenus();
    return;
  }
  // Pre-Zotero-8 fallback: inject into each open window's popup.
  for (const win of Zotero.getMainWindows()) {
    if (win && !win.closed) {
      injectLegacyMenuItem(win as Window);
    }
  }
}

function registerMenuManagerMenus() {
  const manager = (Zotero as any).MenuManager;

  // Re-registering the same menuID is an error on some versions, so clear it.
  try {
    manager.unregisterMenu?.(MENU_ID);
    manager.unregisterMenu?.(`${MENU_ID}-tools`);
  } catch (e) {
    Zotero.debug(`${config.addonName}: could not clear old menus: ${e}`);
  }

  try {
    const id = manager.registerMenu({
      menuID: MENU_ID,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          icon: MENU_ICON,
          // The label is set here rather than via l10nID: if plugin FTL strings
          // are unavailable the item would otherwise render with no label.
          onShowing: (event: Event, context: any) => {
            applyMenuState(context, "item");
          },
          onCommand: (event: Event, context: any) => {
            void onWritePdfXmlCommand(context?.items);
          },
        },
      ],
    });
    Zotero.debug(`${config.addonName}: item menu registered (${id})`);
  } catch (e) {
    Zotero.logError(e as Error);
    Zotero.debug(`${config.addonName}: item menu registration failed: ${e}`);
  }

  try {
    manager.registerMenu({
      menuID: `${MENU_ID}-tools`,
      pluginID: config.addonID,
      target: "main/menubar/tools",
      menus: [
        {
          menuType: "menuitem",
          icon: MENU_ICON,
          onShowing: (event: Event, context: any) => {
            applyMenuState(context, "tools");
          },
          onCommand: (event: Event, context: any) => {
            void onWritePdfXmlCommand(context?.items);
          },
        },
      ],
    });
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

/**
 * Sets the label and state of a menu built by `Zotero.MenuManager`.
 *
 * - "item": context menu — hidden and disabled unless a regular item is selected.
 * - "tools": menubar entry — always available, falls back to the pane selection.
 *
 * The label is applied as an attribute rather than through `l10nID`, because a
 * menu item whose FTL string cannot be resolved renders with no text at all.
 */
function applyMenuState(context: any, mode: "item" | "tools") {
  try {
    context?.menuElem?.setAttribute("label", menuLabel());
    if (mode === "item") {
      const usable = selectedRegularItems(context?.items).length > 0;
      context?.setEnabled?.(usable);
      context?.setVisible?.(usable);
    }
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

/**
 * Pre-Zotero-8 menu injection, kept as a fallback: builds the menuitem by hand
 * rather than through the old toolkit Menu manager.
 */
function injectLegacyMenuItem(win: Window) {
  try {
    const doc = (win as any).document;
    const popup: any = doc?.querySelector?.("#zotero-itemmenu");
    if (!popup || doc.getElementById(LEGACY_MENU_ID)) {
      return;
    }
    const item: any = doc.createXULElement("menuitem");
    item.id = LEGACY_MENU_ID;
    item.setAttribute("label", menuLabel());
    item.setAttribute("class", "menuitem-iconic");
    item.style.setProperty("list-style-image", `url(${MENU_ICON})`);
    item.addEventListener("command", () => {
      void onWritePdfXmlCommand();
    });
    popup.appendChild(item);
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

/** Only regular, non-deleted items can be written. */
function selectedRegularItems(items: unknown): Zotero.Item[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return (items as Zotero.Item[]).filter(
    (item) => item && item.isRegularItem?.() && !item.deleted,
  );
}

/**
 * Called once per main window (including every re-open of the window) by the
 * bootstrap window listener. Only needed for the legacy menu path.
 */
async function onMainWindowLoad(win: Window): Promise<void> {
  if (!hasMenuManager()) {
    injectLegacyMenuItem(win);
  }
}

/**
 * Writes immediately for the given selection and reports the outcome, since
 * the user explicitly asked for it.
 */
async function onWritePdfXmlCommand(items?: Zotero.Item[]) {
  try {
    let selection = selectedRegularItems(items);
    if (!selection.length) {
      // Fall back to the pane selection (legacy path/entry points).
      const pane = Zotero.getActiveZoteroPane();
      selection = selectedRegularItems(pane?.getSelectedItems?.());
    }
    if (!selection.length) {
      return;
    }
    const ids = selection.map((item) => item.id);
    Zotero.debug(
      `${config.addonName}: menu command on ${ids.length} item(s): ${ids.join(
        ",",
      )}`,
    );
    const report = await PdfXmlFactory.writeNow(ids);
    notify(`Write PDF XML: ${PdfXmlFactory.summarize(report)}`);
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Zotero removes MenuManager menus itself; only the legacy injection needs
  // manual cleanup.
  try {
    win.document.getElementById(LEGACY_MENU_ID)?.remove();
  } catch (e) {
    // Window may already be gone.
  }
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  PdfXmlFactory.unregisterNotifier();
  if (hasMenuManager()) {
    const manager = (Zotero as any).MenuManager;
    for (const id of [MENU_ID, `${MENU_ID}-tools`]) {
      try {
        manager.unregisterMenu?.(id);
      } catch (e) {
        Zotero.debug(`${config.addonName}: could not unregister ${id}: ${e}`);
      }
    }
  }
  addon.data.dialog?.window?.close?.();
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
