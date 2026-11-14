# Diagnosing "it does not write"

The plugin logs every decision. Before changing anything, get the log:

1. **Help → Debug Output Logging → Enable Output Logging**
2. Right-click one of the problem items → **Write PDF XML**
3. Wait a second, then **Help → Debug Output Logging → View Output**
4. Filter for `Write PDF XML:` and copy those lines.

Every run ends with a summary such as:

```
Write PDF XML: 2 written, 0 unchanged, 0 without PDF, 1 file missing, 0 encrypted, 0 failed
```

and each PDF gets its own line explaining what happened:

```
Write PDF XML: attachment 11 title "old" -> "Linked Paper", author "old" -> "Doe, Jane"
Write PDF XML: wrote attachment 11 (/home/me/Papers/paper.pdf)
Write PDF XML: attachment 13 (linkMode 2, path "/home/me/Papers/gone.pdf"): not found at /home/me/Papers/gone.pdf
```

## Reading the outcomes

| Log says                                                | Meaning                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `wrote attachment N`                                    | The PDF's Title/Author were replaced. Done.                                                              |
| `already has title/author matching the item`            | Nothing to change — the PDF already matched.                                                             |
| `two lines ignored … non-PDF attachment`                | You triggered the write from a note/snapshot row; use the parent item or its PDF.                        |
| `has N attachment(s), none of them PDFs`                | The item's children are snapshots/notes, or the PDF was never attached.                                  |
| `linked file not found …`                               | The linked path does not resolve to a file. See below.                                                   |
| `linked file uses the base directory, which is not set` | Set **Settings → General → Linked Attachment Base Directory**.                                           |
| `is encrypted`                                          | The PDF has an `/Encrypt` dictionary (very common for publisher PDFs). Its metadata cannot be rewritten. |
| `failed — <message>`                                    | A real error; the message is the thing to report.                                                        |

## Linked files specifically

Linked attachments store either an absolute path or a path relative to the
**Linked Attachment Base Directory**. Both are tried. When the file is not
found, the log shows every path that was attempted, because Zotero itself
returns a bare `false` with no explanation and the reason is usually one of:

- the PDF was moved or renamed outside Zotero;
- the base directory setting changed (or is unset) after the file was linked;
- the path uses a different drive/volume that is not mounted.

## Manual check

Run this in **Tools → Developer → Run JavaScript** with the item selected. It
reports what Zotero itself thinks about the attachment, independent of the
plugin:

```js
(async () => {
  const out = [];
  for (const item of Zotero.getActiveZoteroPane().getSelectedItems()) {
    out.push(`item ${item.id} regular=${item.isRegularItem()}`);
    const atts = item.isRegularItem()
      ? await item.getBestAttachments()
      : [item];
    for (const att of atts) {
      out.push(
        `  att ${att.id} type=${att.attachmentContentType} linkMode=${
          att.attachmentLinkMode
        } path=${JSON.stringify(att.attachmentPath)}`,
      );
      let p = false;
      try {
        p = await att.getFilePathAsync();
      } catch (e) {
        out.push(`     getFilePathAsync threw: ${e.message}`);
      }
      out.push(`     resolved: ${p || "(false — no local file)"}`);
    }
  }
  return out.join("\n");
})();
```

`Tools → Developer → Run JavaScript` returns the **last expression only** when
it is a promise resolving to a string; if it shows `undefined`, wrap the call
as `return (async () => …)()` and use the debug log instead.
