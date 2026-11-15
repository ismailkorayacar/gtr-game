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
let cred;
try {
  // Telefondan yapıştırmada private_key içindeki satır sonları bozulabiliyor: PEM gövdesini onarıp JSON'a uygun yaz
  let raw = sa.trim();
  const m = raw.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----(?:\\n|\s)*/);
  if (m) {
    const body = m[1].replace(/\\n|\s/g, '');
    console.log('private_key gövde uzunluğu: ' + body.length + ' karakter (2048-bit Google anahtarı için yaklaşık 1624 olmalı)');
    raw = raw.replace(m[0], '-----BEGIN PRIVATE KEY-----\\n' + body.match(/.{1,64}/g).join('\\n') + '\\n-----END PRIVATE KEY-----\\n');
  }
  const sj = JSON.parse(raw);
  console.log('Servis hesabı: ' + sj.client_email + ' · proje: ' + sj.project_id);
  cred = admin.credential.cert(sj);
}
catch (e) { console.error('HATA [SECRET]: FIREBASE_SERVICE_ACCOUNT geçerli bir servis hesabı JSON\'u değil. İndirdiğin JSON dosyasının TAMAMINI ({ ile başlayıp } ile biten) yapıştırdığından emin ol. Ayrıntı: ' + e.message); process.exit(1); }
admin.initializeApp({ credential: cred });
let snap;
try { snap = await admin.firestore().collection('pt').get(); }
catch (e) { console.error('HATA [FIRESTORE okuma]: ' + (e.code || '') + ' ' + e.message + '\nOlası sebepler: Firestore veritabanı yok / servis hesabı başka projeye ait / Cloud Firestore API kapalı. Secret\'taki projenin gtr-game-61874 olduğunu kontrol et.'); process.exit(1); }
const tokens = snap.docs.filter(d => !d.data().off).map(d => d.id);
console.log('Kayıtlı cihaz:', tokens.length);
if (!tokens.length) process.exit(0);
const body = ver.v + ' yayında' + (ver.n && ver.n[0] ? ' · ' + ver.n[0] : '');
let ok = 0, bad = [];
for (let i = 0; i < tokens.length; i += 500) {
  const chunk = tokens.slice(i, i + 500);
  let res;
  try { res = await admin.messaging().sendEachForMulticast({ tokens: chunk, data: { title: 'Grand Traffic Racing · Yeni sürüm yayında', body: String(ver.v) }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } }); }
  catch (e) { console.error('HATA [FCM gönderim]: ' + (e.code || '') + ' ' + e.message + '\nOlası sebep: Firebase Cloud Messaging API (V1) kapalı veya servis hesabının yetkisi yok.'); process.exit(1); }
  res.responses.forEach((r, k) => { if (r.success) ok++; else { console.log('Token hatası:', r.error?.code, r.error?.message); if (/not-registered|invalid-argument|invalid-registration/.test(r.error?.code || '')) bad.push(chunk[k]); } });
}
for (const t of bad) await admin.firestore().collection('pt').doc(t).delete();
console.log('Gönderildi:', ok, 'Silinen geçersiz kayıt:', bad.length);
