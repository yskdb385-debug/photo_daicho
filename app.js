'use strict';
/* =========================================================
   写真台帳自動作成PWA
   構成:
   1. DB (IndexedDB)
   2. Utils (EXIF, sanitize, canvas, base64)
   3. Whiteboard detection heuristic
   4. OCR (Tesseract.js) / Claude AI enhance(prototype only)
   5. Grouping logic
   6. State
   7. Render: home / review / export / settings
   8. Export: Excel(ExcelJS) / ZIP(JSZip)
   9. Boot / event wiring
   ========================================================= */

/* ---------- 1. DB ---------- */
const DB_NAME = 'photo-ledger-db';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

/* ---------- 2. Utils ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), ms);
}

function sanitizeToken(s) {
  if (!s) return '';
  return String(s).trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '');
}

function pad(n, len) { return String(n).padStart(len, '0'); }

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function blobToArrayBuffer(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsArrayBuffer(blob);
  });
}
async function blobToBase64Raw(blob) {
  const durl = await blobToDataURL(blob);
  return durl.split(',')[1];
}

// EXIF DateTimeOriginal (tag 0x9003) minimal parser for JPEG
async function getExifDate(file) {
  try {
    const buf = await file.slice(0, 128 * 1024).arrayBuffer();
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return null;
    let offset = 2;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      if (marker === 0xFFE1) {
        const exifStart = offset + 4;
        if (view.getUint32(exifStart) !== 0x45786966) { offset += 2 + view.getUint16(offset + 2); continue; }
        const tiffStart = exifStart + 6;
        const little = view.getUint16(tiffStart) === 0x4949;
        const ifd0Off = tiffStart + view.getUint32(tiffStart + 4, little);
        const dateStr = readExifIFDForDate(view, tiffStart, ifd0Off, little);
        if (dateStr) return dateStr;
        return null;
      } else if ((marker & 0xFF00) !== 0xFF00) {
        break;
      } else {
        offset += 2 + view.getUint16(offset + 2);
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}
function readExifIFDForDate(view, tiffStart, ifdOff, little) {
  try {
    const numEntries = view.getUint16(ifdOff, little);
    let exifSubOff = null;
    let dateTimeStr = null;
    for (let i = 0; i < numEntries; i++) {
      const entryOff = ifdOff + 2 + i * 12;
      const tag = view.getUint16(entryOff, little);
      if (tag === 0x8769) { // ExifIFD pointer
        exifSubOff = tiffStart + view.getUint32(entryOff + 8, little);
      }
      if (tag === 0x0132) { // DateTime
        const valOff = tiffStart + view.getUint32(entryOff + 8, little);
        dateTimeStr = readAsciiAt(view, valOff, 19);
      }
    }
    if (exifSubOff) {
      const subEntries = view.getUint16(exifSubOff, little);
      for (let i = 0; i < subEntries; i++) {
        const entryOff = exifSubOff + 2 + i * 12;
        const tag = view.getUint16(entryOff, little);
        if (tag === 0x9003) { // DateTimeOriginal
          const valOff = tiffStart + view.getUint32(entryOff + 8, little);
          return readAsciiAt(view, valOff, 19);
        }
      }
    }
    return dateTimeStr;
  } catch (e) { return null; }
}
function readAsciiAt(view, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s || null;
}
// "YYYY:MM:DD HH:MM:SS" -> "YYYY-MM-DD"
function exifDateToYMD(exifStr) {
  if (!exifStr) return null;
  const m = exifStr.match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function downscaleToCanvas(file, maxSize) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();
  return canvas;
}
function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

/* ---------- 3. Whiteboard detection heuristic ----------
   小さいキャンバスに縮小 → 明るい連結領域(ホワイトボード面)を検出
   → その領域内のエッジ密度(手書き文字量)からスコア化。
   完全自動ではないため、確認・手動修正を前提とする。
--------------------------------------------------------- */
async function analyzeWhiteboard(file) {
  const N = 64;
  const canvas = document.createElement('canvas');
  canvas.width = N; canvas.height = N;
  const ctx = canvas.getContext('2d');
  try {
    const bitmap = await createImageBitmap(file);
    ctx.drawImage(bitmap, 0, 0, N, N);
    bitmap.close && bitmap.close();
  } catch (e) {
    return { score: 0, brightFraction: 0, edgeDensity: 0, ok: false };
  }
  const data = ctx.getImageData(0, 0, N, N).data;
  const L = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const bright = new Uint8Array(N * N);
  const BRIGHT_T = 185;
  for (let i = 0; i < N * N; i++) bright[i] = L[i] > BRIGHT_T ? 1 : 0;

  // 最大連結成分(4近傍BFS)
  const visited = new Uint8Array(N * N);
  let bestSize = 0, bestPixels = null;
  for (let s = 0; s < N * N; s++) {
    if (!bright[s] || visited[s]) continue;
    const queue = [s]; visited[s] = 1;
    const pixels = [];
    while (queue.length) {
      const p = queue.pop();
      pixels.push(p);
      const x = p % N, y = (p / N) | 0;
      const neighbors = [];
      if (x > 0) neighbors.push(p - 1);
      if (x < N - 1) neighbors.push(p + 1);
      if (y > 0) neighbors.push(p - N);
      if (y < N - 1) neighbors.push(p + N);
      for (const np of neighbors) {
        if (bright[np] && !visited[np]) { visited[np] = 1; queue.push(np); }
      }
    }
    if (pixels.length > bestSize) { bestSize = pixels.length; bestPixels = pixels; }
  }
  const brightFraction = bestSize / (N * N);
  if (!bestPixels || bestSize < 20) {
    return { score: 0, brightFraction, edgeDensity: 0, ok: true, bboxNorm: null };
  }
  // bounding box
  let minX = N, maxX = 0, minY = N, maxY = 0;
  for (const p of bestPixels) {
    const x = p % N, y = (p / N) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // エッジ密度(bbox内の勾配平均)
  let edgeSum = 0, edgeCount = 0;
  for (let y = minY + 1; y < maxY; y++) {
    for (let x = minX + 1; x < maxX; x++) {
      const i = y * N + x;
      const gx = Math.abs(L[i + 1] - L[i - 1]);
      const gy = Math.abs(L[i + N] - L[i - N]);
      edgeSum += gx + gy;
      edgeCount++;
    }
  }
  const edgeDensity = edgeCount ? Math.min(1, (edgeSum / edgeCount) / 90) : 0;

  // brightFraction が 0.12〜0.75 の範囲に近いほど高スコア(三角関数的)
  let sizeScore;
  if (brightFraction < 0.10 || brightFraction > 0.85) sizeScore = 0;
  else if (brightFraction <= 0.40) sizeScore = (brightFraction - 0.10) / 0.30;
  else sizeScore = Math.max(0, 1 - (brightFraction - 0.40) / 0.45);

  const score = Math.max(0, Math.min(1, sizeScore * 0.55 + edgeDensity * 0.45));
  const bboxNorm = { minXf: minX / N, maxXf: (maxX + 1) / N, minYf: minY / N, maxYf: (maxY + 1) / N };
  return { score, brightFraction, edgeDensity, ok: true, bboxNorm };
}

/* 検出したホワイトボード領域を、元の高解像度写真から切り出す(OCR/Claude解析用) */
async function cropToWhiteboard(file, bboxNorm, maxDim) {
  const bitmap = await createImageBitmap(file);
  let x0 = 0, y0 = 0, cropW = bitmap.width, cropH = bitmap.height;
  if (bboxNorm) {
    const padX = (bboxNorm.maxXf - bboxNorm.minXf) * 0.10;
    const padY = (bboxNorm.maxYf - bboxNorm.minYf) * 0.10;
    const minXf = Math.max(0, bboxNorm.minXf - padX);
    const maxXf = Math.min(1, bboxNorm.maxXf + padX);
    const minYf = Math.max(0, bboxNorm.minYf - padY);
    const maxYf = Math.min(1, bboxNorm.maxYf + padY);
    x0 = minXf * bitmap.width; y0 = minYf * bitmap.height;
    cropW = (maxXf - minXf) * bitmap.width;
    cropH = (maxYf - minYf) * bitmap.height;
  }
  const scale = Math.min(3, maxDim / Math.max(cropW, cropH));
  const destW = Math.max(1, Math.round(cropW * scale));
  const destH = Math.max(1, Math.round(cropH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = destW; canvas.height = destH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, x0, y0, cropW, cropH, 0, 0, destW, destH);
  bitmap.close && bitmap.close();
  return canvas;
}

async function getWhiteboardCropBlob(photo, maxDim) {
  if (photo._wbCropBlob && photo._wbCropDim === maxDim) return photo._wbCropBlob;
  const canvas = await cropToWhiteboard(photo.blob, photo.wbBboxNorm, maxDim);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  photo._wbCropBlob = blob; photo._wbCropDim = maxDim;
  return blob;
}

/* ---------- 4. OCR / Claude enhance ---------- */
let tesseractWorkerPromise = null;
async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = Tesseract.createWorker('jpn');
  }
  return tesseractWorkerPromise;
}
async function ocrPhoto(blob) {
  try {
    const worker = await getTesseractWorker();
    const { data } = await worker.recognize(blob);
    return (data && data.text) ? data.text.trim() : '';
  } catch (e) {
    console.error('OCR error', e);
    return '';
  }
}

