# Zotero PDF Metadata

[![zotero target version](https://img.shields.io/badge/Zotero-10-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Plugins created with this template:

[![GitHub Repo stars](https://img.shields.io/github/stars/franzbischoff/zotero-pdf-metadata?label=zotero-pdf-metadata&style=flat-square)](https://github.com/franzbischoff/zotero-pdf-metadata)
[![GitHub Repo stars](https://img.shields.io/github/stars/windingwind/zotero-better-notes?label=zotero-better-notes&style=flat-square)](https://github.com/windingwind/zotero-better-notes)
[![GitHub Repo stars](https://img.shields.io/github/stars/windingwind/zotero-pdf-preview?label=zotero-pdf-preview&style=flat-square)](https://github.com/windingwind/zotero-pdf-preview)
[![GitHub Repo stars](https://img.shields.io/github/stars/windingwind/zotero-pdf-translate?label=zotero-pdf-translate&style=flat-square)](https://github.com/windingwind/zotero-pdf-translate)
[![GitHub Repo stars](https://img.shields.io/github/stars/windingwind/zotero-tag?label=zotero-tag&style=flat-square)](https://github.com/windingwind/zotero-tag)
[![GitHub Repo stars](https://img.shields.io/github/stars/iShareStuff/ZoteroTheme?label=zotero-theme&style=flat-square)](https://github.com/iShareStuff/ZoteroTheme)
[![GitHub Repo stars](https://img.shields.io/github/stars/MuiseDestiny/zotero-reference?label=zotero-reference&style=flat-square)](https://github.com/MuiseDestiny/zotero-reference)
[![GitHub Repo stars](https://img.shields.io/github/stars/MuiseDestiny/zotero-citation?label=zotero-citation&style=flat-square)](https://github.com/MuiseDestiny/zotero-citation)
[![GitHub Repo stars](https://img.shields.io/github/stars/MuiseDestiny/ZoteroStyle?label=zotero-style&style=flat-square)](https://github.com/MuiseDestiny/ZoteroStyle)
[![GitHub Repo stars](https://img.shields.io/github/stars/volatile-static/Chartero?label=Chartero&style=flat-square)](https://github.com/volatile-static/Chartero)
[![GitHub Repo stars](https://img.shields.io/github/stars/l0o0/tara?label=tara&style=flat-square)](https://github.com/l0o0/tara)
[![GitHub Repo stars](https://img.shields.io/github/stars/redleafnew/delitemwithatt?label=delitemwithatt&style=flat-square)](https://github.com/redleafnew/delitemwithatt)
[![GitHub Repo stars](https://img.shields.io/github/stars/redleafnew/zotero-updateifsE?label=zotero-updateifsE&style=flat-square)](https://github.com/redleafnew/zotero-updateifsE)
[![GitHub Repo stars](https://img.shields.io/github/stars/northword/zotero-format-metadata?label=zotero-format-metadata&style=flat-square)](https://github.com/northword/zotero-format-metadata)
[![GitHub Repo stars](https://img.shields.io/github/stars/inciteful-xyz/inciteful-zotero-plugin?label=inciteful-zotero-plugin&style=flat-square)](https://github.com/inciteful-xyz/inciteful-zotero-plugin)
[![GitHub Repo stars](https://img.shields.io/github/stars/MuiseDestiny/zotero-gpt?label=zotero-gpt&style=flat-square)](https://github.com/MuiseDestiny/zotero-gpt)
[![GitHub Repo stars](https://img.shields.io/github/stars/zoushucai/zotero-journalabbr?label=zotero-journalabbr&style=flat-square)](https://github.com/zoushucai/zotero-journalabbr)
[![GitHub Repo stars](https://img.shields.io/github/stars/MuiseDestiny/zotero-figure?label=zotero-figure&style=flat-square)](https://github.com/MuiseDestiny/zotero-figure)

## Features

This plugin is used to automatically update the attached PDF metadata from the reference entry on Zotero.

> ❗This is the opposite of retrieving metadata from PDFs or online databases, the objective is that the attachment metadata gets
> up-to-date with the reference entry.

Tested on Zotero 10. The manifest still allows Zotero 7 and later, but 10 is the
supported version.

### How it works

When a reference entry with an attached PDF is updated, the stored file doesn't get its metadata changed. Zotero only renames files according to the template in settings, example: `Author - Year - Title.pdf`. If you export the PDF, or a whole collection, the metadata will be outdated.

The plugin then updates the `Title` and `Author` fields of the PDF's XML
metadata (the PDF Info dictionary), triggered by a change to the reference entry.

You can also write the XML by hand: select one or more items in the items list,
right-click and choose **Write PDF XML** (also available under **Tools → Write
PDF XML**). That works on stored attachments,
linked files, and files that are only available locally through sync.

#### Behaviour worth knowing

- Edits are coalesced: after the last change the plugin waits `debounceMs`
  (1.5 s by default) and then writes, so changing several fields at once only
  writes each PDF once.
- PDFs whose Title/Author already match are not rewritten, so there is no disk
  churn and nothing is bumped when metadata did not change.
- Writing happens outside Zotero's notification callbacks, one item at a time,
  and the main thread is yielded between items. Large batches therefore do not
  freeze the UI.
- Encrypted PDFs are skipped.

### Settings

Settings live in **Tools → Settings → Write PDF XML**:

- **Write PDF XML automatically when an item is modified**
- **Delay before writing** — the coalescing window in milliseconds

Automatic writing is on by default; the context-menu command always works.

A practical usage is to use the exported PDFs in another tool, like creating embedded vectors for Document Retrieval Systems that may use the metadata to index the PDFs or explain the original reference entry.

### Troubleshooting

- **Verify the plugin loaded.** Open **Help → Debug Output Logging → View
  Output** and look for these lines, which are printed unconditionally:
  `Write PDF XML: bundle loaded`, `item menu registered (…)`, `startup complete`.
  If none appear, Zotero never started the plugin (check the version ceiling
  below). If `bundle loaded` appears but nothing else does, the following line
  reports what failed.
- **The plugin disappears after restarting Zotero.** The addon keeps an
  `update_url` in its manifest. If that URL still points at a build that does
  not support your Zotero version (the upstream Zotero 7 release, for example),
  Zotero replaces/refuses it on the next start. `npm run build` now generates
  `update.json`/`manifest.json` pointing at this repository, so publish the
  built `.xpi` as a release there before relying on auto-updates.
- **Diagnostics.** Turn on **Help → Debug Output Logging → View Output** and
  filter for `Write PDF XML:`. Every run reports a summary such as
  `2 written, 1 unchanged, 1 without PDF, 1 file missing, 0 encrypted, 1 failed`,
  plus a per-attachment line (`wrote attachment 101 (/path/file.pdf)`) or the
  exact reason it was skipped. The right-click command also shows this summary
  as a popup.
- **Common non-writes.** _file missing_ means the attachment has no local file
  (not downloaded, or a linked file that moved). _encrypted_ means the PDF
  carries an `/Encrypt` dictionary, which is common in publisher PDFs — their
  metadata cannot be rewritten. _without PDF_ means the item has no PDF child.

## Installation

### From the pre-built `.xpi` file

You can download the latest `.xpi` file from the [releases page](https://github.com/DesBw/Zotero_pdf_XML_writer/releases/latest/download/zotero-pdf-xml.xpi) and install it manually in Zotero. It will also auto-update when a new version is released.

### Build from Source

- Fork this repo;
- Git clone the forked repo;
- Enter the repo folder;
- Run `npm install` to install dependencies then `npm run build` to build the plugin;
- The `zotero-pdf-xml.xpi` file will be generated in the `build` folder;

## Next features

- [ ] Add more metadata fields to update, if any;
- [ ] Add a setting to choose which fields to update;
- [ ] Add an option to update all attachments in a collection;

## Icon

`assets/icon.svg` is the source for both packaged icons
(`addon/chrome/content/icons/favicon.png` at 32 px and
`favicon@0.5x.png` at 16 px). Re-render them after editing the SVG:

```bash
npm i --no-save @resvg/resvg-js   # if not already installed
node -e '
const { Resvg } = require("@resvg/resvg-js");
const fs = require("fs");
const svg = fs.readFileSync("assets/icon.svg", "utf8");
for (const [size, out] of [[32, "favicon.png"], [16, "favicon@0.5x.png"]]) {
  fs.writeFileSync("addon/chrome/content/icons/" + out,
    new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
}'
```

## Disclaimer

Use this code under AGPL. No warranties are provided. Keep the laws of your locality in mind!

If you want to change the license, please contact the author of the template used to build this plugin at <wyzlshx@foxmail.com>
