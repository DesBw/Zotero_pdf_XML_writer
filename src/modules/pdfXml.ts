import { config } from "../../package.json";
import { PDFDocument, EncryptedPDFError } from "pdf-lib";
import { notify } from "./zoteroAPI";

/**
 * Default coalescing window. Zotero emits several `item` `modify`
 * notifications for a single metadata edit, so raw events are coalesced per
 * item before any PDF is touched.
 */
const DEFAULT_DEBOUNCE_MS = 1500;

/** Hard cap of items handled per flush, so a huge batch stays interruptible. */
const MAX_BATCH = 200;

/** Per-item outcome, reported to the user so nothing fails silently. */
type Result =
  | "written"
  | "unchanged"
  | "no-attachment"
  | "no-file"
  | "encrypted"
  | "failed";

interface Report {
  written: number;
  unchanged: number;
  noAttachment: number;
  noFile: number;
  encrypted: number;
  failed: number;
  errors: string[];
}

const emptyReport = (): Report => ({
  written: 0,
  unchanged: 0,
  noAttachment: 0,
  noFile: 0,
  encrypted: 0,
  failed: 0,
  errors: [],
});

/**
 * Writes the parent item's Title/Author into the XML metadata (Info
 * dictionary) of its PDF attachments.
 *
 * - The notifier only queues ids; file I/O never blocks item saving.
 * - One worker at a time, yielding between items, keeps the UI responsive.
 * - PDFs whose Title/Author already match are not rewritten.
 */
