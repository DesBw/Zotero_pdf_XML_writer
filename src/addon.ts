import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    // Env type, see scripts/build.mjs
    env: "development" | "production";
    // Set once onStartup finishes; useful when checking plugin state by hand.
    initialized: boolean;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
    };
    dialog?: {
      window?: Window;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      env: __env__,
      initialized: false,
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
