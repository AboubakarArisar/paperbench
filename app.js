// Paperbench — every PDF operation runs in the browser; nothing is uploaded.

// From the Lemon Squeezy dashboard (Settings → Stores for the ID; the product's URL for its ID; Product → Share for the link).
// These are public values, not secrets. TEST MODE: this product was made in test mode. Copying it to live mode
// gives it a new product ID and checkout link, so update both when the store goes live.
const LEMON = {
  checkout: 'https://dastakhat.lemonsqueezy.com/checkout/buy/1dd3f45c-8665-4b7e-8446-51a2aeb26173',
  storeId: 415628,
  productId: 1516455,
};

// True only for an active key that belongs to *our* product (stops keys from other Lemon Squeezy stores working).
function isProResponse(r, cfg = LEMON) {
  return !!(r && r.valid !== false && r.license_key && r.license_key.status === 'active' &&
    r.meta && r.meta.store_id === cfg.storeId && r.meta.product_id === cfg.productId && cfg.storeId);
}

// "1-3, 5" -> [0,1,2,4] (0-based page indices), checked against page count n.
function parseRanges(str, n) {
  const out = [];
  for (const part of str.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error(`"${part}" is not a page or range like 2 or 1-3`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > n || a > b) throw new Error(`"${part}" is outside pages 1-${n}`);
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  if (!out.length) throw new Error('Enter at least one page');
  return out;
}

// --- Edit text helpers (no browser needed, so they can be self-checked) ---

// Groups text objects into the lines a person would see. Pure function of the objects, so the same page always
// gives the same lines in the same order (edits are addressed by line index).
function groupLines(objs) {
  // ponytail: only horizontal text is editable; rotated or skewed text is left alone.
  const flat = objs.filter(o => Math.abs(o.m[1]) < 1e-3 * Math.abs(o.m[0] || 1) && Math.abs(o.m[2]) < 1e-3 * Math.abs(o.m[3] || 1) && o.m[0] > 0);
  flat.sort((a, b) => (b.m[5] - a.m[5]) || (a.l - b.l));
  const lines = [];
  for (const o of flat) {
    const line = lines.find(L => {
      const last = L.objs[L.objs.length - 1], gap = o.l - last.r;
      if (Math.abs(L.base - o.m[5]) > 0.2 * o.size || Math.abs(L.size - o.size) > 0.06 * o.size) return false;
      if (gap < -0.5 * o.size || gap > 1.2 * o.size) return false;
      // Don't join across something sitting in the gap (a footnote mark, a symbol in another font).
      return !flat.some(x => x !== o && !L.objs.includes(x) && x.l >= last.r - 0.5 && x.r <= o.l + 0.5 && x.b < last.t + o.size && x.t > last.b - o.size * 0.5);
    });
    if (line) line.objs.push(o);
    else lines.push({ objs: [o], base: o.m[5], size: o.size });
  }
  for (const L of lines) {
    L.objs.sort((a, b) => a.l - b.l);
    L.text = L.objs.reduce((s, o, i) => {
      if (!i) return o.text;
      const gap = o.l - L.objs[i - 1].r;
      return s + (gap > 0.15 * L.size && !/\s$/.test(s) && !/^\s/.test(o.text) ? ' ' : '') + o.text;
    }, '').replace(/\s+/g, ' ').trim();
    L.l = Math.min(...L.objs.map(o => o.l)); L.r = Math.max(...L.objs.map(o => o.r));
    L.b = Math.min(...L.objs.map(o => o.b)); L.t = Math.max(...L.objs.map(o => o.t));
  }
  return lines;
}

// A standard font that looks roughly like the named one.
function similarFont(name) {
  const bold = /bold|black|heavy|medi|semi|demi/i.test(name), ital = /ital|obli/i.test(name);
  if (/courier|mono|consol|typewriter|cmtt/i.test(name)) return `Courier${bold || ital ? '-' : ''}${bold ? 'Bold' : ''}${ital ? 'Oblique' : ''}`;
  if (/times|roman|serif|georgia|garamond|minion|cambria|book|palat|nimbusrom|cmr|charter/i.test(name) && !/sans/i.test(name))
    return bold && ital ? 'Times-BoldItalic' : bold ? 'Times-Bold' : ital ? 'Times-Italic' : 'Times-Roman';
  return `Helvetica${bold || ital ? '-' : ''}${bold ? 'Bold' : ''}${ital ? 'Oblique' : ''}`;
}

if (typeof module !== 'undefined') module.exports = { parseRanges, isProResponse, groupLines, similarFont };

if (typeof document !== 'undefined') {
  const { PDFDocument, StandardFonts, degrees, radians, rgb } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  const $ = id => document.getElementById(id);
  const load = buf => PDFDocument.load(buf, { ignoreEncryption: true });
  const openJs = buf => pdfjsLib.getDocument({ data: buf.slice(0) }).promise; // pdf.js takes ownership, so copy
  const base = f => f.name.replace(/\.pdf$/i, '');
  const kb = n => n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  let lastDownload = null; // kept so the finished screen can offer "Download again"
  function download(data, name) {
    lastDownload = { data, name };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'application/pdf' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function zip(files) {
    const z = new JSZip();
    for (const [name, data] of files) z.file(name, data);
    return z.generateAsync({ type: 'blob' });
  }

  // intent 'print' makes pdf.js render without requestAnimationFrame, so work continues in a background tab.
  async function renderPage(pdf, i, scale) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    return { canvas, page };
  }
  const toBlob = (canvas, type, q) => new Promise(r => canvas.toBlob(r, type, q));

  function fileFrom(id, many) {
    const files = [...$(id).files];
    if (!files.length) throw new Error('Choose a PDF file first');
    if (many && files.length < 2) throw new Error('Choose at least two PDF files');
    return many ? files : files[0];
  }

  // Toasts. toast(msg, type) shows one; pass an existing toast as `el` to update it in place
  // (loading -> success/error). Loading toasts stay until updated; click dismisses.
  const ICONS = { info: '<svg viewBox="0 0 24 24"><path d="M12 11v6M12 7v.5"/></svg>', success: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg>', error: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', loading: '' };
  function toast(msg, type = 'success', el) {
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      $('toasts').append(el);
      while ($('toasts').children.length > 3) $('toasts').firstChild.remove(); // keep the stack short
    }
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
    clearTimeout(el.timer);
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon" aria-hidden="true">${ICONS[type]}</span><span></span>`;
    el.lastChild.textContent = msg;
    el.onclick = close;
    if (type !== 'loading') el.timer = setTimeout(close, type === 'error' ? 6000 : 4000);
    return el;
  }

  // Drop zones: show the chosen file names and highlight while dragging over.
  document.querySelectorAll('.drop').forEach(d => {
    const input = d.querySelector('input'), list = d.querySelector('.drop-files');
    input.addEventListener('change', () => {
      const n = [...input.files].map(f => f.name);
      list.textContent = n.length > 3 ? `${n.slice(0, 3).join(', ')} and ${n.length - 3} more` : n.join(', ');
      d.classList.toggle('has-files', !!n.length);
    });
    ['dragenter', 'dragover'].forEach(e => d.addEventListener(e, () => d.classList.add('over')));
    ['dragleave', 'drop'].forEach(e => d.addEventListener(e, () => d.classList.remove('over')));
  });

  // Finished screen: once a file has been saved, the form is swapped for a summary with
  // "Do another PDF" and "Download again". Leaving the page or starting another resets the tool.
  function resetTool(panel) {
    panel.classList.remove('is-done');
    panel.querySelector('.status').textContent = '';
    panel.querySelectorAll('input[type=file]').forEach(i => { i.value = ''; i.dispatchEvent(new Event('change')); });
  }
  function showDone(panel, title, detail, file) {
    let d = panel.querySelector('.done');
    if (!d) { d = document.createElement('div'); d.className = 'done'; panel.append(d); }
    // `file` is null when the tool finished without saving anything (e.g. a PDF that can't be made smaller).
    d.innerHTML = `<span class="done-check${file ? '' : ' neutral'}" aria-hidden="true">${file ? ICONS.success : ICONS.info}</span><h2></h2><p></p>
      <div class="actions"><button class="btn" type="button">Do another PDF</button><button class="btn ghost" type="button">${file ? 'Download again' : 'Change settings'}</button></div>`;
    d.querySelector('h2').textContent = title;
    d.querySelector('p').textContent = detail;
    const [another, again] = d.querySelectorAll('button');
    another.onclick = () => { resetTool(panel); panel.querySelector('input[type=file]').focus(); };
    again.onclick = file
      ? () => { download(file.data, file.name); toast(`Saved ${file.name} again.`); }
      : () => { panel.classList.remove('is-done'); panel.querySelector('select, input[type=text]')?.focus(); }; // back to the form, file kept
    panel.classList.add('is-done');
    another.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'nearest' });
  }

  // Wires a tool button: shows progress, surfaces errors in the tool's status line.
  // `proOnly` marks a Pro tool: a free visitor who presses its button gets the Pro dialog, not an error.
  function tool(name, fn, proOnly) {
    const btn = $(`${name}-go`), panel = $(name).querySelector('.panel'), status = panel.querySelector('.status');
    btn.onclick = async () => {
      if (proOnly && !pro.active) return openPro();
      btn.disabled = true;
      status.className = 'status';
      status.textContent = '';
      lastDownload = null;
      const t = toast('Working on your device…', 'loading');
      try {
        const t0 = performance.now();
        const msg = await fn() || 'Done. Check your downloads.';
        const secs = Math.max(0.1, (performance.now() - t0) / 1000).toFixed(1);
        const many = msg.includes('\n');
        const title = many ? `${msg.split('\n').length} files processed.` : msg;
        const took = `Took ${secs} seconds on your device.`;
        if (lastDownload) showDone(panel, title, `${many ? `${msg}\n` : ''}Saved to your downloads as ${lastDownload.name}.\n${took}`, lastDownload);
        else showDone(panel, 'Nothing to save.', `${msg}\n${took}`, null); // e.g. a PDF that can't be made smaller
        toast(lastDownload ? title : 'Nothing to save.', 'success', t);
      } catch (e) {
        const msg = /encrypt|password/i.test(e.message) ? 'This PDF is password-protected.'
          : /No PDF header|Invalid PDF|parse/i.test(e.message) ? 'That file isn\'t a valid PDF.' : e.message;
        status.className = 'status err';
        status.textContent = msg;
        toast(msg, 'error', t);
      }
      finally { btn.disabled = false; }
    };
  }

  // --- Pro: Lemon Squeezy license keys, checked straight from the browser (their License API allows it, no server of ours) ---
  // ponytail: Pro is enforced in the browser, so a technical user can bypass it. Fine for browser-only features;
  // server features (Office conversion) must re-check the key on the server.
  const API = 'https://api.lemonsqueezy.com/v1/licenses/';
  const DAY = 864e5;
  const pro = { active: false };
  const saved = () => { try { return JSON.parse(localStorage.getItem('pb-pro')) || null; } catch { return null; } };
  const save = v => { try { v ? localStorage.setItem('pb-pro', JSON.stringify(v)) : localStorage.removeItem('pb-pro'); } catch {} };
  const lemon = async (action, params) =>
    (await fetch(API + action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(params) })).json();

  function showPro() {
    $('pro-pitch').hidden = pro.active;
    $('pro-on').hidden = !pro.active;
    $('pro-open').textContent = pro.active ? 'Pro ✓' : 'Go Pro';
    document.body.classList.toggle('is-pro', pro.active); // styles.css swaps the free and Pro wording
    document.querySelectorAll('.pro-banner').forEach(b => { b.hidden = pro.active; });
    document.querySelectorAll('[data-pro-label]').forEach(b => { b.textContent = pro.active ? b.dataset.label : b.dataset.proLabel; });
  }
  const proSay = (msg, err) => { $('pro-status').className = err ? 'status err' : 'status'; $('pro-status').textContent = msg; };

  // Re-checks the key once a day; if offline, keeps Pro for up to 7 days since the last good check.
  async function checkPro() {
    const s = saved();
    if (!s) return showPro();
    pro.active = true;
    if (Date.now() - s.checkedAt > DAY) {
      try {
        const r = await lemon('validate', { license_key: s.key, instance_id: s.instance });
        if (isProResponse(r)) save({ ...s, checkedAt: Date.now() });
        else { pro.active = false; save(null); }
      } catch { pro.active = Date.now() - s.checkedAt < 7 * DAY; }
    }
    showPro();
  }

  // Pro tools: a banner tells free visitors what they can try and what needs Pro, and the main button says so too.
  const PRO_TOOLS = {
    edit: ['Try it free: open a PDF and change any line to see how it looks. Saving the edited PDF needs Pro.', 'Go Pro to save'],
    organize: ['Try it free: open a PDF and rearrange its pages. Saving the new PDF needs Pro.', 'Go Pro to save'],
    ocr: ['OCR is a Pro tool. Go Pro to make scanned PDFs searchable.', 'Go Pro to use OCR'],
    watermark: ['Watermark is a Pro tool. Go Pro to stamp your PDFs.', 'Go Pro to add watermarks'],
    numbers: ['Page numbers is a Pro tool. Go Pro to number your PDFs.', 'Go Pro to add page numbers'],
  };
  for (const [id, [text, label]] of Object.entries(PRO_TOOLS)) {
    const banner = document.createElement('div');
    banner.className = 'pro-banner';
    banner.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-lock"/></svg><p></p><button class="btn small" type="button" data-pro>Go Pro</button>';
    banner.querySelector('p').textContent = text;
    $(id).querySelector('.panel').prepend(banner);
    const go = $(`${id}-go`);
    go.dataset.label = go.textContent;
    go.dataset.proLabel = label;
  }

  $('pro-buy').href = LEMON.checkout || '#';
  $('pro-buy').hidden = !LEMON.checkout;
  $('pro-soon').hidden = !!LEMON.checkout;
  const openPro = () => { proSay(''); $('pro').showModal(); };
  $('pro-open').onclick = openPro;
  document.querySelectorAll('[data-pro]').forEach(b => { b.onclick = openPro; });
  $('pro-close').onclick = () => $('pro').close();
  $('pro').onclick = e => { if (e.target === $('pro')) $('pro').close(); }; // click on the backdrop
  $('pro-activate').onclick = async () => {
    const key = $('pro-key').value.trim();
    if (!key) return proSay('Paste your license key first.', true);
    if (!LEMON.storeId) return proSay('Payments aren\'t set up yet.', true);
    proSay('Checking…');
    try {
      const r = await lemon('activate', { license_key: key, instance_name: 'browser' });
      if (!r.activated || !isProResponse(r)) return proSay(r.error || 'That key isn\'t valid for Paperbench Pro.', true);
      save({ key, instance: r.instance.id, checkedAt: Date.now() });
      pro.active = true; showPro(); proSay('');
      $('pro').close(); toast('Pro activated. Thanks for supporting Paperbench!');
    } catch { proSay('Couldn\'t reach the license server. Check your connection and try again.', true); }
  };
  $('pro-remove').onclick = async () => {
    const s = saved();
    // Frees this activation so the key can be used in another browser.
    if (s) try { await lemon('deactivate', { license_key: s.key, instance_id: s.instance }); } catch {}
    save(null); pro.active = false; showPro(); proSay('Removed from this browser.');
  };
  checkPro();

  // Tool that takes one PDF free, several with Pro. `one(file)` returns { out: [[name, data], ...], msg }.
  // A single output downloads directly; anything more is zipped.
  // `proOnly` (a tool name) makes the whole tool Pro; otherwise only several-files-at-once is Pro.
  function batchTool(name, one, proOnly) {
    tool(name, async () => {
      const files = [...$(`${name}-file`).files];
      if (!files.length) throw new Error('Choose a PDF file first');
      if (files.length > 1 && !pro.active) {
        $('pro-open').click();
        throw new Error('Processing several files at once is a Pro feature. Pick one file, or go Pro.');
      }
      const out = [], msgs = [];
      for (const f of files) {
        const r = await one(f);
        out.push(...r.out);
        msgs.push(files.length > 1 ? `${f.name}: ${r.msg}` : r.msg);
      }
      if (out.length === 1) download(out[0][1], out[0][0]);
      else if (out.length) download(await zip(out), files.length > 1 ? `paperbench-${name}.zip` : `${base(files[0])}-${name}.zip`);
      return msgs.join('\n');
    }, proOnly);
  }

  tool('merge', async () => {
    const files = fileFrom('merge-files', true);
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await load(await f.arrayBuffer());
      (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    download(await out.save(), 'merged.pdf');
    return `Merged ${files.length} files (${out.getPageCount()} pages).`;
  });

  tool('split', async () => {
    const f = fileFrom('split-file');
    const src = await load(await f.arrayBuffer());
    if ($('split-mode').value === 'burst') {
      const files = [];
      for (const i of src.getPageIndices()) {
        const out = await PDFDocument.create();
        out.addPage((await out.copyPages(src, [i]))[0]);
        files.push([`${base(f)}-page-${i + 1}.pdf`, await out.save()]);
      }
      download(await zip(files), `${base(f)}-pages.zip`);
      return `Split into ${files.length} files.`;
    }
    const idx = parseRanges($('split-pages').value, src.getPageCount());
    const out = await PDFDocument.create();
    (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
    download(await out.save(), `${base(f)}-extract.pdf`);
    return `Extracted ${idx.length} pages.`;
  });

  batchTool('compress', async f => {
    const buf = await f.arrayBuffer();
    const mode = $('compress-mode').value;
    let bytes;
    if (mode === 'lossless') {
      bytes = await (await load(buf)).save({ useObjectStreams: true });
    } else {
      // ponytail: rasterizes pages to JPEG (text stops being selectable). Swap in qpdf/ghostscript WASM for true image recompression.
      const pdf = await openJs(buf), out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        const { canvas, page } = await renderPage(pdf, i, 1.5);
        const img = await out.embedJpg(await (await toBlob(canvas, 'image/jpeg', +mode)).arrayBuffer());
        const { width, height } = page.getViewport({ scale: 1 });
        out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
      }
      bytes = await out.save();
    }
    if (bytes.length >= buf.byteLength) return {
      out: [],
      msg: mode === '0.45' ? `${f.name} is already as small as it gets (${kb(buf.byteLength)}), so compressing it wouldn't help.`
        : `${f.name} can't get smaller at this level (${kb(buf.byteLength)}). Try a stronger level.`,
    };
    return {
      out: [[`${base(f)}-compressed.pdf`, bytes]],
      msg: `${kb(buf.byteLength)} → ${kb(bytes.length)} (${Math.round(100 - bytes.length / buf.byteLength * 100)}% smaller).`,
    };
  });

  batchTool('rotate', async f => {
    const doc = await load(await f.arrayBuffer());
    const by = +$('rotate-deg').value, pages = $('rotate-pages').value.trim();
    const idx = pages ? parseRanges(pages, doc.getPageCount()) : doc.getPageIndices();
    for (const i of idx) {
      const p = doc.getPage(i);
      p.setRotation(degrees((p.getRotation().angle + by) % 360));
    }
    return { out: [[`${base(f)}-rotated.pdf`, await doc.save()]], msg: `Rotated ${idx.length} page${idx.length === 1 ? '' : 's'}.` };
  });

  batchTool('images', async f => {
    const type = $('images-fmt').value, ext = type === 'image/png' ? 'png' : 'jpg';
    const pdf = await openJs(await f.arrayBuffer());
    const files = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const { canvas } = await renderPage(pdf, i, +$('images-scale').value);
      files.push([`${base(f)}-${i}.${ext}`, await toBlob(canvas, type, 0.92)]);
    }
    return { out: files, msg: `Converted ${files.length} page${files.length === 1 ? '' : 's'}.` };
  });

  // ===== Pro tools =====

  // --- Organize pages: thumbnails you can drag, nudge or remove ---
  let org = null; // { order: [original page indices in their new order], thumbs: [image URL per original page] }
  const thumbs = $('organize-thumbs');
  function drawThumbs() {
    thumbs.replaceChildren(...org.order.map((p, i) => {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.draggable = true;
      el.dataset.i = i;
      el.innerHTML = `<img alt="Page ${p + 1}" src="${org.thumbs[p]}"><span class="thumb-n">Page ${p + 1}</span>
        <div class="thumb-actions"><button type="button" data-a="left" aria-label="Move page ${p + 1} earlier">‹</button><button type="button" data-a="del" aria-label="Remove page ${p + 1}">×</button><button type="button" data-a="right" aria-label="Move page ${p + 1} later">›</button></div>`;
      return el;
    }));
  }
  function movePage(from, to) {
    if (to < 0 || to >= org.order.length || from === to) return;
    org.order.splice(to, 0, org.order.splice(from, 1)[0]);
    drawThumbs();
  }
  thumbs.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = +b.closest('.thumb').dataset.i;
    if (b.dataset.a === 'del') { org.order.splice(i, 1); drawThumbs(); }
    else movePage(i, i + (b.dataset.a === 'left' ? -1 : 1));
  };
  let dragFrom = null;
  const overThumb = t => thumbs.querySelectorAll('.over').forEach(x => x !== t && x.classList.remove('over'));
  thumbs.ondragstart = e => { const t = e.target.closest('.thumb'); dragFrom = +t.dataset.i; t.classList.add('dragging'); };
  thumbs.ondragover = e => { e.preventDefault(); const t = e.target.closest('.thumb'); overThumb(t); if (t) t.classList.add('over'); };
  thumbs.ondragend = () => { dragFrom = null; overThumb(); thumbs.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); };
  thumbs.ondrop = e => { e.preventDefault(); const t = e.target.closest('.thumb'); if (t && dragFrom !== null) movePage(dragFrom, +t.dataset.i); };
  $('organize-file').addEventListener('change', async () => {
    const f = $('organize-file').files[0];
    org = null;
    thumbs.replaceChildren();
    $('organize-area').hidden = true;
    if (!f) return;
    try {
      const pdf = await openJs(await f.arrayBuffer()), urls = [];
      // ponytail: renders every page up front; fine for hundreds of pages, render lazily if huge files get slow.
      for (let i = 1; i <= pdf.numPages; i++) urls.push((await renderPage(pdf, i, 0.3)).canvas.toDataURL('image/jpeg', 0.7));
      if ($('organize-file').files[0] !== f) return; // a different file was chosen meanwhile
      org = { order: urls.map((_, i) => i), thumbs: urls };
      $('organize-area').hidden = false;
      drawThumbs();
    } catch { toast('That file isn\'t a valid PDF.', 'error'); }
  });
  tool('organize', async () => {
    const f = fileFrom('organize-file');
    if (!org) throw new Error('Still loading the pages. Try again in a moment.');
    if (!org.order.length) throw new Error('Keep at least one page');
    const src = await load(await f.arrayBuffer()), out = await PDFDocument.create();
    (await out.copyPages(src, org.order)).forEach(p => out.addPage(p));
    download(await out.save(), `${base(f)}-organized.pdf`);
    return `Saved ${org.order.length} of ${src.getPageCount()} pages in the new order.`;
  }, 'Organize pages');

  // --- OCR: each page becomes an image with invisible, searchable text behind it ---
  const loadScript = src => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error('Couldn\'t download the text-recognition engine. Check your connection and try again.'));
    document.head.append(s);
  });
  tool('ocr', async () => {
    const f = fileFrom('ocr-file');
    // Loaded only when OCR is first used, so the rest of the site stays light.
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    const pdf = await openJs(await f.arrayBuffer()), out = await PDFDocument.create();
    const worker = await Tesseract.createWorker('eng');
    let words = 0;
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        const { canvas, page } = await renderPage(pdf, i, 2);
        const { data } = await worker.recognize(canvas, {}, { text: true, pdf: true });
        words += data.text.trim().split(/\s+/).filter(Boolean).length;
        const [p] = await out.copyPages(await PDFDocument.load(new Uint8Array(data.pdf)), [0]);
        const { width, height } = page.getViewport({ scale: 1 });
        p.scale(width / p.getWidth(), height / p.getHeight()); // back to the original page size
        out.addPage(p);
      }
    } finally { await worker.terminate(); }
    download(await out.save(), `${base(f)}-searchable.pdf`);
    return `Recognized about ${words} words on ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}.`;
  }, 'OCR');

  // --- Watermark: diagonal text across every page ---
  batchTool('watermark', async f => {
    const text = $('watermark-text').value.trim();
    if (!text) throw new Error('Type the watermark text');
    const doc = await load(await f.arrayBuffer());
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    let unit; // text width at size 1
    try { unit = font.widthOfTextAtSize(text, 1); }
    catch { throw new Error('Watermark text can only use English letters, numbers and common symbols for now.'); }
    for (const p of doc.getPages()) {
      const { width, height } = p.getSize();
      const angle = Math.atan2(height, width);
      const size = Math.min(0.7 * Math.hypot(width, height) / unit, 140);
      const w = unit * size, cos = Math.cos(angle), sin = Math.sin(angle);
      // Centre the rotated text on the page. ponytail: ignores a page's own rotation; map through it if rotated scans look off.
      p.drawText(text, {
        x: width / 2 - w / 2 * cos + size * 0.35 * sin,
        y: height / 2 - w / 2 * sin - size * 0.35 * cos,
        size, font, color: rgb(0.5, 0.5, 0.5), opacity: +$('watermark-opacity').value, rotate: radians(angle),
      });
    }
    const n = doc.getPageCount();
    return { out: [[`${base(f)}-watermarked.pdf`, await doc.save()]], msg: `Watermarked ${n} page${n === 1 ? '' : 's'}.` };
  }, 'Watermark');

  // --- Page numbers ---
  batchTool('numbers', async f => {
    const doc = await load(await f.arrayBuffer());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages(), start = Math.max(1, Math.floor(+$('numbers-start').value) || 1), last = start + pages.length - 1;
    const fmt = $('numbers-fmt').value, [v, h] = $('numbers-pos').value.split('-');
    const size = 10, margin = 28;
    pages.forEach((p, i) => {
      const k = start + i;
      const label = fmt === 'n' ? `${k}` : fmt === 'slash' ? `${k} / ${last}` : `Page ${k} of ${last}`;
      const { width, height } = p.getSize(), w = font.widthOfTextAtSize(label, size);
      // ponytail: positions use the unrotated page; rotated pages get the number on a different edge.
      p.drawText(label, {
        x: h === 'left' ? margin : h === 'right' ? width - margin - w : (width - w) / 2,
        y: v === 'top' ? height - margin - size : margin,
        size, font, color: rgb(0.3, 0.3, 0.3),
      });
    });
    return { out: [[`${base(f)}-numbered.pdf`, await doc.save()]], msg: `Numbered ${pages.length} page${pages.length === 1 ? '' : 's'}.` };
  }, 'Page numbers');

  // --- Edit text: change the real text of a PDF with PDFium (Chrome's PDF engine, compiled for the browser) ---
  // pdf-lib and pdf.js can't rewrite existing text, so this tool loads PDFium on first use.
  // How an edit works: the text objects that make up the clicked line are removed and new ones are drawn in their
  // place. The original font is kept when it has every letter needed; otherwise a similar standard font is used.
  const PDFIUM = 'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.15.1';
  let pdfiumLoading = null;
  const pdfium = () => pdfiumLoading ||= (async () => {
    const [{ init }, wasmBinary] = await Promise.all([
      import(`${PDFIUM}/+esm`),
      fetch(`${PDFIUM}/dist/pdfium.wasm`).then(r => { if (!r.ok) throw new Error('engine'); return r.arrayBuffer(); }),
    ]);
    const P = await init({ wasmBinary });
    P.PDFiumExt_Init();
    return P;
  })().catch(() => { pdfiumLoading = null; throw new Error('Couldn\'t download the editing engine. Check your connection and try again.'); });

  // Letters the standard PDF fonts can draw (Latin-1 plus common punctuation).
  const LATIN = /^[\x20-\x7E\xA0-\xFF‘’“”–—…€•™]*$/;
  const clean = s => s.replace(/\u0002/g, '-').replace(/[\u0000-\u001F￾￿]/g, ''); // \u0002 is PDFium's end-of-line hyphen

  // Opens `bytes` in PDFium, runs fn(doc), always closes. Returns fn's result.
  function withDoc(P, bytes, fn) {
    const M = P.pdfium, mem = M.wasmExports.malloc(bytes.length);
    M.HEAPU8.set(bytes, mem);
    const doc = P.FPDF_LoadMemDocument(mem, bytes.length, '');
    try {
      if (!doc) throw new Error('This PDF couldn\'t be opened for editing. It may be password-protected.');
      return fn(doc);
    } finally { if (doc) P.FPDF_CloseDocument(doc); M.wasmExports.free(mem); }
  }
  function saveDoc(P, doc) {
    const M = P.pdfium, w = P.PDFiumExt_OpenFileWriter();
    P.PDFiumExt_SaveAsCopy(doc, w);
    const size = P.PDFiumExt_GetFileWriterSize(w), buf = M.wasmExports.malloc(size);
    P.PDFiumExt_GetFileWriterData(w, buf, size);
    const out = M.HEAPU8.slice(buf, buf + size);
    M.wasmExports.free(buf);
    P.PDFiumExt_CloseFileWriter(w);
    return out;
  }
  // Scratch memory for reading floats and strings out of PDFium.
  function scratch(P, bytes, fn) {
    const M = P.pdfium, p = M.wasmExports.malloc(bytes);
    try { return fn(p, i => M.HEAPF32[(p >> 2) + i], i => M.HEAPU32[(p >> 2) + i]); } finally { M.wasmExports.free(p); }
  }
  const boundsOf = (P, obj) => scratch(P, 16, (p, f) => (P.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12), { l: f(0), b: f(1), r: f(2), t: f(3) }));
  function setObjText(P, obj, text) {
    const M = P.pdfium, n = (text.length + 1) * 2, w = M.wasmExports.malloc(n);
    M.stringToUTF16(text, w, n);
    const ok = P.FPDFText_SetText(obj, w);
    M.wasmExports.free(w);
    return ok;
  }

  // Every text object on a page: its text, font, size, matrix [a b c d e f] and box, in PDF page coordinates.
  function readText(P, doc, pageIndex) {
    const M = P.pdfium, page = P.FPDF_LoadPage(doc, pageIndex), tp = P.FPDFText_LoadPage(page), objs = [];
    for (let i = 0, n = P.FPDFPage_CountObjects(page); i < n; i++) {
      const obj = P.FPDFPage_GetObject(page, i);
      if (P.FPDFPageObj_GetType(obj) !== 1) continue; // 1 = text
      const len = P.FPDFTextObj_GetText(obj, tp, 0, 0);
      const text = clean(scratch(P, len + 2, p => (P.FPDFTextObj_GetText(obj, tp, p, len), M.UTF16ToString(p))));
      if (!text.trim()) continue;
      const font = P.FPDFTextObj_GetFont(obj);
      const fontName = scratch(P, 256, p => { const k = P.FPDFFont_GetBaseFontName(font, p, 256); return new TextDecoder().decode(M.HEAPU8.slice(p, p + Math.max(0, k - 1))); });
      const m = scratch(P, 24, (p, f) => (P.FPDFPageObj_GetMatrix(obj, p), [0, 1, 2, 3, 4, 5].map(f)));
      const fontSize = scratch(P, 4, (p, f) => (P.FPDFTextObj_GetFontSize(obj, p), f(0)));
      objs.push({ obj, text, font, fontName, embedded: !!P.FPDFFont_GetIsEmbedded(font), m, fontSize, size: fontSize * Math.hypot(m[2], m[3]), ...boundsOf(P, obj) });
    }
    return { page, objs, close() { P.FPDFText_ClosePage(tp); P.FPDF_ClosePage(page); } };
  }

  // Replaces line `lineIndex` on a page with `newText`. `known` maps a font name to the letters that font is known
  // to contain (every letter the document already draws with it). Returns the new file and what had to give.
  function editLine(P, bytes, pageIndex, lineIndex, newText, known) {
    return withDoc(P, bytes, doc => {
      const { page, objs, close } = readText(P, doc, pageIndex);
      try {
        const line = groupLines(objs)[lineIndex];
        if (!line) throw new Error('That line is no longer there. Try again.');
        const first = line.objs[0], words = newText.split(/\s+/).filter(Boolean);
        const color = scratch(P, 16, (p, f, u) => (P.FPDFPageObj_GetFillColor(first.obj, p, p + 4, p + 8, p + 12), [0, 1, 2, 3].map(u)));
        // Draws `text` in `font` starting at page x; returns the new object's box.
        const draw = (text, font, x) => {
          const o = P.FPDFPageObj_CreateTextObj(doc, font, first.fontSize);
          if (!o || !setObjText(P, o, text)) throw new Error('This line couldn\'t be changed.');
          const M = P.pdfium, mp = M.wasmExports.malloc(24);
          [first.m[0], first.m[1], first.m[2], first.m[3], x, first.m[5]].forEach((v, i) => { M.HEAPF32[(mp >> 2) + i] = v; });
          P.FPDFPageObj_SetMatrix(o, mp);
          M.wasmExports.free(mp);
          P.FPDFPageObj_SetFillColor(o, ...color);
          P.FPDFPage_InsertObject(page, o);
          return boundsOf(P, o);
        };
        const have = known.get(first.fontName) || new Set();
        const original = !first.embedded ? LATIN.test(newText) : [...newText.replace(/\s/g, '')].every(c => have.has(c));
        let substituted = false, right;
        if (original && !first.embedded) {
          right = draw(words.join(' '), first.font, first.m[4]).r; // standard font: has a real space, one object is enough
        } else if (original) {
          // Embedded fonts often have no usable space character, so place each word ourselves.
          // The gap between words is taken from the original line where possible.
          const oldWords = line.text.split(' ').filter(Boolean);
          let gap = 0.27 * line.size;
          if (oldWords.length > 1 && oldWords.every(w => [...w].every(c => have.has(c)))) {
            const widths = oldWords.map(w => { const o = P.FPDFPageObj_CreateTextObj(doc, first.font, first.fontSize); setObjText(P, o, w); P.FPDFPage_InsertObject(page, o); const b = boundsOf(P, o); P.FPDFPage_RemoveObject(page, o); P.FPDFPageObj_Destroy(o); return (b.r - b.l) * Math.hypot(first.m[0], first.m[1]); });
            const g = (line.r - line.l - widths.reduce((a, b) => a + b, 0)) / (oldWords.length - 1);
            if (g > 0.12 * line.size && g < 0.7 * line.size) gap = g;
          }
          let x = first.m[4];
          for (const w of words) { const b = draw(w, first.font, x); x += (b.r - b.l) + gap; right = b.r; }
        } else {
          if (!LATIN.test(newText)) throw new Error('This document\'s font doesn\'t have some of those letters, and only English and Western European letters can be added for now.');
          right = draw(words.join(' '), P.FPDFText_LoadStandardFont(doc, similarFont(first.fontName)), first.m[4]).r;
          substituted = true;
        }
        for (const o of line.objs) { P.FPDFPage_RemoveObject(page, o.obj); P.FPDFPageObj_Destroy(o.obj); }
        if (!P.FPDFPage_GenerateContent(page)) throw new Error('This page couldn\'t be saved after the change.');
        return { bytes: saveDoc(P, doc), substituted, overflow: right > P.FPDF_GetPageWidthF(page) - 4 };
      } finally { close(); }
    });
  }

  // UI state for the Edit text tool.
  let ed = null; // { name, bytes, undo: [bytes…], page (0-based), pages, lines, vp, known }
  const stage = $('edit-stage'), edCanvas = $('edit-canvas'), edLines = $('edit-lines');
  async function showEditPage() {
    const P = await pdfium(), mine = ed;
    const pdf = await openJs(ed.bytes.buffer.slice(ed.bytes.byteOffset, ed.bytes.byteOffset + ed.bytes.byteLength));
    const page = await pdf.getPage(ed.page + 1);
    const vp = page.getViewport({ scale: Math.min(2, 1100 / page.getViewport({ scale: 1 }).width) });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    if (ed !== mine) return; // another file was chosen while rendering
    edCanvas.width = c.width; edCanvas.height = c.height;
    edCanvas.getContext('2d').drawImage(c, 0, 0);
    ed.vp = vp;
    ed.lines = withDoc(P, ed.bytes, doc => { const t = readText(P, doc, ed.page); try { return groupLines(t.objs).map(({ text, l, b, r, t: top, size }) => ({ text, l, b, r, t: top, size })); } finally { t.close(); } });
    edLines.replaceChildren(...ed.lines.map((L, i) => {
      const [x1, y1] = vp.convertToViewportPoint(L.l, L.t), [x2, y2] = vp.convertToViewportPoint(L.r, L.b);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'edit-line'; b.dataset.i = i;
      b.setAttribute('aria-label', `Edit line: ${L.text}`);
      const pad = 2;
      b.style.cssText = `left:${(Math.min(x1, x2) - pad) / c.width * 100}%;top:${(Math.min(y1, y2) - pad) / c.height * 100}%;width:${(Math.abs(x2 - x1) + pad * 2) / c.width * 100}%;height:${(Math.abs(y2 - y1) + pad * 2) / c.height * 100}%`;
      return b;
    }));
    $('edit-pageinfo').textContent = `Page ${ed.page + 1} of ${ed.pages}`;
    $('edit-prev').disabled = ed.page === 0;
    $('edit-next').disabled = ed.page >= ed.pages - 1;
    $('edit-undo').disabled = !ed.undo.length;
    $('edit-hint').textContent = ed.lines.length ? 'Click a line to change it. Press Enter to apply, Esc to cancel.'
      : 'There is no editable text on this page. If it\'s a scan, there are no letters to change.';
  }
  const editBusy = async fn => {
    try { await fn(); } catch (e) { toast(e.message || 'Something went wrong.', 'error'); }
  };
  $('edit-file').addEventListener('change', () => editBusy(async () => {
    const f = $('edit-file').files[0];
    ed = null; $('edit-area').hidden = true; edLines.replaceChildren();
    if (!f) return;
    const t = toast('Opening the editor…', 'loading');
    try {
      const P = await pdfium(), bytes = new Uint8Array(await f.arrayBuffer());
      // Which letters each font is known to contain, from the text already in the document.
      // ponytail: reads up to 60 pages; a letter used only on a later page falls back to the similar font.
      const info = withDoc(P, bytes, doc => {
        const pages = P.FPDF_GetPageCount(doc), known = new Map();
        for (let i = 0; i < Math.min(pages, 60); i++) {
          const t = readText(P, doc, i);
          for (const o of t.objs) { if (!known.has(o.fontName)) known.set(o.fontName, new Set()); for (const ch of o.text) known.get(o.fontName).add(ch); }
          t.close();
        }
        return { pages, known };
      });
      if ($('edit-file').files[0] !== f) return;
      ed = { name: f.name, bytes, undo: [], page: 0, ...info };
      $('edit-area').hidden = false;
      await showEditPage();
      t.onclick();
    } catch (e) { toast(/open|engine|connection/i.test(e.message) ? e.message : 'That file isn\'t a valid PDF.', 'error', t); }
  }));
  $('edit-prev').onclick = () => editBusy(async () => { ed.page--; await showEditPage(); });
  $('edit-next').onclick = () => editBusy(async () => { ed.page++; await showEditPage(); });
  $('edit-undo').onclick = () => editBusy(async () => { ed.bytes = ed.undo.pop(); await showEditPage(); toast('Undone.'); });
  edLines.onclick = e => {
    const b = e.target.closest('.edit-line');
    if (!b || stage.querySelector('.edit-input')) return;
    const i = +b.dataset.i, L = ed.lines[i], input = document.createElement('input');
    input.className = 'edit-input'; input.type = 'text'; input.value = L.text; input.spellcheck = false;
    input.setAttribute('aria-label', 'New text for this line');
    const shown = stage.clientWidth / edCanvas.width;
    input.style.cssText = `left:${b.style.left};top:${b.style.top};min-width:max(${b.style.width}, 220px);font-size:${Math.max(12, L.size * ed.vp.scale * shown * 0.95)}px`;
    let done = false;
    const finish = apply => editBusy(async () => {
      if (done) return;
      done = true;
      const text = input.value.replace(/\s+/g, ' ').trim();
      input.remove();
      if (!apply || text === L.text) return;
      if (!text) throw new Error('Removing a whole line isn\'t supported yet. Keep at least one word.');
      const P = await pdfium(), r = editLine(P, ed.bytes, ed.page, i, text, ed.known);
      ed.undo.push(ed.bytes); ed.bytes = r.bytes;
      await showEditPage();
      toast(r.substituted ? 'Changed. Some letters aren\'t in this document\'s font, so this line now uses a similar font.'
        : r.overflow ? 'Changed. The new text is long and may run off the page.' : 'Line changed.');
    });
    input.onkeydown = k => { if (k.key === 'Enter') finish(true); else if (k.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
    stage.append(input);
    input.focus(); input.select();
  };
  tool('edit', async () => {
    fileFrom('edit-file');
    if (!ed) throw new Error('Still opening the PDF. Try again in a moment.');
    if (!ed.undo.length) throw new Error('Change some text first: click a line on the page.');
    download(ed.bytes, `${ed.name.replace(/\.pdf$/i, '')}-edited.pdf`);
    return `Saved with ${ed.undo.length} line${ed.undo.length === 1 ? '' : 's'} changed.`;
  }, 'Edit text');

  // --- Sign: draw pad + click-to-place preview ---
  const pad = $('sig-pad'), ctx = pad.getContext('2d');
  let drawn = false, preview = null; // preview = { scale, vp, rotate, img } of the rendered page
  let spot = null;                   // click position on preview, in canvas pixels
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  const pt = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.onpointerdown = e => { pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pt(e)); pad.onpointermove = m => { ctx.lineTo(...pt(m)); ctx.stroke(); drawn = true; }; };
  pad.onpointerup = () => { pad.onpointermove = null; };
  $('sig-clear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };

  // Crop the drawing to its ink so the placed signature has no empty margin.
  function signaturePng() {
    const { data, width, height } = ctx.getImageData(0, 0, pad.width, pad.height);
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const c = document.createElement('canvas');
    c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
    c.getContext('2d').drawImage(pad, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    return toBlob(c, 'image/png');
  }

  const prev = $('sig-preview');
  async function showPreview() {
    const f = $('sign-file').files[0];
    if (!f) { preview = spot = null; prev.hidden = true; $('sig-empty').hidden = false; return; } // file cleared
    const pdf = await openJs(await f.arrayBuffer());
    const n = Math.min(Math.max(1, +$('sign-page').value || 1), pdf.numPages);
    $('sign-page').max = pdf.numPages; $('sign-page').value = n;
    const page = await pdf.getPage(n);
    const scale = Math.min(1.5, 800 / page.getViewport({ scale: 1 }).width);
    const vp = page.getViewport({ scale });
    prev.hidden = false; $('sig-empty').hidden = true;
    prev.width = Math.ceil(vp.width); prev.height = Math.ceil(vp.height);
    await page.render({ canvasContext: prev.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    preview = { scale, vp, rotate: page.rotate, img: prev.getContext('2d').getImageData(0, 0, prev.width, prev.height) };
    spot = null;
  }
  $('sign-file').onchange = showPreview;
  $('sign-page').onchange = showPreview;
  prev.onclick = e => {
    if (!preview) return;
    const r = prev.getBoundingClientRect();
    spot = [(e.clientX - r.left) * prev.width / r.width, (e.clientY - r.top) * prev.height / r.height];
    const c = prev.getContext('2d');
    c.putImageData(preview.img, 0, 0);
    c.strokeStyle = '#0071e3'; c.lineWidth = 2;
    c.strokeRect(spot[0], spot[1], +$('sign-width').value * preview.scale, 40 * preview.scale);
  };

  tool('sign', async () => {
    if (!drawn) throw new Error('Draw your signature first');
    const f = fileFrom('sign-file');
    if (!spot) throw new Error('Click on the page where the signature goes');
    const doc = await load(await f.arrayBuffer());
    const page = doc.getPage(+$('sign-page').value - 1);
    const img = await doc.embedPng(await (await signaturePng()).arrayBuffer());
    const width = +$('sign-width').value, height = width * img.height / img.width;
    // The click is the signature's top-left on screen. pdf-lib anchors an image at its bottom-left, so convert
    // that corner from screen to PDF coordinates (the viewport handles page rotation and crop offsets), then
    // turn the image by the page's rotation so it reads upright.
    const [x, y] = preview.vp.convertToPdfPoint(spot[0], spot[1] + height * preview.scale);
    page.drawImage(img, { x, y, width, height, rotate: degrees(preview.rotate) });
    download(await doc.save(), `${base(f)}-signed.pdf`);
    return 'Signed.';
  });

  // --- Routing: #merge etc. shows one tool, empty hash shows the home grid ---
  // Scroll reveal: blocks fade up once as they enter the screen, siblings slightly staggered.
  // The classes are removed afterwards so hover transitions go back to normal.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver(entries => entries.forEach(({ isIntersecting, target }) => {
      if (!isIntersecting) return;
      io.unobserve(target);
      target.classList.add('in');
      setTimeout(() => target.classList.remove('reveal', 'in'), 1100);
    }), { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.section-head, .grid > *, .cols > *, .steps > *, .stats > *, .plan, .faq details, .band .wrap').forEach(el => {
      el.style.setProperty('--d', `${[...el.parentNode.children].indexOf(el) % 6 * 60}ms`);
      el.classList.add('reveal');
      io.observe(el);
    });
  }

  // #merge, #pricing etc. show that view; anything else shows home. #tools is home scrolled to the tool grid.
  const views = [...document.querySelectorAll('.view')];
  const route = e => {
    const id = location.hash.slice(1);
    const view = views.find(v => v.id === id) || $('home');
    views.forEach(v => { v.hidden = v !== view; });
    document.querySelectorAll('.panel.is-done').forEach(resetTool); // a finished tool starts fresh next time
    document.title = view.dataset.title ? `${view.dataset.title} · Paperbench` : "Paperbench — PDF tools that can't see your files";
    document.querySelectorAll('.nav nav a').forEach(a =>
      a.getAttribute('href') === `#${view.id}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    if (id === 'tools') return $('tools').scrollIntoView();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (e) view.querySelector('h1').focus({ preventScroll: true }); // move keyboard/screen-reader focus to the new page
  };
  addEventListener('hashchange', route);
  route();
}
