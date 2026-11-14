/**
 * Bootstrap for Zotero 8, 9 and 10 (still loads on Zotero 7).
 *
 * Why this file was reworked:
 * - Mozilla's JSMs became ES modules. `resource://gre/modules/Services.jsm` no
 *   longer exists, and importing it throws — which used to abort `startup()`.
 *   `Services` is now resolved defensively (global → .sys.mjs → legacy .jsm).
 * - Every hook is wrapped so a failure is logged instead of thrown. A throwing
 *   `startup()` makes Zotero treat the plugin as broken, which is one way a
 *   plugin "disappears" after a restart.
 */

if (typeof Zotero == "undefined") {
  var Zotero;
}

var chromeHandle;
var windowListener;

/** Resolve the Services module across Zotero 7 / 8+ / 10. */
function getServices() {
  try {
    if (typeof Services != "undefined") {
      return Services;
    }
  } catch (e) {
    /* fall through */
  }
  try {
    if (typeof ChromeUtils != "undefined" && ChromeUtils.importESModule) {
      const mod = ChromeUtils.importESModule(
        "resource://gre/modules/Services.sys.mjs",
      );
      if (mod?.Services) {
        return mod.Services;
      }
    }
  } catch (e) {
    /* fall through */
  }
  try {
    const mod = ChromeUtils.import("resource://gre/modules/Services.jsm");
    if (mod?.Services) {
      return mod.Services;
    }
  } catch (e) {
    /* give up */
  }
  return undefined;
}

/**
 * Resolve once the global `Zotero` object exists. Never rejects and never
 * blocks startup for longer than a few seconds.
 */
async function waitForZotero() {
  if (typeof Zotero != "undefined" && Zotero) {
    return;
  }
  const Services = getServices();
  await new Promise((resolve) => {
    let resolved = false;
    let timeout;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve();
    };
    // Never hang plugin startup waiting for a window.
    timeout = setTimeout(finish, 5000);

    try {
      const wins = Services.wm.getEnumerator("navigator:browser");
      while (wins.hasMoreElements()) {
        const win = wins.getNext();
        if (win && win.Zotero) {
          Zotero = win.Zotero;
          finish();
          return;
        }
      }
    } catch (e) {
      Zotero?.debug?.(`[write-pdf-xml] window enumeration failed: ${e}`);
    }

    try {
      windowListener = {
        onOpenWindow: function (aWindow) {
          let domWindow;
          try {
            domWindow = aWindow
              .QueryInterface(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIDOMWindow);
          } catch (e) {
            return;
          }
          domWindow.addEventListener(
            "load",
            async function onLoad() {
              domWindow.removeEventListener("load", onLoad, false);
              if (
                (typeof Zotero == "undefined" || !Zotero) &&
                domWindow.Zotero
              ) {
                Zotero = domWindow.Zotero;
                finish();
              } else if (
                domWindow.location.href ===
                "chrome://zotero/content/zoteroPane.xhtml"
              ) {
                // Only fires for windows re-opened after startup.
                try {
                  await Zotero?.__addonInstance__?.hooks?.onMainWindowLoad?.(
                    domWindow,
                  );
                } catch (e) {
                  Zotero?.logError?.(e);
                }
              }
            },
            false,
          );
        },
        onCloseWindow: function (aWindow) {
          try {
            const domWindow = aWindow
              .QueryInterface(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIDOMWindow);
            if (
              domWindow.location.href ===
              "chrome://zotero/content/zoteroPane.xhtml"
            ) {
              Zotero?.__addonInstance__?.hooks?.onMainWindowUnload?.(domWindow);
            }
          } catch (e) {
            Zotero?.logError?.(e);
          }
        },
      };
      Services.wm.addListener(windowListener);
    } catch (e) {
      Zotero?.debug?.(`[write-pdf-xml] window listener failed: ${e}`);
      finish();
    }
  });
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  const Services = getServices();
  try {
    await waitForZotero();
    await Zotero.initializationPromise;

    // String 'rootURI' was introduced in Zotero 7
    if (!rootURI) {
      rootURI = resourceURI.spec;
    }

    if (!Services) {
      throw new Error("Services module is unavailable");
    }

    const aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "__addonRef__", rootURI + "chrome/content/"],
    ]);

    /**
     * Globals for the plugin sandbox. `_globalThis` is its root object.
     */
    const ctx = {
      rootURI,
      Services,
      Zotero,
    };
    ctx._globalThis = ctx;

    Services.scriptloader.loadSubScript(
      `${rootURI}/chrome/content/scripts/__addonRef__.js`,
      ctx,
    );
  } catch (e) {
    // Log instead of throwing: a throwing startup gets the addon disabled.
    try {
      Zotero?.logError?.(e);
      Zotero?.debug?.(`[write-pdf-xml] startup failed: ${e}\n${e?.stack}`);
    } catch (inner) {
      /* nothing else we can do */
    }
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  const Services = getServices();
  try {
    if (windowListener) {
      Services?.wm?.removeListener(windowListener);
      windowListener = null;
    }
  } catch (e) {
    /* listener may never have been added */
  }

  try {
    if (typeof Zotero == "undefined" || !Zotero) {
      Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
        Components.interfaces.nsISupports,
      ).wrappedJSObject;
    }
    Zotero?.__addonInstance__?.hooks?.onShutdown?.();
  } catch (e) {
    try {
      Zotero?.logError?.(e);
    } catch (inner) {
      /* ignore */
    }
  }

  try {
    Cc["@mozilla.org/intl/stringbundle;1"]
      .getService(Components.interfaces.nsIStringBundleService)
      .flushBundles();
  } catch (e) {
    /* non-fatal */
  }

  try {
    Cu.unload(`${rootURI}/chrome/content/scripts/__addonRef__.js`);
  } catch (e) {
    /* non-fatal */
  }

  if (chromeHandle) {
    try {
      chromeHandle.destruct();
    } catch (e) {
      /* non-fatal */
    }
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
