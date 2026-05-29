const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 3137);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'ig-links-data.json');
const DEFAULT_CATEGORIES = ['未分類', '拍攝靈感', '腳本', '構圖', '運鏡', '剪輯', '音樂', '商品展示', '競品觀察', '其他'];
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function normalizeCategoryList(list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(category => String(category || '').trim())
    .filter(Boolean);
  return [...new Set(['未分類', ...normalized])];
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))];
}

function normalizeStatus(status) {
  return status === 'done' ? 'done' : 'todo';
}

function normalizeItem(item) {
  const now = Date.now();
  const url = String(item && item.url || '').trim();
  if (!url) return null;
  return {
    id: String(item.id || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    url,
    title: String(item.title || '').trim(),
    category: String(item.category || '未分類').trim() || '未分類',
    status: normalizeStatus(item.status),
    tags: normalizeTags(item.tags),
    note: String(item.note || '').trim(),
    thumbnailUrl: String(item.thumbnailUrl || '').trim(),
    createdAt: Number(item.createdAt || now),
    updatedAt: Number(item.updatedAt || now)
  };
}

function normalizeState(state) {
  const items = (Array.isArray(state && state.items) ? state.items : [])
    .map(normalizeItem)
    .filter(Boolean);
  const categories = normalizeCategoryList([
    ...DEFAULT_CATEGORIES,
    ...(state && state.categories || []),
    ...items.map(item => item.category)
  ]);
  return { items, categories };
}

async function readState() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { items: [], categories: [...DEFAULT_CATEGORIES] };
    }
    throw error;
  }
}

async function writeState(state) {
  const clean = normalizeState(state);
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  await fs.rename(tempFile, DATA_FILE);
  return clean;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

async function sendHtml(res) {
  const html = await fs.readFile(path.join(__dirname, 'ig-links.html'), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function findMetaContent(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return decodeHtml(match[1]);
    }
  }
  return '';
}

async function fetchPreview(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw Object.assign(new Error('invalid url'), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('invalid url'), { statusCode: 400 });
  }

  const response = await fetch(parsed.href, {
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    headers: {
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
    }
  });
  if (!response.ok) {
    throw Object.assign(new Error('preview unavailable'), { statusCode: 502 });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (received < MAX_PREVIEW_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  return {
    title: findMetaContent(html, ['og:title', 'twitter:title']),
    thumbnailUrl: findMetaContent(html, ['og:image', 'og:image:secure_url', 'twitter:image'])
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ig-links.html')) {
      await sendHtml(res);
      return;
    }

    if (url.pathname === '/api/preview') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      sendJson(res, 200, await fetchPreview(url.searchParams.get('url') || ''));
      return;
    }

    if (url.pathname === '/api/state') {
      url.pathname = '/state';
    }

    if (url.pathname !== '/state') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, await readState());
      return;
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const state = JSON.parse(body || '{}');
      sendJson(res, 200, await writeState(state));
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    sendJson(res, status, { error: status === 500 ? 'server error' : error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`IG link API listening on http://127.0.0.1:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
