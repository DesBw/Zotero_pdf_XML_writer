import { BasicTool } from "zotero-plugin-toolkit/dist/basic";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

/**
 * Entry point. Wrapped in try/catch: the whole bundle is loaded from
 * `bootstrap.js`, and an uncaught error here used to leave the plugin
 * registered but inert (no menu, no notifier) until the next restart.
 */
try {
  const ZoteroGlobal = basicTool.getGlobal("Zotero");
  // Guard against a double load (e.g. disable → enable in one session).
  if (!ZoteroGlobal[config.addonInstance]) {
    // Set global variables
    _globalThis.Zotero = ZoteroGlobal;
    defineGlobal("window");
    defineGlobal("document");
    defineGlobal("ZoteroPane");
    defineGlobal("Zotero_Tabs");
    _globalThis.addon = new Addon();
    _globalThis.ztoolkit = addon.data.ztoolkit;
    Zotero[config.addonInstance] = addon;
    // Trigger addon hook for initialization
    addon.hooks.onStartup();
  }
} catch (e) {
  // Never let plugin initialisation break Zotero startup.
  try {
    basicTool.getGlobal("Zotero").logError(e as Error);
  } catch (inner) {
    /* last resort: nothing to log to */
  }
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return basicTool.getGlobal(name);
    },
  });
}
