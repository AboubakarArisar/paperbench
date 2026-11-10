// Paperbench — every PDF operation runs in the browser; nothing is uploaded.

// Fill these in from your Lemon Squeezy dashboard (Store settings → ID; Product → ID; Product → Share → checkout link).
// Until they're set, no license key can activate Pro.
const LEMON = { checkout: '', storeId: 0, productId: 0 };

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

if (typeof module !== 'undefined') module.exports = { parseRanges, isProResponse };

if (typeof document !== 'undefined') {
  const { PDFDocument, degrees } = PDFLib;
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
  function tool(name, fn) {
    const btn = $(`${name}-go`), panel = $(name).querySelector('.panel'), status = panel.querySelector('.status');
    btn.onclick = async () => {
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
  function batchTool(name, one) {
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
    });
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
