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

/**
 * Copy a platform global onto the plugin's execution context.
 *
 * bootstrap.js is evaluated *inside* the plugin sandbox, so `IOUtils`,
 * `Localization`, `setTimeout`, ... are plain identifiers there. They are read
 * via a lookup table because a bare `globalThis[name]` does not see sandbox
 * globals in all Gecko versions.
 */
function platformGlobals() {
  const table = {};
  // The identifiers below are resolved in the bootstrap sandbox scope. Any that
  // do not exist throw, and are skipped.
  const names = [
    "IOUtils",
    "PathUtils",
    "Localization",
    "ChromeUtils",
    "Components",
    "Cc",
    "Ci",
    "Cu",
    "Cr",
    "Blob",
    "TextEncoder",
    "TextDecoder",
    "URL",
  ];
  for (const name of names) {
    try {
      table[name] = sandboxLookup(name);
    } catch (e) {
      /* not available on this version */
    }
  }
  return table;
}

/** Resolve an identifier that exists in the enclosing (sandbox) scope. */
function sandboxLookup(name) {
  // eslint-disable-next-line no-unused-vars
  switch (name) {
    case "IOUtils":
      return typeof IOUtils != "undefined" ? IOUtils : undefined;
    case "PathUtils":
      return typeof PathUtils != "undefined" ? PathUtils : undefined;
    case "Localization":
      return typeof Localization != "undefined" ? Localization : undefined;
    case "ChromeUtils":
      return typeof ChromeUtils != "undefined" ? ChromeUtils : undefined;
    case "Components":
      return typeof Components != "undefined" ? Components : undefined;
    case "Cc":
      return typeof Cc != "undefined" ? Cc : undefined;
    case "Ci":
      return typeof Ci != "undefined" ? Ci : undefined;
    case "Cu":
      return typeof Cu != "undefined" ? Cu : undefined;
    case "Cr":
      return typeof Cr != "undefined" ? Cr : undefined;
    case "Blob":
      return typeof Blob != "undefined" ? Blob : undefined;
    case "TextEncoder":
      return typeof TextEncoder != "undefined" ? TextEncoder : undefined;
    case "TextDecoder":
      return typeof TextDecoder != "undefined" ? TextDecoder : undefined;
    case "URL":
      return typeof URL != "undefined" ? URL : undefined;
    default:
      return undefined;
  }
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
    // The plugin bundle is executed with `ctx` as its global object. A plain
    // object does NOT inherit the sandbox globals (IOUtils, Localization,
    // setTimeout, ...), so the ones the plugin relies on are copied in
    // explicitly. Without this, file I/O silently falls back to APIs that may
    // not exist on newer Zotero versions.
    const ctx = Object.create(null);
    // `bootstrap.js` is evaluated inside the plugin sandbox, so these
    // identifiers resolve against the real platform globals. They are copied
    // onto `ctx` because `loadSubScript()` below uses `ctx` as the script's
    // global object, and a plain object inherits nothing.
    const globals = platformGlobals();
    for (const name of Object.keys(globals)) {
      if (typeof globals[name] != "undefined") {
        ctx[name] = globals[name];
      }
    }
    // Timer functions are plain sandbox globals, not objects.
    for (const name of [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ]) {
      try {
        // eslint-disable-next-line no-eval
        const fn = (0, eval)(name);
        if (typeof fn == "function") {
          ctx[name] = fn;
        }
      } catch (e) {
        /* not available */
      }
    }
    ctx.rootURI = rootURI;
    ctx.Services = Services;
    ctx.Zotero = Zotero;
    ctx._globalThis = ctx;

    const available = Object.keys(ctx).filter((k) => k != "_globalThis");
    Zotero.debug(`[write-pdf-xml] plugin scope: ${available.join(", ")}`);
    if (!ctx.IOUtils) {
      Zotero.debug("[write-pdf-xml] IOUtils unavailable in plugin scope");
    }

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