// Claude AIでの高精度再解析(このチャット内Artifactプレビューでのみ動作。配布版では失敗しトースト表示)
async function claudeEnhanceFields(blob) {
  const b64 = await blobToBase64Raw(blob);
  const prompt = `この画像は発掘現場のホワイトボード（黒板）です。書かれている情報から次の5項目をJSONで抽出してください。読み取れない項目は空文字にしてください。前置きや説明、コードブロック記号は一切つけず、JSONのみを出力してください。
{"iseki":"遺跡名","ikou":"遺構名・番号","grid":"グリッド・区画","houi":"方位","date":"撮影年月日(YYYY-MM-DD形式が分かればそれで、不明ならそのまま書かれている通り)"}`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: blob.type || 'image/jpeg', data: b64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });
  if (!resp.ok) throw new Error('API error ' + resp.status);
  const data = await resp.json();
  const text = (data.content || []).map(c => c.text || '').join('\n');
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

/* ---------- 5. Grouping logic ---------- */
const WB_THRESHOLD_DEFAULT = 0.5;

function regroupFromPhotoList(photos, threshold) {
  // photos: 日付順ソート済み配列 [{id, wbScore, ...}]
  const groups = [];
  let current = null;
  let leadingOrphans = [];
  for (const p of photos) {
    if (p.role === 'excluded') continue;
    const forcedStart = p.forceGroupStart === true;
    const isWB = forcedStart || (p.wbScore >= threshold);
    if (isWB) {
      current = { id: p.groupIdHint || uid(), whiteboardPhotoId: p.id, photoIds: [p.id], hasWhiteboard: true };
      groups.push(current);
    } else if (current) {
      current.photoIds.push(p.id);
    } else {
      leadingOrphans.push(p.id);
    }
  }
  if (leadingOrphans.length) {
    groups.unshift({ id: uid(), whiteboardPhotoId: null, photoIds: leadingOrphans, hasWhiteboard: false });
  }
  return groups;
}

