/**
 * File delivery that survives WKWebView.
 *
 * Three browser primitives the whole app leans on are dead inside the iOS
 * shell, and all three fail SILENTLY -- the button does nothing:
 *   - window.open(blobUrl, '_blank')  needs a WKUIDelegate, and blob: can't be
 *     handed to the system viewer anyway
 *   - <a download>.click()            needs a WKDownloadDelegate
 *   - window.print()                  is a no-op
 *
 * The native answer to all three is the same: put the bytes in a real file and
 * hand its URI to the iOS share sheet, which gives the user Print, Save to
 * Files, Open in..., Mail for free. Cache directory, so iOS reclaims it.
 *
 * Every function's WEB branch is the exact code that used to sit at the call
 * site, so web behaviour is unchanged. The Capacitor plugins are imported
 * dynamically inside the native branch only, keeping them out of the web bundle.
 */

import { IS_NATIVE } from './native';

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/* iOS derives the file type from the extension, not from the Blob's MIME type;
   a name without one previews as plain text. */
function ensureExtension(name: string, mime: string): string {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
  const ext = mime.includes('pdf') ? 'pdf'
    : mime.includes('html') ? 'html'
    : mime.includes('csv') ? 'csv'
    : mime.includes('spreadsheet') || mime.includes('excel') ? 'xlsx'
    : mime.includes('png') ? 'png'
    : mime.includes('jpeg') ? 'jpg'
    : 'bin';
  return `${name}.${ext}`;
}

async function shareBlob(blob: Blob, filename: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const name = ensureExtension(filename.replace(/[/\\:]+/g, '-'), blob.type);
  const { uri } = await Filesystem.writeFile({
    path: name,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
  });
  await Share.share({ title: name, files: [uri] });
}

/**
 * Deliver a generated file to the user: download on web, share sheet on native.
 */
export async function saveAndOpenBlob(blob: Blob, filename: string): Promise<void> {
  if (IS_NATIVE) {
    await shareBlob(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * View an already-created blob: URL. Native re-reads the bytes back out of it
 * (same-document blob: URLs are fetchable) because only a real file can reach
 * the system viewer.
 *
 * `features` mirrors whatever the call site passed to window.open so the web
 * path stays identical; `revokeAfterMs` keeps each site's existing cleanup.
 */
export async function openBlobUrl(
  objectUrl: string,
  filename: string,
  opts?: { features?: string; revokeAfterMs?: number },
): Promise<void> {
  if (IS_NATIVE) {
    const blob = await (await fetch(objectUrl)).blob();
    URL.revokeObjectURL(objectUrl);
    await shareBlob(blob, filename);
    return;
  }
  if (opts?.features) window.open(objectUrl, '_blank', opts.features);
  else window.open(objectUrl, '_blank');
  if (opts?.revokeAfterMs) setTimeout(() => URL.revokeObjectURL(objectUrl), opts.revokeAfterMs);
}

/** Open a real http(s) URL outside the app. */
export async function openExternalUrl(url: string): Promise<void> {
  if (IS_NATIVE) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/* Same-origin stylesheets only; a cross-origin sheet throws on .cssRules.
   @media print blocks are re-emitted unconditionally at the end so the shared
   snapshot looks like the printout (the app's print CSS hides the chrome) and
   not like a screenshot of the whole UI. */
function snapshotPrintableHtml(): string {
  const base: string[] = [];
  const printOnly: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[];
    try {
      rules = Array.from(sheet.cssRules);
    } catch {
      continue;
    }
    for (const rule of rules) {
      const media = (rule as CSSMediaRule).media;
      if (media && /\bprint\b/.test(media.mediaText) && !/\bscreen\b/.test(media.mediaText)) {
        printOnly.push(Array.from((rule as CSSMediaRule).cssRules).map((r) => r.cssText).join('\n'));
      } else {
        base.push(rule.cssText);
      }
    }
  }
  const title = document.title || 'Document';
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title><style>${base.join('\n')}\n${printOnly.join('\n')}</style>`
    + `</head><body>${document.body.innerHTML}</body></html>`;
}

/**
 * Print the current page. On native there is no print dialog, so the page is
 * frozen into a standalone HTML file and handed to the share sheet, whose
 * Print action is the iOS equivalent.
 */
export async function printPage(): Promise<void> {
  if (!IS_NATIVE) {
    window.print();
    return;
  }
  const name = `${(document.title || 'document').replace(/[^\w\- ]+/g, '').trim() || 'document'}.html`;
  await shareBlob(new Blob([snapshotPrintableHtml()], { type: 'text/html' }), name);
}
