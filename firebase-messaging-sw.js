/* GTR: web push (FCM, yalnızca veri mesajı) */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch(_){}const x=d.data||d;e.waitUntil(self.registration.showNotification(x.title||'Grand Traffic Racing · Yeni sürüm yayında',{body:x.body||'',icon:'icons/icon-192.png',badge:'icons/badge-96.png',data:{url:'./'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c)return c.focus()}return self.clients.openWindow('./')}))});
