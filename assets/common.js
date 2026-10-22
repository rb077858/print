import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, writeBatch, serverTimestamp, Bytes, query, where,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js?v=7';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const ADMIN_EMAIL = 'rb077858@gmail.com';
export const CHUNK_SIZE = 750 * 1024; // מסמך ב-Firestore מוגבל ל-1MB
export const MAX_SIZE = 15 * 1024 * 1024;
export const ACCEPT = '.pdf,application/pdf,image/*,.txt,text/plain';
export const FILE_CODE_TTL = 1440; // דקות (24 שעות)

export async function ensureUser() {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

export function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

// קוד אקראי של 6 ספרות שעוד לא תפוס
export async function freeRandomCode() {
  for (;;) {
    const id = randomCode();
    if (!(await getDoc(doc(db, 'codes', id))).exists()) return id;
  }
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

export const ms = (ts) => ts?.toMillis?.() ?? 0;

// ---------- משתמשים ----------

// מצב ההרשאה של משתמש מחובר: 'login' | 'pending' | 'blocked' | 'expired' | 'ok'
export async function senderState(user) {
  if (!user || user.isAnonymous) return { state: 'login' };
  const ref = doc(db, 'users', user.email);
  let snap = await getDoc(ref);
  if (!snap.exists()) {
    // המנהל הוא גם משתמש רגיל עם תור משלו
    const admin = user.email === ADMIN_EMAIL;
    await setDoc(ref, { name: user.displayName ?? '', requestedAt: serverTimestamp(), approved: admin, blocked: false, activeUntil: null });
    snap = await getDoc(ref);
  }
  const u = snap.data();
  if (user.email === ADMIN_EMAIL) return { state: 'ok', u };
  if (u.blocked) return { state: 'blocked', u };
  if (!u.approved) return { state: 'pending', u };
  if (u.activeUntil && ms(u.activeUntil) < Date.now()) return { state: 'expired', u };
  return { state: 'ok', u };
}

// מחליף (או יוצר) את הקוד האישי של המשתמש המחובר
export async function resetPersonalCode(oldCode) {
  const user = auth.currentUser;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = await freeRandomCode();
    const batch = writeBatch(db);
    if (oldCode) batch.delete(doc(db, 'codes', oldCode));
    batch.set(doc(db, 'codes', code), { kind: 'personal', email: user.email, createdAt: serverTimestamp() });
    batch.update(doc(db, 'users', user.email), { personalCode: code });
    try {
      await batch.commit();
      return code;
    } catch (err) {
      if (err.code !== 'permission-denied' || attempt === 7) throw err;
    }
  }
}

// ---------- קבצים ----------

// שומר קובץ בתור של המשתמש (תוכן בחתיכות) ויוצר לו קוד חד-פעמי ל-24 שעות
export async function uploadToQueue(file, onProgress) {
  if (file.size > MAX_SIZE) throw new Error('הקובץ גדול מדי (מקסימום ' + formatSize(MAX_SIZE) + ')');
  const user = auth.currentUser;
  const ref = doc(collection(db, 'files'));
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  await setDoc(ref, {
    name: file.name,
    type: file.type || '',
    size: file.size,
    chunks,
    owner: user.uid,
    ownerEmail: user.email,
    createdAt: serverTimestamp(),
    source: 'user',
    inQueue: true,
    code: null,
  });
  const buf = new Uint8Array(await file.arrayBuffer());
  for (let i = 0; i < chunks; i++) {
    const part = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await setDoc(doc(db, 'files', ref.id, 'chunks', String(i)), { d: Bytes.fromUint8Array(part) });
    onProgress?.((i + 1) / chunks);
  }
  const code = await createFileCode(ref.id, null);
  return { id: ref.id, code };
}

// יוצר קוד חדש לקובץ של המשתמש ומצמיד אותו לקובץ. מותר רק כשלקובץ אין קוד בתוקף;
// הקוד הישן (שפג או נוצל) נמחק.
export async function createFileCode(fileId, oldCode) {
  const user = auth.currentUser;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const batch = writeBatch(db);
    // אם הקוד כבר תפוס הכתיבה תיחשב כעדכון ותידחה, ואז ננסה קוד אחר
    if (oldCode) batch.delete(doc(db, 'codes', oldCode));
    batch.set(doc(db, 'codes', code), {
      kind: 'file',
      fileId,
      ownerEmail: user.email,
      singleUse: true,
      ttlMinutes: FILE_CODE_TTL,
      used: false,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    });
    batch.update(doc(db, 'files', fileId), { code });
    try {
      await batch.commit();
      return code;
    } catch (err) {
      if (err.code !== 'permission-denied') throw err;
    }
  }
  throw new Error('לא הצלחנו ליצור קוד, נסו שוב');
}

export async function downloadFile(fileId, meta) {
  let m = meta;
  if (!m) {
    const snap = await getDoc(doc(db, 'files', fileId));
    if (!snap.exists()) throw new Error('הקובץ לא נמצא');
    m = snap.data();
  }
  const parts = await Promise.all(
    Array.from({ length: m.chunks }, (_, i) => getDoc(doc(db, 'files', fileId, 'chunks', String(i)))),
  );
  const blob = new Blob(parts.map((p) => p.data().d.toUint8Array()), { type: m.type || 'application/octet-stream' });
  return { id: fileId, name: m.name, type: m.type, blob };
}

// ---------- קודים ----------