/* ---------- 6. State ---------- */
const state = {
  photos: [],   // {id, name, blob, thumbUrl, exifYMD, wbScore, role, forceGroupStart, groupIdHint}
  groups: [],   // {id, whiteboardPhotoId, photoIds:[], hasWhiteboard, fields:{iseki,ikou,grid,houi,date}, ocrRaw}
  settings: { isekiDefault: '浅間古墳', namingTemplate: '{iseki}_{ikou}_{grid}_{houi}_{date}_{seq}', wbThreshold: WB_THRESHOLD_DEFAULT },
  openGroupId: null
};

async function loadSettings() {
  const rows = await idbGetAll('settings');
  for (const r of rows) {
    if (r.key === 'main') Object.assign(state.settings, r.value);
  }
}
async function saveSettings() {
  await idbPut('settings', { key: 'main', value: state.settings });
}
async function persistGroupsMeta() {
  await idbClear('groups');
  for (const g of state.groups) await idbPut('groups', g);
}

/* ---------- 7. Render ---------- */
const screens = ['home', 'review', 'export', 'settings'];
function showScreen(name) {
  screens.forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('active', s === name);
  });
  document.querySelectorAll('nav.bottom button').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === name);
  });
  if (name === 'review') renderReview();
  if (name === 'export') renderExport();
  if (name === 'settings') renderSettings();
}

function photoById(id) { return state.photos.find(p => p.id === id); }

function renderHome() {
  const el = document.getElementById('screen-home');
  const count = state.photos.length;
  el.innerHTML = `
    <div class="card accent">
      <h2><span class="num">1</span>撮影ルール</h2>
      <ol class="steps">
        <li>遺構ごとに、まず<strong>ホワイトボードを写した写真</strong>を1枚撮影</li>
        <li>続けてホワイトボードを外し、<strong>本番写真</strong>を必要枚数撮影</li>
        <li>次の遺構に移ったら、また①からくり返す</li>
      </ol>
      <p class="small-note">アプリは撮影日時の順番でホワイトボード写真を自動検出し、そこから次のホワイトボード写真の直前までを1グループとして台帳化します。自動検出は完全ではないため、次の画面で必ず確認・修正してください。</p>
    </div>

    <div class="card">
      <h2><span class="num">2</span>写真を選択</h2>
      <label class="dropzone" for="fileInput">
        <div class="big">🗂️</div>
        <div>カメラロールから写真をまとめて選択</div>
        <div class="filecount">${count ? count + ' 枚読み込み済み' : 'タップして選択'}</div>
      </label>
      <input type="file" id="fileInput" accept="image/*" multiple>
      ${count ? `<div class="btn-row"><button class="btn secondary" id="btnClearPhotos">選択をクリア</button></div>` : ''}
    </div>

    <div class="card">
      <h2><span class="num">3</span>解析</h2>
      <p class="small-note">枚数が多いと処理に時間がかかります(目安: 1枚あたり0.5〜2秒)。</p>
      <button class="btn shu" id="btnProcess" ${count ? '' : 'disabled'}>グループ分けを実行 (${count}枚)</button>
      <div class="progress-wrap" id="progressWrap" style="display:none;">
        <div class="progress-bar"><div class="fill" id="progressFill"></div></div>
        <div class="progress-label" id="progressLabel"></div>
      </div>
    </div>
  `;
  document.getElementById('fileInput').addEventListener('change', onFilesSelected);
  const clearBtn = document.getElementById('btnClearPhotos');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    state.photos = []; state.groups = [];
    await idbClear('photos'); await idbClear('groups');
    renderHome();
  });
  document.getElementById('btnProcess').addEventListener('click', runProcessing);
}

async function onFilesSelected(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  toast(`${files.length}枚を読み込み中…`);
  const newPhotos = [];
  for (const f of files) {
    const exif = await getExifDate(f);
    newPhotos.push({
      id: uid(), name: f.name, blob: f,
      lastModified: f.lastModified,
      exifYMD: exifDateToYMD(exif),
      wbScore: null, role: 'pending', forceGroupStart: false, thumbUrl: null
    });
  }
  state.photos = state.photos.concat(newPhotos);
  for (const p of newPhotos) { try { await idbPut('photos', p); } catch (e) { console.warn('persist photo failed', e); } }
  renderHome();
}

