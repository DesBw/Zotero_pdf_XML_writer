I forked this plugin thinking it would be a solid replacement to Jabref's XML writing feature. Turned out, it is very fragilee one. So, now, I am using javascript. 

````
// --- Helper: File System Read/Write (Zotero 6 & 7 compatible) ---
async function readFileBytes(path) {
    if (typeof IOUtils !== 'undefined' && IOUtils.read) {
        return await IOUtils.read(path);
    } else if (typeof OS !== 'undefined' && OS.File) {
        return await OS.File.read(path);
    }
    throw new Error('No compatible file system API found.');
}

async function writeFileBytes(path, bytes) {
    if (typeof IOUtils !== 'undefined' && IOUtils.write) {
        return await IOUtils.write(path, bytes);
    } else if (typeof OS !== 'undefined' && OS.File) {
        return await OS.File.writeAtomic(path, bytes);
    }
    throw new Error('No compatible file system API found.');
}

// Helper: Escape XML entities
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe).replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// Helper: Extract all authors/creators robustly across any Zotero format
function extractAuthors(item) {
    let list = [];
    let creators = [];

    if (typeof item.getCreatorsJSON === 'function') {
        creators = item.getCreatorsJSON() || [];
    }
    if (!creators.length && typeof item.getCreators === 'function') {
        creators = item.getCreators() || [];
    }

    for (let c of creators) {
        let first = (c.firstName || '').trim();
        let last = (c.lastName || c.name || '').trim();
        let fullName = '';

        if (first && last) {
            fullName = `${first} ${last}`;
        } else if (last) {
            fullName = last;
        } else if (first) {
            fullName = first;
        }

        if (fullName) list.push(fullName);
    }

    // Fallback: If array was empty, check item.firstCreator
    if (!list.length && item.firstCreator) {
        list.push(item.firstCreator.trim());
    }

    return list;
}

// Helper: Generate standard ISO/W3C XMP XML packet
function generateXmpXml({ title, authors, subject, keywords, date }) {
    const nowIso = new Date().toISOString();
    const authorsStr = authors.join('; ');
    const authorsSeqXml = authors.map(a => `<rdf:li>${escapeXml(a)}</rdf:li>`).join('\n        ');
    const keywordsXml = keywords.map(k => `<rdf:li>${escapeXml(k)}</rdf:li>`).join('\n        ');

    return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.4.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:format>application/pdf</dc:format>
   <dc:title>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li>
    </rdf:Alt>
   </dc:title>
   <dc:creator>
    <rdf:Seq>
        ${authorsSeqXml}
    </rdf:Seq>
   </dc:creator>
   <dc:description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${escapeXml(subject)}</rdf:li>
    </rdf:Alt>
   </dc:description>
   <dc:subject>
    <rdf:Bag>
        ${keywordsXml}
    </rdf:Bag>
   </dc:subject>
   <xmp:CreatorTool>Zotero</xmp:CreatorTool>
   <xmp:CreateDate>${escapeXml(date || nowIso)}</xmp:CreateDate>
   <xmp:ModifyDate>${nowIso}</xmp:ModifyDate>
   <xmp:MetadataDate>${nowIso}</xmp:MetadataDate>
   <pdf:Producer>Zotero</pdf:Producer>
   <pdf:Author>${escapeXml(authorsStr)}</pdf:Author>
   <pdf:Keywords>${escapeXml(keywords.join(', '))}</pdf:Keywords>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// --- 1. Load pdf-lib library into memory ---
if (typeof PDFLib === 'undefined') {
    const cdnUrls = [
        'https://cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js',
        'https://unpkg.com/pdf-lib/dist/pdf-lib.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'
    ];
    let loaded = false;
    let lastError = null;

    for (let url of cdnUrls) {
        try {
            let res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            let code = await res.text();
            let init = new Function(code);
            init.call(globalThis);
            if (typeof PDFLib !== 'undefined') {
                loaded = true;
                break;
            }
        } catch (e) {
            lastError = e;
        }
    }

    if (!loaded) {
        return `Failed to load pdf-lib: ${lastError ? lastError.message : 'Network error'}.`;
    }
}

// --- 2. Retrieve selected items ---
let pane = Zotero.getActiveZoteroPane();
let selectedItems = (pane && pane.getSelectedItems) ? pane.getSelectedItems() : [];

if (!selectedItems.length) {
    return 'Error: No items selected. Please select one or more items or PDF attachments in Zotero.';
}

let logs = [];
let processedCount = 0;

for (let item of selectedItems) {
    let attachments = [];
    let metadataItem = null;

    if (item.isRegularItem()) {
        metadataItem = item;
        let attIDs = item.getAttachments();
        for (let id of attIDs) {
            let att = await Zotero.Items.getAsync(id);
            if (att.isPDFAttachment()) attachments.push(att);
        }
    } else if (item.isAttachment() && item.isPDFAttachment()) {
        attachments.push(item);
        let parentID = item.parentItemID || item.parentID;
        if (parentID) {
            metadataItem = await Zotero.Items.getAsync(parentID);
        }
    }

    if (!metadataItem) {
        logs.push(`Skipped standalone attachment (no parent metadata item).`);
        continue;
    }

    if (!attachments.length) {
        logs.push(`No PDF attached to "${metadataItem.getField('title')}".`);
        continue;
    }

    // --- 3. Extract Metadata ---
    let title = metadataItem.getField('title') || '';
    let authors = extractAuthors(metadataItem);
    let authorString = authors.join('; ');
    let abstractNote = metadataItem.getField('abstractNote') || '';
    let tags = metadataItem.getTags().map(t => t.tag);
    let date = metadataItem.getField('date') || '';

    // --- 4. Write to PDF ---
    for (let att of attachments) {
        let filePath = await att.getFilePathAsync();
        if (!filePath) {
            logs.push(`Could not resolve file path for "${title}".`);
            continue;
        }

        try {
            let pdfBytes = await readFileBytes(filePath);
            let pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });

            // (A) Set Classic Info Dictionary
            if (title) pdfDoc.setTitle(title);
            if (authorString) pdfDoc.setAuthor(authorString);
            if (abstractNote) pdfDoc.setSubject(abstractNote);
            if (tags.length) pdfDoc.setKeywords(tags);
            pdfDoc.setProducer('Zotero');
            pdfDoc.setCreator('Zotero');
            pdfDoc.setModificationDate(new Date());

            // (B) Construct and Inject XMP XML Stream
            let xmpXml = generateXmpXml({
                title,
                authors,
                subject: abstractNote,
                keywords: tags,
                date
            });
            let xmpBytes = new TextEncoder().encode(xmpXml);

            let metadataStream = pdfDoc.context.stream(xmpBytes, {
                Type: 'Metadata',
                Subtype: 'XML'
            });
            let metadataStreamRef = pdfDoc.context.register(metadataStream);
            pdfDoc.catalog.set(PDFLib.PDFName.of('Metadata'), metadataStreamRef);

            // (C) Save & overwrite file
            let modifiedPdfBytes = await pdfDoc.save();
            await writeFileBytes(filePath, modifiedPdfBytes);

            processedCount++;
            logs.push(`✓ File: ${filePath.split(/[\/\\]/).pop()}\n   • Title: "${title}"\n   • Author(s) written: ${authors.length ? JSON.stringify(authors) : 'NONE (Empty in Zotero)'}`);
        } catch (err) {
            logs.push(`✗ Error on "${title}": ${err.message}`);
        }
    }
}

return `Processed ${processedCount} file(s).\n\nDetails:\n` + logs.join('\n');
````
