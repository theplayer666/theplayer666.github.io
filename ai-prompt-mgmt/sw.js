/* eslint-env serviceworker */
/**
 * 提示词库 PWA Service Worker（手写，无构建期插件依赖）
 *
 * 策略：
 *  - 安装时预缓存应用外壳（index.html + 其中引用的哈希化 js/css + manifest + 图标），
 *    因此装好之后第一次离线打开也能用。
 *  - 导航请求：网络优先（拿最新 index.html 并回填缓存），失败时回退缓存的 index.html。
 *  - 同源静态资源：stale-while-revalidate（先用缓存秒开，后台更新）。
 *  - 跨域请求（AI 接口、CDN 等）：完全放行，不缓存，避免把接口响应写进缓存。
 *
 * 改版本号只会切换缓存命名空间；普通发版不需要改，哈希文件名自带版本。
 */
const VERSION = 'v2';
const CACHE_PREFIX = 'ai-prompt-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const OFFLINE_TIMEOUT = 4000;

const SCOPE = self.registration.scope;

/** 把 index.html 里引用的同源资源解析成绝对 URL，用于安装时预缓存。 */
function extractAssets(html) {
  const urls = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('#')) continue;
    let url;
    try {
      url = new URL(raw, SCOPE);
    } catch {
      continue;
    }
    if (url.origin !== self.location.origin) continue;
    // 只缓存静态资源，manifest 单独处理
    if (/\.(js|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|otf)$/i.test(url.pathname)) {
      urls.add(url.href);
    }
  }
  return [...urls];
}

async function precache() {
  const cache = await caches.open(CACHE);
  const shell = [SCOPE, `${SCOPE}index.html`, `${SCOPE}manifest.json`];

  let html = '';
  for (const url of shell) {
    try {
      const resp = await fetch(new Request(url, { cache: 'reload' }));
      if (resp.ok) {
        await cache.put(url, resp.clone());
        if (url.endsWith('index.html') || url === SCOPE) html = await resp.text();
      }
    } catch {
      /* 单个文件失败不影响整体安装，运行时还会再尝试 */
    }
  }

  const assets = html ? extractAssets(html) : [];
  await Promise.all(
    assets.map(async (url) => {
      try {
        const resp = await fetch(new Request(url, { cache: 'reload' }));
        if (resp.ok) await cache.put(url, resp);
      } catch {
        /* ignore */
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  // 注意：这里刻意不调用 skipWaiting()。
  // 新 SW 就绪后先进入 waiting，由页面提示「发现新版本 → 立即刷新」，
  // 避免更新瞬间新旧资源混用（正在编辑的页面不会被打断）。
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/** 带超时的网络请求：网络慢或断网时回退到缓存，避免长时间白屏。 */
async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), OFFLINE_TIMEOUT)),
    ]);
    if (resp && resp.ok) {
      cache.put(request, resp.clone());
      if (request.mode === 'navigate') {
        cache.put(`${SCOPE}index.html`, resp.clone());
        cache.put(SCOPE, resp.clone());
      }
    }
    return resp;
  } catch {
    const cached = (await cache.match(request, { ignoreSearch: true })) ||
      (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => undefined);

  if (cached) {
    // 命中缓存先返回；把后台更新挂到 waitUntil，否则 SW 可能在写入前被回收
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨域：交给浏览器
  if (url.pathname.endsWith('/sw.js')) return; // 别缓存 SW 自身

  // Chrome 的 only-if-cached 只允许 same-origin 模式，避免抛错
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, `${SCOPE}index.html`));
    return;
  }

  // 非哈希的入口类文件走网络优先，保证发版后能及时拿到新版本
  if (/index\.html$|\/$|manifest\.json$/.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, event));
});