async function runProcessing() {
  if (!state.photos.length) return;
  document.getElementById('progressWrap').style.display = 'block';
  const fill = document.getElementById('progressFill');
  const label = document.getElementById('progressLabel');
  document.getElementById('btnProcess').disabled = true;

  // 日時順ソート: EXIF日時があれば優先、無ければファイルの更新日時
  state.photos.sort((a, b) => {
    const ta = a.exifYMD ? new Date(a.exifYMD).getTime() : a.lastModified;
    const tb = b.exifYMD ? new Date(b.exifYMD).getTime() : b.lastModified;
    return ta - tb;
  });

  const total = state.photos.length;
  for (let i = 0; i < total; i++) {
    const p = state.photos[i];
    if (p.wbScore === null) {
      const analysis = await analyzeWhiteboard(p.blob);
      p.wbScore = analysis.score;
      p.wbBboxNorm = analysis.bboxNorm;
    }
    if (!p.thumbUrl) {
      const canvas = await downscaleToCanvas(p.blob, 480);
      const thumbBlob = await canvasToBlob(canvas, 'image/jpeg', 0.7);
      p.thumbBlob = thumbBlob;
      p.thumbUrl = URL.createObjectURL(thumbBlob);
    }
    try { await idbPut('photos', p); } catch (e) { console.warn('persist photo failed', e); }
    fill.style.width = Math.round(((i + 1) / total) * 60) + '%';
    label.textContent = `画像解析中… ${i + 1}/${total}`;
    await new Promise(r => setTimeout(r, 0));
  }

  // グループ化
  state.groups = regroupFromPhotoList(state.photos, state.settings.wbThreshold);
  for (const g of state.groups) {
    if (!g.fields) g.fields = { iseki: state.settings.isekiDefault || '', ikou: '', grid: '', houi: '', date: '' };
    if (!g.ocrRaw) g.ocrRaw = '';
  }

  // ホワイトボード写真のみOCR
  let done = 0;
  const wbGroups = state.groups.filter(g => g.hasWhiteboard);
  for (const g of wbGroups) {
    const wb = photoById(g.whiteboardPhotoId);
    if (wb) {
      const cropBlob = await getWhiteboardCropBlob(wb, 1500);
      g.ocrRaw = await ocrPhoto(cropBlob);
      const guessDate = guessDateFromOcr(g.ocrRaw) || wb.exifYMD;
      if (guessDate && !g.fields.date) g.fields.date = guessDate;
    }
    done++;
    fill.style.width = (60 + Math.round((done / Math.max(1, wbGroups.length)) * 40)) + '%';
    label.textContent = `ホワイトボード文字認識中… ${done}/${wbGroups.length}`;
    await new Promise(r => setTimeout(r, 0));
  }

  fill.style.width = '100%';
  label.textContent = '完了';
  await new Promise(r => setTimeout(r, 250));
  document.getElementById('progressWrap').style.display = 'none';
  document.getElementById('btnProcess').disabled = false;

  toast(`${state.groups.length}グループに分割しました。内容を確認してください。`);
  showScreen('review');
}

