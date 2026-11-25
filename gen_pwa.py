# Generates PWA files: icons, manifest and service worker (run by build.sh)
import json, math
from PIL import Image, ImageDraw
def icon(n):
    im = Image.new('RGB', (n, n)); d = ImageDraw.Draw(im)
    for y in range(n):
        t = y / n; c = (int(40 + 200 * t), int(60 + 90 * t), int(110 - 20 * t)) if t < 0.62 else (int(24 + 20 * (t - .62)), int(70 + 40 * (t - .62)), int(80 + 30 * (t - .62)))
        d.line([(0, y), (n, y)], fill=c)
    s = n / 512
    d.ellipse([256 * s - 70 * s, 250 * s, 256 * s + 70 * s, 390 * s], fill=(255, 205, 120))
    d.rectangle([0, 318 * s, n, n], fill=(28, 74, 86))
    d.polygon([(0, 318 * s), (110 * s, 230 * s), (200 * s, 300 * s), (290 * s, 210 * s), (400 * s, 290 * s), (512 * s, 240 * s), (512 * s, 318 * s)], fill=(52, 74, 70))
    d.ellipse([150 * s, 330 * s, 362 * s, 392 * s], fill=(70, 110, 48))
    for x, h in [(205, 70), (250, 95), (300, 60)]:
        d.polygon([(x * s, (360 - h) * s), ((x - 22) * s, 362 * s), ((x + 22) * s, 362 * s)], fill=(34, 70, 36))
    return im
for n in (192, 512): icon(n).save(f'icon-{n}.png')
ver = json.load(open('package.json'))['version']
json.dump({"name": "Остров на реке", "short_name": "Остров", "start_url": "./", "scope": "./", "display": "fullscreen",
           "orientation": "any", "background_color": "#16211b", "theme_color": "#1b2a22", "lang": "ru",
           "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}]},
          open('manifest.webmanifest', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open('sw.js', 'w').write(f"""// Offline cache for the island scene (version {ver})
const CACHE = 'island-{ver}';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {{ e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); }});
self.addEventListener('activate', (e) => {{ e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); }});
self.addEventListener('fetch', (e) => {{
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {{
    // network first so a new version arrives as soon as it is online; cache as fallback
    e.respondWith(fetch(e.request).then((r) => {{ const c = r.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); return r; }}).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
  }} else if (u.hostname.endsWith('gstatic.com') || u.hostname.endsWith('googleapis.com')) {{
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {{ const c = res.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); return res; }})));
  }}
}});
""")
print('pwa files ok', ver)
