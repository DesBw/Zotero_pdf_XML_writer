import Addon from "./addon";
import { config } from "../package.json";

/**
 * Entry point, evaluated by `bootstrap.js` through `loadSubScript`.
 *
 * This deliberately avoids any heavy library at top level. Earlier versions
 * imported the whole zotero-plugin-toolkit here; when anything inside that
 * bundle failed on a new Zotero version, this file never finished evaluating,
 * no hooks were registered and the plugin looked installed but dead.
 *
 * Every step is guarded, and the outcome is written to Zotero's debug log
 * (`Write PDF XML: …`) so a failure is diagnosable from View Output.
 */
function main() {
  const Zotero = getZotero();
  if (!Zotero) {
    return;
  }
  try {
    Zotero.debug?.(`${config.addonName}: bundle loaded`);
    // Guard against a double load (e.g. disable -> enable in one session).
    if (Zotero[config.addonInstance]) {
      Zotero.debug?.(`${config.addonName}: already initialised, skipping`);
      return;
    }
    installGlobals(Zotero);
    _globalThis.addon = new Addon();
    Zotero[config.addonInstance] = addon;
    addon.hooks.onStartup().catch((e: unknown) => {
      Zotero.logError?.(e as Error);
      Zotero.debug?.(`${config.addonName}: onStartup rejected: ${e}`);
    });
  } catch (e) {
    // Never let plugin initialisation break Zotero startup.
    try {
      Zotero.logError?.(e as Error);
      Zotero.debug?.(`${config.addonName}: bundle init failed: ${e}`);
    } catch (inner) {
      /* nothing left to report to */
    }
  }
}

/** Resolve the Zotero object without depending on any library. */
function getZotero(): any {
  if (typeof Zotero != "undefined" && Zotero) {
    return Zotero;
  }
  try {
    return (globalThis as any).Zotero;
  } catch (e) {
    return undefined;
  }
}

/** Expose the globals the rest of the code expects. */
function installGlobals(Zotero: any) {
  _globalThis.Zotero = Zotero;
  defineGlobal("window");
  defineGlobal("document");
  defineGlobal("ZoteroPane");
  defineGlobal("Zotero_Tabs");
}

function defineGlobal(name: string) {
  Object.defineProperty(_globalThis, name, {
    get() {
      const Zotero = _globalThis.Zotero;
      try {
        switch (name) {
          case "window":
            return Zotero.getMainWindow();
          case "document":
            return Zotero.getMainWindow()?.document;
          case "ZoteroPane":
            return Zotero.getActiveZoteroPane();
          case "Zotero_Tabs":
            return (Zotero.getMainWindow() as any)?.Zotero_Tabs;
          default:
            return (Zotero.getMainWindow() as any)?.[name];
        }
      } catch (e) {
        return undefined;
      }
    },
  });
}

main();