function guessDateFromOcr(text) {
  if (!text) return null;
  const m = text.match(/(20\d{2})[.\-\/年]\s?(\d{1,2})[.\-\/月]\s?(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${pad(m[2], 2)}-${pad(m[3], 2)}`;
}

function renderReview() {
  const el = document.getElementById('screen-review');
  if (!state.groups.length) {
    el.innerHTML = `<div class="empty"><div class="big">📋</div><div>まだグループがありません。<br>「撮影取込」タブから写真を処理してください。</div></div>`;
    return;
  }
  let html = `<div class="stamp-title">グループ確認・修正</div>
  <p class="small-note">自動検出は完全ではありません。区切り位置がずれている場合は各写真の「ここで分割」を使って修正してください。</p>`;
  state.groups.forEach((g, gi) => {
    const wb = g.whiteboardPhotoId ? photoById(g.whiteboardPhotoId) : null;
    const prodIds = g.photoIds.filter(id => id !== g.whiteboardPhotoId);
    const isOpen = state.openGroupId === g.id;
    const titleParts = [g.fields.iseki, g.fields.ikou].filter(Boolean);
    const title = titleParts.length ? titleParts.join(' / ') : (g.hasWhiteboard ? '(項目未入力)' : '⚠ ホワイトボード未検出');
    const incomplete = !g.fields.iseki || !g.fields.ikou;
    html += `
    <div class="group-item" data-gid="${g.id}">
      <div class="g-head" data-toggle="${g.id}">
        <img class="g-thumb" src="${wb ? wb.thumbUrl : (photoById(g.photoIds[0]) || {}).thumbUrl || ''}">
        <div class="g-info">
          <div class="g-title">G${gi + 1}. ${escapeHtml(title)}</div>
          <div class="g-sub">${g.fields.date || '日付未設定'} ・ 本番写真 ${prodIds.length}枚</div>
        </div>
        <div class="g-badge ${incomplete ? 'warn' : ''}">${incomplete ? '要確認' : 'OK'}</div>
      </div>
      <div class="group-body ${isOpen ? 'open' : ''}" id="body-${g.id}">
        ${g.hasWhiteboard ? `
          <div class="field-row"><label>ホワイトボードOCR認識結果(参考・自動反映はされません)</label>
            <div class="ocr-raw">${escapeHtml(g.ocrRaw || '(文字を検出できませんでした)')}</div>
            <p class="small-note warn">手書き文字はOCRでは正しく読み取れないことが多いため、下の5項目は写真を見ながら直接入力するのが基本です。プレビュー画面内であれば「Claude AIで再解析」の方が手書きも高精度に読み取れます。</p>
          </div>` : `<p class="small-note warn">この一連の写真の先頭にホワイトボード写真が見つかりませんでした。手動で項目を入力するか、下の一覧から該当写真の「ここで分割」を押してください。</p>`}

        <div class="field-row"><label>遺跡名</label><input data-f="iseki" data-g="${g.id}" value="${escapeAttr(g.fields.iseki)}"></div>
        <div class="field-row"><label>遺構名・番号</label><input data-f="ikou" data-g="${g.id}" value="${escapeAttr(g.fields.ikou)}"></div>
        <div class="field-row"><label>グリッド・区画</label><input data-f="grid" data-g="${g.id}" value="${escapeAttr(g.fields.grid)}"></div>
        <div class="field-row"><label>方位</label><input data-f="houi" data-g="${g.id}" value="${escapeAttr(g.fields.houi)}" placeholder="例: 北から / N→S"></div>
        <div class="field-row"><label>撮影年月日</label><input data-f="date" data-g="${g.id}" value="${escapeAttr(g.fields.date)}" placeholder="YYYY-MM-DD"></div>

        ${g.hasWhiteboard ? `<button class="btn ghost" data-claude="${g.id}">Claude AIで再解析<span class="tag-proto">プレビュー限定</span></button>` : ''}

        <div class="field-row" style="margin-top:14px;">
          <label>写真一覧(タップで先頭/末尾に修正・除外)</label>
          <div class="thumb-grid">
            ${g.photoIds.map(id => {
              const ph = photoById(id);
              if (!ph) return '';
              const isWB = id === g.whiteboardPhotoId;
              return `<div class="t-wrap">
                <img class="${isWB ? 't-wb' : ''}" src="${ph.thumbUrl}">
                ${isWB ? '<span class="t-tag">WB</span>' : ''}
                <div class="t-split" data-split="${id}" title="ここで新しいグループに分割">✂</div>
              </div>`;
            }).join('')}
          </div>
        </div>
        <div class="btn-row">
          ${gi > 0 ? `<button class="btn ghost" data-merge-prev="${g.id}">前のグループに統合</button>` : ''}
          <button class="btn ghost" data-delete-group="${g.id}">グループごと除外</button>
        </div>
      </div>
    </div>`;
  });
  el.innerHTML = html;
  wireReviewEvents();
}

function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

function wireReviewEvents() {
  document.querySelectorAll('[data-toggle]').forEach(elm => {
    elm.addEventListener('click', () => {
      const gid = elm.dataset.toggle;
      state.openGroupId = state.openGroupId === gid ? null : gid;
      renderReview();
    });
  });
  document.querySelectorAll('[data-f]').forEach(inp => {
    inp.addEventListener('input', () => {
      const g = state.groups.find(x => x.id === inp.dataset.g);
      if (g) { g.fields[inp.dataset.f] = inp.value; persistGroupsMeta(); }
    });
  });
  document.querySelectorAll('[data-claude]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const g = state.groups.find(x => x.id === btn.dataset.claude);
      const wb = g && photoById(g.whiteboardPhotoId);
      if (!wb) return;
      btn.disabled = true; btn.textContent = '解析中…';
      try {
        const cropBlob = await getWhiteboardCropBlob(wb, 1400);
        const fields = await claudeEnhanceFields(cropBlob);
        g.fields.iseki = fields.iseki || g.fields.iseki;
        g.fields.ikou = fields.ikou || g.fields.ikou;
        g.fields.grid = fields.grid || g.fields.grid;
        g.fields.houi = fields.houi || g.fields.houi;
        g.fields.date = fields.date || g.fields.date;
        toast('Claude AIの解析結果を反映しました');
        renderReview();
      } catch (e) {
        toast('Claude AIでの解析に失敗しました。この機能はClaudeのプレビュー画面内でのみ利用できます(配布版では動作しません)。', 4200);
        btn.disabled = false; btn.innerHTML = 'Claude AIで再解析<span class="tag-proto">プレビュー限定</span>';
      }
    });
  });
  document.querySelectorAll('[data-split]').forEach(elm => {
    elm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      splitGroupAt(elm.dataset.split);
    });
  });
  document.querySelectorAll('[data-merge-prev]').forEach(elm => {
    elm.addEventListener('click', () => mergeWithPrevious(elm.dataset.mergePrev));
  });
  document.querySelectorAll('[data-delete-group]').forEach(elm => {
    elm.addEventListener('click', () => deleteGroup(elm.dataset.deleteGroup));
  });
}

function splitGroupAt(photoId) {
  const gi = state.groups.findIndex(g => g.photoIds.includes(photoId));
  if (gi < 0) return;
  const g = state.groups[gi];
  const idx = g.photoIds.indexOf(photoId);
  if (idx <= 0) { toast('この写真は既にグループの先頭です'); return; }
  const newPhotoIds = g.photoIds.splice(idx);
  const newGroup = {
    id: uid(), whiteboardPhotoId: photoId, photoIds: newPhotoIds, hasWhiteboard: true,
    fields: { iseki: state.settings.isekiDefault || '', ikou: '', grid: '', houi: '', date: '' }, ocrRaw: ''
  };
  state.groups.splice(gi + 1, 0, newGroup);
  state.openGroupId = newGroup.id;
  persistGroupsMeta();
  renderReview();
  toast('グループを分割しました。新しいグループのOCRは自動実行されません(必要ならClaude AI再解析を利用)');
}

function mergeWithPrevious(groupId) {
  const gi = state.groups.findIndex(g => g.id === groupId);
  if (gi <= 0) return;
  const g = state.groups[gi];
  const prev = state.groups[gi - 1];
  prev.photoIds = prev.photoIds.concat(g.photoIds);
  state.groups.splice(gi, 1);
  persistGroupsMeta();
  renderReview();
  toast('前のグループに統合しました');
}

function deleteGroup(groupId) {
  if (!confirm('このグループを台帳から除外します。よろしいですか？')) return;
  state.groups = state.groups.filter(g => g.id !== groupId);
  persistGroupsMeta();
  renderReview();
}

/* ---------- 8. Export ---------- */
function buildFileName(template, fields, seq, ext) {
  const map = {
    iseki: sanitizeToken(fields.iseki),
    ikou: sanitizeToken(fields.ikou),
    grid: sanitizeToken(fields.grid),
    houi: sanitizeToken(fields.houi),
    date: sanitizeToken(fields.date),
    seq: pad(seq, 3)
  };
  let name = template.replace(/\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? map[k] : ''));
  name = name.replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!name) name = 'photo_' + map.seq;
  return name + '.' + ext;
}

function renderExport() {
  const el = document.getElementById('screen-export');
  if (!state.groups.length) {
    el.innerHTML = `<div class="empty"><div class="big">📦</div><div>グループが未作成です。<br>先に「撮影取込」「グループ確認」を行ってください。</div></div>`;
    return;
  }
  const totalProd = state.groups.reduce((n, g) => n + g.photoIds.filter(id => id !== g.whiteboardPhotoId).length, 0);
  const incompleteCount = state.groups.filter(g => !g.fields.iseki || !g.fields.ikou).length;

  const preview = [];
  state.groups.forEach(g => {
    let seq = 1;
    g.photoIds.filter(id => id !== g.whiteboardPhotoId).slice(0, 2).forEach(id => {
      preview.push(buildFileName(state.settings.namingTemplate, g.fields, seq++, 'jpg'));
    });
  });

  el.innerHTML = `
    <div class="card accent">
      <h2><span class="num">✓</span>書き出しサマリー</h2>
      <p class="small-note">グループ数: ${state.groups.length} ／ 本番写真: ${totalProd}枚 ${incompleteCount ? `<br><span style="color:#7a4e12">⚠ 項目未入力のグループが${incompleteCount}件あります(「グループ確認」タブで確認してください)</span>` : ''}</p>
      <div class="field-row"><label>ファイル名プレビュー(命名規則は設定タブで変更できます)</label>
        <div class="ocr-raw">${preview.slice(0, 8).join('\n')}${preview.length > 8 ? '\n…他' : ''}</div>
      </div>
    </div>
    <div class="card">
      <h2><span class="num">2</span>ダウンロード</h2>
      <div class="btn-row" style="margin-bottom:10px;">
        <button class="btn shu" id="btnExportZip">リネーム写真(ZIP)</button>
        <button class="btn shu" id="btnExportXlsx">写真台帳(Excel)</button>
      </div>
      <button class="btn secondary" id="btnExportBoth">両方まとめてダウンロード</button>
      <div class="progress-wrap" id="exProgressWrap" style="display:none;">
        <div class="progress-bar"><div class="fill" id="exProgressFill"></div></div>
        <div class="progress-label" id="exProgressLabel"></div>
      </div>
    </div>
  `;
  document.getElementById('btnExportZip').addEventListener('click', () => doExport({ zip: true, xlsx: false }));
  document.getElementById('btnExportXlsx').addEventListener('click', () => doExport({ zip: false, xlsx: true }));
  document.getElementById('btnExportBoth').addEventListener('click', () => doExport({ zip: true, xlsx: true }));
}

async function doExport({ zip, xlsx }) {
  const wrap = document.getElementById('exProgressWrap');
  const fill = document.getElementById('exProgressFill');
  const label = document.getElementById('exProgressLabel');
  wrap.style.display = 'block';

  // renamed file plan
  const plan = []; // {photo, fileName, group, role, seq}
  const usedNames = new Set();
  function dedupe(name) {
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : '';
    let n = 2, candidate;
    do { candidate = `${base}-${n}${ext}`; n++; } while (usedNames.has(candidate));
    usedNames.add(candidate);
    return candidate;
  }
  state.groups.forEach(g => {
    let seq = 1;
    g.photoIds.forEach(id => {
      const ph = photoById(id);
      if (!ph) return;
      const isWB = id === g.whiteboardPhotoId;
      const ext = (ph.name.split('.').pop() || 'jpg').toLowerCase();
      let fileName;
      if (isWB) {
        const base = ['iseki', 'ikou', 'grid', 'houi', 'date']
          .map(k => sanitizeToken(g.fields[k])).filter(Boolean).join('_');
        fileName = (base || 'group') + '_WB.' + ext;
      } else {
        fileName = buildFileName(state.settings.namingTemplate, g.fields, seq++, ext);
      }
      fileName = dedupe(fileName);
      plan.push({ photo: ph, fileName, group: g, isWB });
    });
  });

  if (zip) {
    label.textContent = 'ZIP作成中…';
    const jz = new JSZip();
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      jz.file(item.fileName, item.photo.blob);
      fill.style.width = Math.round(((i + 1) / plan.length) * (xlsx ? 60 : 100)) + '%';
      label.textContent = `ZIP作成中… ${i + 1}/${plan.length}`;
      if (i % 15 === 0) await new Promise(r => setTimeout(r, 0));
    }
    const zipBlob = await jz.generateAsync({ type: 'blob' }, (meta) => {
      label.textContent = `圧縮中… ${Math.round(meta.percent)}%`;
    });
    downloadBlob(zipBlob, `写真_${todayStr()}.zip`);
  }

  if (xlsx) {
    label.textContent = 'Excel台帳作成中…';
    fill.style.width = xlsx && zip ? '70%' : '30%';
    const blob = await buildLedgerXlsx(plan, (p) => {
      fill.style.width = (zip ? 60 : 0) + Math.round(p * (zip ? 40 : 100)) + '%';
      label.textContent = `Excel台帳作成中… ${Math.round(p * 100)}%`;
    });
    downloadBlob(blob, `写真台帳_${todayStr()}.xlsx`);
  }

  fill.style.width = '100%';
  label.textContent = '完了しました';
  setTimeout(() => { wrap.style.display = 'none'; }, 1500);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

async function buildLedgerXlsx(plan, onProgress) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '発掘調査支援ツール';
  wb.created = new Date();

  const sheet1 = wb.addWorksheet('写真台帳');
  sheet1.columns = [
    { header: '通し番号', key: 'no', width: 8 },
    { header: '遺跡名', key: 'iseki', width: 16 },
    { header: '遺構名・番号', key: 'ikou', width: 16 },
    { header: 'グリッド・区画', key: 'grid', width: 14 },
    { header: '方位', key: 'houi', width: 10 },
    { header: '撮影年月日', key: 'date', width: 12 },
    { header: 'コマ', key: 'seq', width: 6 },
    { header: '写真', key: 'photo', width: 16 },
    { header: 'ファイル名', key: 'fname', width: 30 },
    { header: '備考', key: 'note', width: 16 }
  ];
  sheet1.getRow(1).font = { bold: true };
  sheet1.getRow(1).height = 20;

  const sheet2 = wb.addWorksheet('グループ一覧(ホワイトボード)');
  sheet2.columns = [
    { header: 'グループ', key: 'g', width: 8 },
    { header: '遺跡名', key: 'iseki', width: 16 },
    { header: '遺構名・番号', key: 'ikou', width: 16 },
    { header: 'グリッド・区画', key: 'grid', width: 14 },
    { header: '方位', key: 'houi', width: 10 },
    { header: '撮影年月日', key: 'date', width: 12 },
    { header: 'ホワイトボード写真', key: 'photo', width: 16 },
    { header: 'OCR認識結果', key: 'ocr', width: 30 },
    { header: '本番写真枚数', key: 'cnt', width: 10 }
  ];
  sheet2.getRow(1).font = { bold: true };
  sheet2.getRow(1).height = 20;

  let no = 1;
  const prodPlan = plan.filter(p => !p.isWB);
  for (let i = 0; i < prodPlan.length; i++) {
    const item = prodPlan[i];
    const row = sheet1.addRow({
      no: no,
      iseki: item.group.fields.iseki,
      ikou: item.group.fields.ikou,
      grid: item.group.fields.grid,
      houi: item.group.fields.houi,
      date: item.group.fields.date,
      seq: 0, // 後段の「コマ振り直し」処理で正しい値に上書きされる
      fname: item.fileName,
      note: ''
    });
    row.height = 60;
    try {
      const canvas = await downscaleToCanvas(item.photo.blob, 200);
      const thumbBlob = await canvasToBlob(canvas, 'image/jpeg', 0.75);
      const ab = await blobToArrayBuffer(thumbBlob);
      const imgId = wb.addImage({ buffer: new Uint8Array(ab), extension: 'jpeg' });
      sheet1.addImage(imgId, { tl: { col: 7, row: row.number - 1 }, ext: { width: 70, height: 52 } });
    } catch (e) { console.error('thumb embed error', e); }
    no++;
    if (onProgress) onProgress(i / prodPlan.length);
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
  }
  // コマ(グループ内連番)を正しく振り直し
  let running = 0, curGroupId = null, seqInGroup = 0;
  sheet1.eachRow((row, idx) => {
    if (idx === 1) return;
    const item = prodPlan[idx - 2];
    if (!item) return;
    if (item.group.id !== curGroupId) { curGroupId = item.group.id; seqInGroup = 0; }
    seqInGroup++;
    row.getCell('seq').value = seqInGroup;
  });

  for (let gi = 0; gi < state.groups.length; gi++) {
    const g = state.groups[gi];
    const prodCount = g.photoIds.filter(id => id !== g.whiteboardPhotoId).length;
    const row = sheet2.addRow({
      g: gi + 1, iseki: g.fields.iseki, ikou: g.fields.ikou, grid: g.fields.grid,
      houi: g.fields.houi, date: g.fields.date, ocr: (g.ocrRaw || '').slice(0, 120), cnt: prodCount
    });
    row.height = 60;
    const wbPhoto = g.whiteboardPhotoId ? photoById(g.whiteboardPhotoId) : null;
    if (wbPhoto) {
      try {
        const canvas = await downscaleToCanvas(wbPhoto.blob, 200);
        const thumbBlob = await canvasToBlob(canvas, 'image/jpeg', 0.75);
        const ab = await blobToArrayBuffer(thumbBlob);
        const imgId = wb.addImage({ buffer: new Uint8Array(ab), extension: 'jpeg' });
        sheet2.addImage(imgId, { tl: { col: 6, row: row.number - 1 }, ext: { width: 70, height: 52 } });
      } catch (e) { console.error('thumb embed error', e); }
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ---------- Settings screen ---------- */
function renderSettings() {
  const el = document.getElementById('screen-settings');
  el.innerHTML = `
    <div class="card">
      <h2><span class="num">設</span>基本設定</h2>
      <div class="field-row"><label>遺跡名(初期値)</label>
        <input id="setIseki" value="${escapeAttr(state.settings.isekiDefault)}"></div>
      <div class="field-row"><label>ファイル命名規則</label>
        <input id="setTemplate" value="${escapeAttr(state.settings.namingTemplate)}"></div>
      <p class="small-note">使えるトークン: {iseki} {ikou} {grid} {houi} {date} {seq}(3桁連番)</p>
      <div class="field-row"><label>ホワイトボード自動検出のしきい値(0.2〜0.8、低いほど検出されやすくなりますが誤検出も増えます)</label>
        <input id="setThreshold" type="number" min="0.2" max="0.8" step="0.05" value="${state.settings.wbThreshold}"></div>
      <button class="btn shu" id="btnSaveSettings">設定を保存</button>
    </div>
    <div class="card">
      <h2><span class="num">i</span>このアプリについて</h2>
      <p class="small-note">
      ・ホワイトボード検出とファイル分割・命名処理はすべて端末内(ブラウザ)で完結し、写真データが外部に送信されることはありません。<br>
      ・「Claude AIで再解析」ボタンはこのチャット(Claudeのプレビュー画面)内でのみ動作するプロトタイプ機能です。GitHub Pages等に配置した配布版では動作しません。<br>
      ・OCR(文字認識)はTesseract.jsを使用しており、手書き文字の認識精度には限界があります。抽出結果は必ず目視確認してください。
      </p>
    </div>
    <div class="card">
      <h2><span class="num">!</span>データ管理</h2>
      <button class="btn ghost" id="btnResetAll">読み込んだ写真・グループをすべて消去</button>
    </div>
  `;
  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    state.settings.isekiDefault = document.getElementById('setIseki').value;
    state.settings.namingTemplate = document.getElementById('setTemplate').value || '{iseki}_{ikou}_{grid}_{houi}_{date}_{seq}';
    let th = parseFloat(document.getElementById('setThreshold').value);
    if (isNaN(th)) th = WB_THRESHOLD_DEFAULT;
    state.settings.wbThreshold = Math.max(0.2, Math.min(0.8, th));
    await saveSettings();
    toast('設定を保存しました');
  });
  document.getElementById('btnResetAll').addEventListener('click', async () => {
    if (!confirm('読み込んだ写真とグループ情報をすべて消去します。よろしいですか？')) return;
    state.photos = []; state.groups = []; state.openGroupId = null;
    await idbClear('photos'); await idbClear('groups');
    toast('消去しました');
    showScreen('home');
  });
}

/* ---------- 9. Boot ---------- */
function wireNav() {
  document.querySelectorAll('nav.bottom button').forEach(b => {
    b.addEventListener('click', () => showScreen(b.dataset.screen));
  });
  document.getElementById('btnSettingsTop').addEventListener('click', () => showScreen('settings'));
}

async function boot() {
  wireNav();
  await loadSettings();
  try {
    const savedPhotos = await idbGetAll('photos');
    if (savedPhotos.length) {
      for (const p of savedPhotos) {
        if (p.thumbBlob) { try { p.thumbUrl = URL.createObjectURL(p.thumbBlob); } catch (e) { p.thumbUrl = null; } }
      }
      state.photos = savedPhotos;
    }
    const savedGroups = await idbGetAll('groups');
    if (savedGroups.length) state.groups = savedGroups;
    if (state.photos.length) toast(`前回の続きを復元しました(写真${state.photos.length}枚)`);
  } catch (e) { console.warn('restore failed', e); }
  renderHome();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW register failed', e); }
  }
}
document.addEventListener('DOMContentLoaded', boot);
