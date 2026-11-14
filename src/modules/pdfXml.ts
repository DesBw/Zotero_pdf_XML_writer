import { config } from "../../package.json";
import { PDFDocument, EncryptedPDFError } from "pdf-lib";
import { getString } from "../utils/locale";

/**
 * Default coalescing window. Zotero emits several `item` `modify`
 * notifications for a single metadata edit (and one per field), so raw events
 * are coalesced per item before any PDF is touched.
 */
const DEFAULT_DEBOUNCE_MS = 1500;

/** Hard cap of items handled per flush, so a huge batch stays interruptible. */
const MAX_BATCH = 200;

type ProgressLine = { text: string };

/**
 * Writes the parent item's Title/Author into the XML metadata (Info
 * dictionary) of its PDF attachments.
 *
 * Design notes (why this is not a straight loop in the notifier):
 * - Zotero awaits notifier callbacks, so doing file I/O there stalls the UI and
 *   item saving. Notification handling here only *queues* ids and returns.
 * - One worker at a time, with a yield between items, keeps the app responsive.
 * - Files whose Title/Author already match are not rewritten at all.
 */
export class PdfXmlFactory {
  private static notifierID: string | undefined;
  private static pending = new Set<number>();
  private static timer: ReturnType<typeof setTimeout> | undefined;
  private static running = false;
  /** True once shutdown started; in-flight work stops at the next item. */
  private static stopping = false;

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  /**
   * Register the item observer. The callback is intentionally synchronous and
   * cheap: it only enqueues ids.
   */
  static registerNotifier() {
    if (this.notifierID) {
      return;
    }
    const callback = {
      notify: (
        event: string,
        type: string,
        ids: number[] | string[],
        extraData: { [key: string]: any },
      ) => {
        try {
          if (!addon?.data.alive) {
            return;
          }
          if (type !== "item" || event !== "modify") {
            return;
          }
          // `extraData` is unused, but keeping the signature complete avoids
          // breaking on future Zotero versions that pass extra keys.
          void extraData;
          const itemIDs = (ids as (number | string)[])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id));
          if (itemIDs.length) {
            this.queue(itemIDs);
          }
        } catch (e) {
          Zotero.logError(e as Error);
        }
      },
    };
    this.notifierID = Zotero.Notifier.registerObserver(
      callback,
      ["item"],
      config.addonRef,
    );
  }

  static unregisterNotifier() {
    this.stopping = true;
    this.cancelPending();
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }
  }

  static registerPrefs() {
    const prefOptions = {
      pluginID: config.addonID,
      src: rootURI + "chrome/content/preferences.xhtml",
      label: getString("prefs-title"),
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
      defaultXUL: true,
    };
    ztoolkit.PreferencePane.register(prefOptions);
  }

  /* ------------------------------------------------------------------ *
   * Queueing
   * ------------------------------------------------------------------ */

  /** Debounced entry point used by the notifier. */
  static queue(ids: number[]) {
    if (!this.isAutoWriteEnabled()) {
      return;
    }
    for (const id of ids) {
      // Only parent items are interesting. Attachments, notes and annotations
      // are dropped here (cheaply, from the item cache) so that a file change
      // caused by our own write can never feed back into the queue.
      const item = Zotero.Items.get(id as number);
      if (!item || !item.isRegularItem()) {
        continue;
      }
      this.pending.add(id);
    }
    this.scheduleFlush();
  }

  private static scheduleFlush() {
    if (this.stopping || !this.pending.size) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.getDebounceMs()) as ReturnType<typeof setTimeout>;
  }

  /** Allow work to resume after a disable/re-enable cycle in one session. */
  static enable() {
    this.stopping = false;
  }

  /** Explicit entry point used by the context menu; bypasses the debounce. */
  static async writeNow(ids: number[]) {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // A manual command is an explicit user request; honour it even if the
    // automatic writer is switched off or shutting down.
    this.stopping = false;
    // Drop queued automatic work for the same items so they are not written
    // twice.
    for (const id of ids) {
      this.pending.delete(id);
    }
    await this.run(ids);
  }

  static cancelPending() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }

  private static async drain() {
    if (this.stopping || !this.pending.size) {
      return;
    }
    // A worker is already busy; it re-schedules itself when it finishes.
    if (this.running) {
      return;
    }
    const ids = Array.from(this.pending).slice(0, MAX_BATCH);
    for (const id of ids) {
      this.pending.delete(id);
    }
    await this.run(ids);
    // Anything that arrived while we worked is handled on the next tick of the
    // debounce timer, never in a tight loop.
    this.scheduleFlush();
  }

  private static async run(ids: number[]) {
    if (!ids.length || this.stopping) {
      return;
    }
    if (this.running) {
      // Queue behind the active worker rather than running two at once.
      for (const id of ids) {
        this.pending.add(id);
      }
      this.scheduleFlush();
      return;
    }
    this.running = true;
    const stats = { written: 0, unchanged: 0, skipped: 0, failed: 0 };
    try {
      const items = await Zotero.Items.getAsync(ids);
      for (const item of items) {
        if (this.stopping) {
          break;
        }
        const result = await this.writeItem(item as Zotero.Item);
        stats[result] += 1;
        // Hand the main thread back between documents so the UI keeps
        // painting even for large batches.
        await Zotero.Promise.delay(0);
      }
    } catch (e) {
      Zotero.logError(e as Error);
    } finally {
      this.running = false;
      if (stats.written || stats.failed || stats.skipped) {
        Zotero.debug(
          `${config.addonName}: ${stats.written} PDF(s) updated, ` +
            `${stats.unchanged} already up to date, ${stats.skipped} skipped, ` +
            `${stats.failed} failed`,
        );
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Core work
   * ------------------------------------------------------------------ */

  private static async writeItem(
    item: Zotero.Item,
  ): Promise<"written" | "unchanged" | "skipped" | "failed"> {
    if (!item || !item.isRegularItem() || item.deleted) {
      return "skipped";
    }

    const title = ((item.getField("title") as string) || "").trim();
    const author = ((item.getField("firstCreator") as string) || "").trim();

    let attachments: Zotero.Item[];
    try {
      const best = await item.getBestAttachments();
      attachments = (best || []).filter(
        (att) =>
          att.isPDFAttachment?.() ||
          att.attachmentContentType === "application/pdf",
      );
    } catch (e) {
      Zotero.logError(e as Error);
      return "failed";
    }
    if (!attachments.length) {
      return "skipped";
    }

    let outcome: "written" | "unchanged" | "skipped" | "failed" = "skipped";
    for (const att of attachments) {
      const result = await this.writeAttachment(att, title, author);
      if (result === "failed") {
        outcome = "failed";
      } else if (result === "written" && outcome !== "failed") {
        outcome = "written";
      } else if (result === "unchanged" && outcome === "skipped") {
        outcome = "unchanged";
      }
    }
    return outcome;
  }

  private static async writeAttachment(
    att: Zotero.Item,
    title: string,
    author: string,
  ): Promise<"written" | "unchanged" | "skipped" | "failed"> {
    let path: string | false | undefined;
    try {
      path = await att.getFilePathAsync();
    } catch (e) {
      Zotero.logError(e as Error);
      return "failed";
    }
    // Stored, linked and sync-only-relevant attachments all resolve, or fail,
    // through getFilePathAsync(); false means "no local file right now".
    if (!path) {
      return "skipped";
    }

    let pdfDoc: PDFDocument;
    try {
      const bytes = await this.readFileBytes(path);
      pdfDoc = await PDFDocument.load(bytes, { updateMetadata: true });
    } catch (e) {
      if (e instanceof EncryptedPDFError) {
        // Encrypted PDFs cannot be rewritten; ignore them silently.
        return "skipped";
      }
      Zotero.logError(e as Error);
      return "failed";
    }

    const currentTitle = (pdfDoc.getTitle() || "").trim();
    const currentAuthor = (pdfDoc.getAuthor() || "").trim();
    if (
      (!title || currentTitle === title) &&
      (!author || currentAuthor === author)
    ) {
      return "unchanged";
    }

    try {
      if (title) {
        pdfDoc.setTitle(title);
      }
      if (author) {
        pdfDoc.setAuthor(author);
      }
      const bytes = await pdfDoc.save();
      await this.writeFileBytes(path, bytes);
      return "written";
    } catch (e) {
      Zotero.logError(e as Error);
      return "failed";
    }
  }

  /* ------------------------------------------------------------------ *
   * File helpers (IOUtils when available, Zotero.File as fallback)
   * ------------------------------------------------------------------ */

  private static async readFileBytes(path: string): Promise<Uint8Array> {
    const io = (globalThis as any).IOUtils;
    if (io?.read) {
      return (await io.read(path)) as Uint8Array;
    }
    // `getBinaryContentsAsync` returns a byte-string; converting it once here is
    // still far cheaper than the previous ascii round-trip through Buffer.
    const data = (await Zotero.File.getBinaryContentsAsync(path)) as string;
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      bytes[i] = data.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  private static async writeFileBytes(path: string, bytes: Uint8Array) {
    const io = (globalThis as any).IOUtils;
    if (io?.write) {
      // Atomic write: keep the original intact if we die mid-write.
      await io.write(path, bytes, {
        tmpPath: `${path}.${config.addonRef}.tmp`,
      });
      return;
    }
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    await Zotero.File.putContentsAsync(path, buffer as ArrayBuffer);
  }

  /* ------------------------------------------------------------------ *
   * Preferences / UI helpers
   * ------------------------------------------------------------------ */

  private static isAutoWriteEnabled(): boolean {
    const value = Zotero.Prefs.get(`${config.prefsPrefix}.autoWrite`, true);
    return value === undefined ? true : Boolean(value);
  }

  private static getDebounceMs(): number {
    const value = Number(
      Zotero.Prefs.get(`${config.prefsPrefix}.debounceMs`, true),
    );
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEBOUNCE_MS;
  }

  /** Best-effort, non-blocking status toast. Never throws. */
  static notify(lines: ProgressLine[], header = config.addonName) {
    try {
      const pw = new ztoolkit.ProgressWindow(header, {
        closeOnClick: true,
        closeTime: 4000,
      });
      for (const line of lines) {
        pw.createLine({ text: line.text });
      }
      pw.show();
    } catch (e) {
      Zotero.debug(`${config.addonName}: could not show progress window`);
      Zotero.logError(e as Error);
    }
  }
}