export class PdfXmlFactory {
  private static notifierID: string | undefined;
  private static pending = new Set<number>();
  private static timer: ReturnType<typeof setTimeout> | undefined;
  private static running = false;
  private static stopping = false;
  /** Number of times the notifier fired, for diagnostics. */
  private static notifyCount = 0;

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

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
          void extraData;
          const itemIDs = (ids as (number | string)[])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id));
          if (!itemIDs.length) {
            return;
          }
          this.notifyCount++;
          Zotero.debug(
            `${config.addonName}: notify #${
              this.notifyCount
            } modify item ${itemIDs.join(",")}`,
          );
          this.queue(itemIDs);
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
    Zotero.debug(
      `${config.addonName}: notifier registered (${
        this.notifierID
      }), auto-write ${this.isAutoWriteEnabled() ? "on" : "off"}`,
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

  /* ------------------------------------------------------------------ *
   * Queueing
   * ------------------------------------------------------------------ */

  /** Debounced entry point used by the notifier. */
  static queue(ids: number[]) {
    if (!this.isAutoWriteEnabled()) {
      Zotero.debug(`${config.addonName}: auto-write disabled, ignoring`);
      return;
    }
    for (const id of ids) {
      // Attachment/note ids are dropped early: only parents have metadata and
      // this also prevents our own file write from feeding back into the queue.
      const item = Zotero.Items.get(id);
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

  /** Explicit entry point used by the menu; bypasses the debounce. */
  static async writeNow(ids: number[]): Promise<Report> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopping = false;
    for (const id of ids) {
      this.pending.delete(id);
    }
    return this.run(ids);
  }

  static cancelPending() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }

  private static async drain() {
    if (this.stopping || !this.pending.size || this.running) {
      return;
    }
    const ids = Array.from(this.pending).slice(0, MAX_BATCH);
    for (const id of ids) {
      this.pending.delete(id);
    }
    const report = await this.run(ids);
    // Automatic writes stay quiet unless something went wrong.
    if (report.failed && report.errors.length) {
      notify(`Write PDF XML failed: ${report.errors[0]}`);
    } else if (report.written) {
      Zotero.debug(`${config.addonName}: auto-wrote ${report.written} PDF(s)`);
    }
    this.scheduleFlush();
  }

  private static async run(ids: number[]): Promise<Report> {
    const report = emptyReport();
    if (!ids.length || this.stopping) {
      return report;
    }
    if (this.running) {
      for (const id of ids) {
        this.pending.add(id);
      }
      this.scheduleFlush();
      return report;
    }
    this.running = true;
    try {
      const items = await Zotero.Items.getAsync(ids);
      for (const item of items) {
        if (this.stopping) {
          break;
        }
        let result: Result;
        try {
          result = await this.writeItem(item as Zotero.Item, report);
        } catch (e) {
          result = "failed";
          report.errors.push(this.describe(e));
        }
        this.count(report, result);
        await Zotero.Promise.delay(0);
      }
    } catch (e) {
      report.failed++;
      report.errors.push(this.describe(e));
      Zotero.logError(e as Error);
    } finally {
      this.running = false;
      Zotero.debug(
        `${config.addonName}: ${report.written} written, ${report.unchanged} unchanged, ` +
          `${report.noAttachment} without PDF, ${report.noFile} file missing, ` +
          `${report.encrypted} encrypted, ${report.failed} failed` +
          (report.errors.length ? ` — ${report.errors.join("; ")}` : ""),
      );
    }
    return report;
  }

  private static count(report: Report, result: Result) {
    switch (result) {
      case "written":
        report.written++;
        break;
      case "unchanged":
        report.unchanged++;
        break;
      case "no-attachment":
        report.noAttachment++;
        break;
      case "no-file":
        report.noFile++;
        break;
      case "encrypted":
        report.encrypted++;
        break;
      case "failed":
        report.failed++;
        break;
    }
  }

  private static describe(e: unknown): string {
    if (e instanceof Error) {
      return e.message;
    }
    return String(e);
  }

  /* ------------------------------------------------------------------ *
   * Core work
   * ------------------------------------------------------------------ */

  private static async writeItem(
    item: Zotero.Item,
    report: Report,
  ): Promise<Result> {
    if (!item || !item.isRegularItem() || item.deleted) {
      return "unchanged";
    }

    const title = String(item.getField("title") ?? "").trim();
    const author = String(item.getField("firstCreator") ?? "").trim();

    let attachments: Zotero.Item[] = [];
    try {
      // `getBestAttachments` is DB-backed and only returns real child items.
      attachments = ((await item.getBestAttachments?.()) ??
        []) as Zotero.Item[];
    } catch (e) {
      report.errors.push(`${item.id}: ${this.describe(e)}`);
    }
    const pdfs = attachments.filter(
      (att) =>
        att &&
        (att.isPDFAttachment?.() ||
          att.attachmentContentType === "application/pdf"),
    );
    if (!pdfs.length) {
      return "no-attachment";
    }

    let outcome: Result = "unchanged";
    for (const att of pdfs) {
      const result = await this.writeAttachment(att, title, author, report);
      if (result === "written") {
        outcome = "written";
      } else if (outcome === "unchanged" && result !== "unchanged") {
        outcome = result;
      }
    }
    return outcome;
  }

  private static async writeAttachment(
    att: Zotero.Item,
    title: string,
    author: string,
    report: Report,
  ): Promise<Result> {
    let path: string | false | undefined;
    try {
      path = await att.getFilePathAsync();
    } catch (e) {
      report.errors.push(`attachment ${att.id}: ${this.describe(e)}`);
      return "failed";
    }
    if (!path) {
      // Stored-but-not-downloaded, or a linked file that moved.
      Zotero.debug(
        `${config.addonName}: attachment ${att.id} has no local file`,
      );
      return "no-file";
    }

    let pdfDoc: PDFDocument;
    try {
      const bytes = await this.readFileBytes(path);
      pdfDoc = await PDFDocument.load(bytes, { updateMetadata: true });
    } catch (e) {
      if (e instanceof EncryptedPDFError) {
        // Publisher PDFs are frequently encrypted. Metadata is encrypted too,
        // so a rewrite is not possible; report it rather than hiding it.
        Zotero.debug(`${config.addonName}: attachment ${att.id} is encrypted`);
        return "encrypted";
      }
      report.errors.push(`attachment ${att.id}: ${this.describe(e)}`);
      Zotero.logError(e as Error);
      return "failed";
    }

    const currentTitle = (pdfDoc.getTitle() ?? "").trim();
    const currentAuthor = (pdfDoc.getAuthor() ?? "").trim();
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
      Zotero.debug(`${config.addonName}: wrote attachment ${att.id} (${path})`);
      return "written";
    } catch (e) {
      report.errors.push(`attachment ${att.id}: ${this.describe(e)}`);
      Zotero.logError(e as Error);
      return "failed";
    }
  }

  /* ------------------------------------------------------------------ *
   * File helpers
   * ------------------------------------------------------------------ */

  /**
   * Resolve Mozilla's IOUtils. Inside an XPI the plugin runs from a jar: URI and
   * `IOUtils` is not always reachable from the sandbox, so several fallbacks are
   * tried in order of preference.
   */
  private static getIOUtils(): any {
    const candidates: Array<() => any> = [
      () => (globalThis as any).IOUtils,
      () => (Zotero.getMainWindow() as any)?.IOUtils,
      () => (Zotero as any).IOUtils,
    ];
    for (const get of candidates) {
      try {
        const io = get();
        if (io?.read && io?.write) {
          return io;
        }
      } catch (e) {
        /* try the next source */
      }
    }
    return undefined;
  }

  private static async readFileBytes(path: string): Promise<Uint8Array> {
    const io = this.getIOUtils();
    if (io?.read) {
      return (await io.read(path)) as Uint8Array;
    }
    // Fallback for older/newer platforms without a reachable IOUtils.
    const data = (await Zotero.File.getBinaryContentsAsync(path)) as string;
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      bytes[i] = data.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  private static async writeFileBytes(path: string, bytes: Uint8Array) {
    const io = this.getIOUtils();
    if (io?.write) {
      // Atomic write: the original stays intact if we die mid-write.
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
   * Preferences
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

  /** Human-readable one-line summary of a batch, for the menu command. */
  static summarize(report: Report): string {
    const parts: string[] = [];
    if (report.written) {
      parts.push(`${report.written} updated`);
    }
    if (report.unchanged) {
      parts.push(`${report.unchanged} already current`);
    }
    if (report.noAttachment) {
      parts.push(`${report.noAttachment} without PDF`);
    }
    if (report.noFile) {
      parts.push(`${report.noFile} file missing`);
    }
    if (report.encrypted) {
      parts.push(`${report.encrypted} encrypted`);
    }
    if (report.failed) {
      parts.push(`${report.failed} failed`);
    }
    if (!parts.length) {
      return "nothing to do";
    }
    const summary = parts.join(", ");
    if (report.errors.length) {
      return `${summary} — ${report.errors[0]}`;
    }
    return summary;
  }
}
