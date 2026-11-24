import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '5173'));

const languageNames = {
  English: 'English',
  '简体中文': 'Simplified Chinese',
  '繁體中文': 'Traditional Chinese',
  日本語: 'Japanese',
  한국어: 'Korean',
  Français: 'French',
  Deutsch: 'German',
  Español: 'Spanish',
};

const translationCodes = {
  English: 'en', 简体中文: 'zh-CN', 繁體中文: 'zh-TW', 粤语: 'zh-TW',
  日本語: 'ja', 日语: 'ja', 한국어: 'ko', 韩语: 'ko',
  Français: 'fr', 法语: 'fr', Deutsch: 'de', 德语: 'de',
  Español: 'es', 西班牙语: 'es',
};

function offlinePair(source, target) {
  const from = translationCodes[source];
  const to = translationCodes[target];
  if (from === 'en' && to === 'zh-CN') return ['en', 'zh'];
  if (from === 'zh-CN' && to === 'en') return ['zh', 'en'];
  return null;
}

function offlineTranslate(text, source, target) {
  return new Promise((resolve, reject) => {
    const pair = offlinePair(source, target);
    const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!pair || !fs.existsSync(python)) {
      reject(new Error('当前语言对未配置离线翻译'));
      return;
    }
    const child = spawn(python, [path.join(root, 'offline_translator.py')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let buffer = '';
    let errors = '';
    let settled = false;
    const finish = (error, translation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(translation);
    };
    const timeout = setTimeout(() => finish(new Error('离线翻译初始化超时')), 20_000);
    child.on('error', () => finish(new Error('无法启动本地翻译服务')));
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.id !== 1) continue;
          if (data.error || !data.translation) finish(new Error(data.error || '离线翻译返回了空内容'));
          else finish(null, data.translation);
        } catch { /* Ignore incomplete worker output. */ }
      }
    });
    child.on('exit', () => {
      if (!settled) finish(new Error(errors.trim() || '本地翻译服务意外退出'));
    });
    child.stdin.write(JSON.stringify({ id: 1, text, source: pair[0], target: pair[1] }) + '\n');
    child.stdin.end();
  });
}

function decodeEntities(text) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]);
}

async function fallbackTranslate(text, source, target) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const query = new URLSearchParams({
      q: text,
      langpair: `${translationCodes[source] || 'zh-CN'}|${translationCodes[target]}`,
    });
    const response = await fetch(`https://api.mymemory.translated.net/get?${query}`, { signal: controller.signal });
    const data = await response.json();
    const translation = data?.responseData?.translatedText?.trim();
    if (!response.ok || Number(data?.responseStatus) !== 200 || !translation) {
      const details = data?.responseDetails || '备用翻译服务暂时不可用';
      if (/ALL AVAILABLE FREE TRANSLATIONS|QUOTA|LIMIT/i.test(details)) {
        throw new Error('在线备用翻译今日已限流，请稍后重试或改用中英文互译');
      }
      throw new Error(details);
    }
    return decodeEntities(translation);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_000) throw new Error('请求内容过长');
  }
  return JSON.parse(body || '{}');
}

async function translate(req, res) {
  try {
    const { text, target = 'English', source = 'auto' } = await readJson(req);
    const cleanText = String(text || '').trim();
    if (!cleanText || cleanText.length > 4000 || !languageNames[target]) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请提供有效原文和目标语言' }));
      return;
    }
    let translation;
    let provider = 'fallback';
    if (offlinePair(source, target)) {
      try {
        translation = await offlineTranslate(cleanText, source, target);
        provider = 'offline';
      } catch { /* Fall back to the online service if the local model cannot start. */ }
    }
    if (!translation) translation = await fallbackTranslate(cleanText, source, target);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ translation, provider }));
  } catch (error) {
    const message = error.name === 'AbortError' ? '翻译请求超时，请稍后重试' : error.message;
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message || '翻译失败' }));
  }
}

const server = await createServer({
  root,
  appType: 'spa',
  plugins: [{
    name: 'live-translation-api',
    configureServer(vite) {
      vite.middlewares.use('/api/translate', translate);
    },
  }],
  server: { host, port, strictPort: false },
});

await server.listen();
server.printUrls();
console.log(`Live Translator ready on port ${server.httpServer.address().port}`);
