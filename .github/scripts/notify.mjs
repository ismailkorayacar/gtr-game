import fs from 'fs';
import admin from 'firebase-admin';
const ver = JSON.parse(fs.readFileSync('version.json', 'utf8'));
const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) { console.log('FIREBASE_SERVICE_ACCOUNT secret tanımlı değil, bildirim gönderilmedi.'); process.exit(0); }
// GitHub Pages yeni sürümü yayınlayana kadar bekle (en fazla 12 dk)
const url = process.env.SITE_URL + 'version.json?t=';
let live = false;
for (let i = 0; i < 72 && !live; i++) {
  try { const r = await fetch(url + Date.now(), { cache: 'no-store' }); if (r.ok) live = (await r.json()).v === ver.v; } catch (e) {}
  if (!live) await new Promise(r => setTimeout(r, 10000));
}
if (!live) console.log('Uyarı: canlı sitede ' + ver.v + ' henüz görünmüyor, yine de gönderiliyor.');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
const snap = await admin.firestore().collection('pt').get();
const tokens = snap.docs.map(d => d.id);
console.log('Kayıtlı cihaz:', tokens.length);
if (!tokens.length) process.exit(0);
const body = ver.v + ' yayında' + (ver.n && ver.n[0] ? ' · ' + ver.n[0] : '');
let ok = 0, bad = [];
for (let i = 0; i < tokens.length; i += 500) {
  const chunk = tokens.slice(i, i + 500);
  const res = await admin.messaging().sendEachForMulticast({ tokens: chunk, data: { title: 'Grand Traffic Racing · Yeni sürüm', body }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } });
  res.responses.forEach((r, k) => { if (r.success) ok++; else if (/not-registered|invalid-argument|invalid-registration/.test(r.error?.code || '')) bad.push(chunk[k]); });
}
for (const t of bad) await admin.firestore().collection('pt').doc(t).delete();
console.log('Gönderildi:', ok, 'Silinen geçersiz kayıt:', bad.length);
