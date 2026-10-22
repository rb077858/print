import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, setDoc, writeBatch, serverTimestamp, Bytes,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const ADMIN_EMAIL = 'rb077858@gmail.com';
export const CHUNK_SIZE = 750 * 1024; // מסמך ב-Firestore מוגבל ל-1MB
export const MAX_SIZE = 15 * 1024 * 1024;
export const ACCEPT = '.pdf,application/pdf,image/*,.txt,text/plain';

export async function ensureUser() {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

export function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function isPrintable(file) {
  const t = file.type || '';
  const n = file.name.toLowerCase();
  return t === 'application/pdf' || n.endsWith('.pdf') || t.startsWith('image/') || t === 'text/plain' || n.endsWith('.txt');
}

// שומר קובץ ב-Firestore כרצף של חתיכות (chunks)
export async function uploadFile(file, source, onProgress) {
  if (file.size > MAX_SIZE) throw new Error('הקובץ גדול מדי (מקסימום ' + formatSize(MAX_SIZE) + ')');
  const user = await ensureUser();
  const ref = doc(collection(db, 'files'));
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  await setDoc(ref, {
    name: file.name,
    type: file.type || '',
    size: file.size,
    chunks,
    owner: user.uid,
    createdAt: serverTimestamp(),
    source,
  });
  const buf = new Uint8Array(await file.arrayBuffer());
  for (let i = 0; i < chunks; i++) {
    const part = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await setDoc(doc(db, 'files', ref.id, 'chunks', String(i)), { d: Bytes.fromUint8Array(part) });
    onProgress?.((i + 1) / chunks);
  }
  return ref.id;
}

export async function downloadFile(fileId) {
  const meta = await getDoc(doc(db, 'files', fileId));
  if (!meta.exists()) throw new Error('הקובץ לא נמצא');
  const m = meta.data();
  const parts = await Promise.all(
    Array.from({ length: m.chunks }, (_, i) => getDoc(doc(db, 'files', fileId, 'chunks', String(i)))),
  );
  const blob = new Blob(parts.map((p) => p.data().d.toUint8Array()), { type: m.type || 'application/octet-stream' });
  return { id: fileId, name: m.name, type: m.type, blob };
}

// מחזיר null אם הקוד תקף, אחרת הודעת שגיאה
export function codeProblem(c) {
  if (!c) return 'הקוד לא קיים';
  if (!c.fileIds || c.fileIds.length === 0) return 'אין קבצים בקוד הזה';
  if (c.singleUse && c.used) return 'הקוד כבר נוצל';
  if (c.ttlMinutes > 0) {
    const created = c.createdAt?.toMillis?.() ?? Date.now();
    if (Date.now() > created + c.ttlMinutes * 60000) return 'פג תוקף הקוד';
  }
  return null;
}

export async function fetchCode(code) {
  await ensureUser();
  const snap = await getDoc(doc(db, 'codes', code));
  return snap.exists() ? snap.data() : null;
}

// מממש את הקוד (מסמן כמשומש אם הוא חד-פעמי) ומקבל הרשאה לקרוא את הקבצים
export async function redeemCode(code, c) {
  const user = await ensureUser();
  const batch = writeBatch(db);
  if (c.singleUse) {
    batch.update(doc(db, 'codes', code), { used: true, usedBy: user.uid, usedAt: serverTimestamp() });
  }
  batch.set(doc(db, 'claims', user.uid), { code, fileIds: c.fileIds, at: serverTimestamp() });
  await batch.commit();
}

// ---------- הדפסה ----------

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

async function pdfToImages(blob) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const urls = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const img = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    urls.push(URL.createObjectURL(img));
  }
  return urls;
}

// מכין מסמך הדפסה ב-iframe נסתר ופותח את חלונית ההדפסה של כרום.
// מחזיר Promise שמתממש כשהחלונית נסגרה.
export async function printFile({ name, type, blob }) {
  const lower = name.toLowerCase();
  const urls = [];
  let body;
  if (type === 'application/pdf' || lower.endsWith('.pdf')) {
    urls.push(...(await pdfToImages(blob)));
    body = urls.map((u) => `<div class="pg"><img src="${u}"></div>`).join('');
  } else if (type?.startsWith('image/')) {
    urls.push(URL.createObjectURL(blob));
    body = `<div class="pg"><img src="${urls[0]}"></div>`;
  } else {
    body = `<pre>${escapeHtml(await blob.text())}</pre>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    .pg { width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; break-after: page; overflow: hidden; }
    .pg:last-child { break-after: auto; }
    .pg img { width: 100%; height: 100%; object-fit: contain; }
    pre { white-space: pre-wrap; font: 12pt/1.4 monospace; margin: 15mm; }
  </style></head><body>${body}</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  await new Promise((r) => {
    iframe.onload = r;
    iframe.srcdoc = html;
  });
  const w = iframe.contentWindow;
  await Promise.all([...w.document.images].map((img) => img.decode().catch(() => {})));

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    w.addEventListener('afterprint', finish, { once: true });
    w.focus();
    const t0 = Date.now();
    w.print();
    // בכרום print() חוסם עד שהחלונית נסגרת
    if (Date.now() - t0 > 150) finish();
  });

  setTimeout(() => {
    iframe.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }, 1000);
}

export async function printSequentially(files, onStep) {
  for (let i = 0; i < files.length; i++) {
    onStep?.(i, files[i]);
    await printFile(files[i]);
  }
}
