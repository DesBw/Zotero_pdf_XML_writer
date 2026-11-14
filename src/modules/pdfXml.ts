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
  /** Hard failures, shown in the summary. */
  errors: string[];
  /** Non-fatal reasons a PDF was skipped (missing file, not downloaded). */
  notes: string[];
}

const emptyReport = (): Report => ({
  written: 0,
  unchanged: 0,
  noAttachment: 0,
  noFile: 0,
  encrypted: 0,
  failed: 0,
  errors: [],
  notes: [],
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
    let queued = 0;
    for (const id of ids) {
      const item = Zotero.Items.get(id);
      if (!item) {
        continue;
      }
      if (item.isRegularItem()) {
        this.pending.add(id);
        queued++;
        continue;
      }
      if (item.isAttachment?.() && this.isPDF(item)) {
        if (!item.parentID) {
          // A standalone PDF has its own title/author.
          this.pending.add(id);
          queued++;
          continue;
        }
        Zotero.debug(
          `${config.addonName}: attachment ${id} changed; its PDF is written from parent ${item.parentID}, not from the attachment`,
        );
        continue;
      }
      Zotero.debug(
        `${config.addonName}: notify for ${id} ignored (${
          item.isAttachment?.()
            ? "non-PDF attachment"
            : "not an item with metadata"
        })`,
      );
    }
    if (!queued) {
      Zotero.debug(
        `${config.addonName}: nothing queued from this notification`,
      );
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

  /**
   * Explicit entry point used by the menu; bypasses the debounce.
   *
   * `attachmentIds` carries PDFs the user selected directly. They have no
   * metadata of their own, so they are written using their parent's fields.
   */
  static async writeNow(
    ids: number[],
    attachmentIds: number[] = [],
  ): Promise<Report> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopping = false;
    for (const id of ids) {
      this.pending.delete(id);
    }
    return this.run(ids, attachmentIds);
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
      notify(`write failed: ${report.errors[0]}`);
    } else if (report.written) {
      Zotero.debug(`${config.addonName}: auto-wrote ${report.written} PDF(s)`);
    }
    this.scheduleFlush();
  }

  private static async run(
    ids: number[],
    attachmentIds: number[] = [],
  ): Promise<Report> {
    const report = emptyReport();
    if ((!ids.length && !attachmentIds.length) || this.stopping) {
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
      if (attachmentIds.length) {
        await this.writeSelection(attachmentIds, report);
      }
      const items = ids.length ? await Zotero.Items.getAsync(ids) : [];
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

  /**
   * Write PDFs the user selected directly, using their parent item's fields.
   * A top-level (standalone) attachment is written from its own fields.
   */
  private static async writeSelection(
    attachmentIds: number[],
    report: Report,
  ): Promise<void> {
    const attachments = await Zotero.Items.getAsync(attachmentIds);
    for (const att of attachments) {
      if (this.stopping) {
        return;
      }
      if (!att || !att.isAttachment?.()) {
        continue;
      }
      if (att.attachmentContentType !== "application/pdf") {
        Zotero.debug(
          `${config.addonName}: selection ${att.id} is not a PDF (${att.attachmentContentType})`,
        );
        this.count(report, "no-attachment");
        continue;
      }
      const parent = att.parentID ? Zotero.Items.get(att.parentID) : null;
      const source = parent ?? att;
      const title = String(source.getField?.("title") ?? "").trim();
      const author = String(source.getField?.("firstCreator") ?? "").trim();
      Zotero.debug(
        `${config.addonName}: direct selection ${att.id} from ${
          parent ? `parent ${parent.id}` : "the file's own fields"
        }`,
      );
      this.count(
        report,
        await this.writeAttachment(att, title, author, report),
      );
      await Zotero.Promise.delay(0);
    }
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
      Zotero.debug(
        `${config.addonName}: item ${item.id} has ${
          attachments.length
        } attachment(s), none of them PDFs${
          attachments.length
            ? ` (${attachments
                .map((a) => a.attachmentContentType || "unknown")
                .join(", ")})`
            : ""
        }`,
      );
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
      // getFilePathAsync() gives no reason for a linked file, so work it out.
      path = await this.resolveLinkedPath(att);
    }
    if (!path) {
      const reason = this.describeMissingFile(att);
      report.notes.push(reason);
      Zotero.debug(`${config.addonName}: ${reason}`);
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
    const titleMatches = !title || currentTitle === title;
    const authorMatches = !author || currentAuthor === author;
    if (titleMatches && authorMatches) {
      Zotero.debug(
        `${config.addonName}: attachment ${att.id} already has title/author matching the item`,
      );
      return "unchanged";
    }
    Zotero.debug(
      `${config.addonName}: attachment ${att.id} title ${JSON.stringify(
        currentTitle,
      )} -> ${JSON.stringify(title)}, author ${JSON.stringify(
        currentAuthor,
      )} -> ${JSON.stringify(author)}`,
    );

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
   * Linked-file resolution
   * ------------------------------------------------------------------ */

  /** True when the attachment is a PDF. */
  private static isPDF(item: Zotero.Item): boolean {
    return Boolean(
      item?.isPDFAttachment?.() ||
        item?.attachmentContentType === "application/pdf",
    );
  }

  /** Short, human-readable reason a PDF could not be reached. */
  private static describeMissingFile(att: Zotero.Item): string {
    const attachments = (Zotero as any).Attachments;
    const linkedFile = attachments?.LINK_MODE_LINKED_FILE ?? 2;
    const placeholder = attachments?.BASE_PATH_PLACEHOLDER ?? "attachments:";
    const rawPath = String(att.attachmentPath ?? "");
    if (att.attachmentLinkMode === linkedFile) {
      if (rawPath.startsWith(placeholder)) {
        let basePath = "";
        try {
          basePath = String(Zotero.Prefs.get("baseAttachmentPath") ?? "");
        } catch (e) {
          basePath = "";
        }
        return basePath
          ? `linked file not found under the base directory (${basePath})`
          : "linked file uses the base directory, which is not set";
      }
      return `linked file not found (${rawPath || "no path stored"})`;
    }
    return "attachment is not downloaded yet";
  }

  /**
   * Work out where a linked attachment actually lives, and say why when it
   * cannot be found.
   *
   * `getFilePathAsync()` collapses every linked-file problem into `false` —
   * no base directory, a stale relative path, a moved file — and only logs a
   * `Zotero.debug(..., 2)` that is invisible at default verbosity. Since a
   * library of linked PDFs is the common case, each step is retried here and
   * the specific reason is logged.
   */
  private static async resolveLinkedPath(
    att: Zotero.Item,
  ): Promise<string | undefined> {
    const linkMode = att.attachmentLinkMode;
    const rawPath = String(att.attachmentPath ?? "");
    const attachments = (Zotero as any).Attachments;
    const linkedFile = attachments?.LINK_MODE_LINKED_FILE ?? 2;
    const linkedURL = attachments?.LINK_MODE_LINKED_URL ?? 3;
    const label = `${config.addonName}: attachment ${
      att.id
    } (linkMode ${linkMode}, path ${JSON.stringify(rawPath)})`;

    if (linkMode === linkedURL) {
      Zotero.debug(`${label}: linked URL, there is no file to write`);
      return undefined;
    }
    if (!rawPath) {
      Zotero.debug(`${label}: attachment has no stored path`);
      return undefined;
    }

    const candidates: string[] = [];
    const placeholder = attachments?.BASE_PATH_PLACEHOLDER ?? "attachments:";
    if (rawPath.startsWith(placeholder)) {
      let basePath: string | undefined;
      try {
        basePath = String(Zotero.Prefs.get("baseAttachmentPath") ?? "");
      } catch (e) {
        basePath = "";
      }
      if (!basePath) {
        Zotero.debug(
          `${label}: uses the relative base directory, but no "Linked Attachment Base Directory" is set in Zotero's preferences`,
        );
      } else {
        const relative = rawPath.slice(placeholder.length);
        Zotero.debug(`${label}: relative to base directory ${basePath}`);
        try {
          const resolved = attachments?.resolveRelativePath?.(rawPath);
          if (resolved) {
            candidates.push(resolved);
          }
        } catch (e) {
          /* fall through to the manual join below */
        }
        const sep =
          basePath.includes("\\") || /^[A-Za-z]:/.test(basePath) ? "\\" : "/";
        const trimmed = basePath.replace(/[\\/]+$/, "");
        candidates.push(
          `${trimmed}${sep}${relative
            .replace(/^[\\/]+/, "")
            .replace(/[\\/]+/g, sep)}`,
        );
      }
    } else if (linkMode === linkedFile) {
      // A plain absolute path for a linked file.
      candidates.push(rawPath);
    }

    if (!candidates.length) {
      Zotero.debug(`${label}: could not build any candidate path`);
      return undefined;
    }

    let io: any;
    try {
      io = this.getIOUtils();
    } catch (e) {
      io = undefined;
    }
    for (const candidate of candidates) {
      let exists = false;
      try {
        if (io?.exists) {
          exists = await io.exists(candidate);
        } else {
          // No IOUtils: let the read itself be the test.
          exists = true;
        }
      } catch (e) {
        exists = false;
      }
      if (exists) {
        Zotero.debug(`${label}: resolved to ${candidate}`);
        return candidate;
      }
      Zotero.debug(`${label}: not found at ${candidate}`);
    }
    Zotero.debug(
      `${label}: the file is missing — for a linked attachment, this usually means it was moved, renamed or deleted outside Zotero`,
    );
    return undefined;
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
    if (!report.written && report.notes.length) {
      // Nothing was written: the reason matters more than the counts.
      return `${summary} — ${report.notes[0]}`;
    }
    return summary;
  }
}