// סטטוס של קוד: 'active' | 'used' | 'expired' | 'missing'
export function codeStatus(c) {
  if (!c) return 'missing';
  if (c.kind === 'master' || c.kind === 'personal') return 'active';
  if (c.singleUse && c.used) return 'used';
  if (c.ttlMinutes > 0 && Date.now() > expiresAt(c)) return 'expired';
  return 'active';
}

export function expiresAt(c) {
  if (!c.ttlMinutes) return Infinity;
  return (c.createdAt?.toMillis?.() ?? Date.now()) + c.ttlMinutes * 60000;
}

const PROBLEMS = { missing: 'הקוד לא קיים', used: 'הקוד כבר נוצל', expired: 'פג תוקף הקוד' };
export const codeProblem = (c) => PROBLEMS[codeStatus(c)] ?? null;

export async function fetchCode(code) {
  await ensureUser();
  const snap = await getDoc(doc(db, 'codes', code));
  return snap.exists() ? snap.data() : null;
}

// מימוש קוד של קובץ: מסמן אותו כמשומש, מוציא את הקובץ מהתור ומקבל הרשאה להוריד אותו
export async function redeemFileCode(code, c) {
  const user = await ensureUser();
  const batch = writeBatch(db);
  if (c.singleUse) {
    batch.update(doc(db, 'codes', code), { used: true, usedBy: user.uid, usedAt: serverTimestamp() });
    batch.update(doc(db, 'files', c.fileId), { inQueue: false, printedAt: serverTimestamp(), printedBy: user.uid });
  }
  batch.set(doc(db, 'access', c.fileId + '_' + user.uid), { fileId: c.fileId, code, at: serverTimestamp() });
  await batch.commit();
}

// הוכחה שהוזן קוד אישי (email) או קוד מאסטר ('*'), ל-30 דקות
export async function claim(code, email) {
  const user = await ensureUser();
  await setDoc(doc(db, 'claims', user.uid), { code, email, at: serverTimestamp() });
}

// הקבצים שבתור (של משתמש אחד, או של כולם), כל אחד עם מצב הקוד שלו, לפי סדר ההעלאה
export async function fetchQueue(email) {
  const q = email
    ? query(collection(db, 'files'), where('ownerEmail', '==', email), where('inQueue', '==', true))
    : query(collection(db, 'files'), where('inQueue', '==', true));
  const snap = await getDocs(q);
  const files = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  await Promise.all(files.map(async (f) => {
    const c = f.code ? (await getDoc(doc(db, 'codes', f.code))).data() : null;
    f.codeData = c ?? null;
    f.codeActive = codeStatus(c) === 'active' && c?.kind === 'file';
  }));
  return files;
}

// מוציא קובץ מהתור (ומנצל את הקוד שלו אם הוא עוד בתוקף). מחזיר false אם מישהו הקדים.
export async function markPrinted(f) {
  const user = await ensureUser();
  const batch = writeBatch(db);
  if (f.codeActive && f.codeData.singleUse) {
    batch.update(doc(db, 'codes', f.code), { used: true, usedBy: user.uid, usedAt: serverTimestamp() });
  }
  batch.update(doc(db, 'files', f.id), { inQueue: false, printedAt: serverTimestamp(), printedBy: user.uid });
  try {
    await batch.commit();
    return true;
  } catch (err) {
    // אולי הקוד פג בדיוק עכשיו: מנסים להוציא מהתור בלי לנצל אותו
    if (!f.codeActive) { console.warn('skipped', f.id, err); return false; }
    try {
      await setDoc(doc(db, 'files', f.id), { inQueue: false, printedAt: serverTimestamp(), printedBy: user.uid }, { merge: true });
      return true;
    } catch (err2) {
      console.warn('skipped', f.id, err2);
      return false;
    }
  }
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
// header: שורה קטנה בראש כל עמוד (למשל שם ומייל של בעל הקובץ)
export async function printFile({ name, type, blob, header }) {
  const lower = name.toLowerCase();
  const hdr = header ? `<div class="hdr">${escapeHtml(header)}</div>` : '';
  const urls = [];
  let body;
  if (type === 'application/pdf' || lower.endsWith('.pdf')) {
    urls.push(...(await pdfToImages(blob)));
    body = urls.map((u) => `<div class="pg">${hdr}<div class="im"><img src="${u}"></div></div>`).join('');
  } else if (type?.startsWith('image/')) {
    urls.push(URL.createObjectURL(blob));
    body = `<div class="pg">${hdr}<div class="im"><img src="${urls[0]}"></div></div>`;
  } else {
    body = `${hdr}<pre>${escapeHtml(await blob.text())}</pre>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    .pg { width: 100%; height: 100vh; display: flex; flex-direction: column; break-after: page; overflow: hidden; }
    .pg:last-child { break-after: auto; }
    .im { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
    .im img { width: 100%; height: 100%; object-fit: contain; }
    .hdr { flex: none; font: 8.5pt/1 Arial, sans-serif; color: #444; text-align: center; padding: 2.5mm 0 1.5mm; direction: rtl; unicode-bidi: plaintext; }
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
    if (Date.now() - t0 > 150) return finish();
    // גיבוי: אם לא נחסם ולא הגיע afterprint, ממשיכים כשהחלון חוזר לפוקוס או אחרי דקה
    window.addEventListener('focus', finish, { once: true });
    setTimeout(finish, 60000);
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
