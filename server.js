import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import { readFile, writeFile, copyFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// 获取当前文件的目录名
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 7894;
const DATA_FILE = path.join(__dirname, 'posts.json');
const TALK_FILE = path.join(__dirname, 'talk.json');

// 内存缓存
let postsCache = null;
let talkCache = null;
let lastPostsRead = 0;
let lastTalkRead = 0;
const CACHE_DURATION = 1000; // 1秒

// 内存 fallback（用于 talk）
let talkDataMemory = [];

// 写入互斥锁（防止并发写冲突）
let writeLock = Promise.resolve();
const withWriteLock = (fn) => {
  const next = writeLock.then(fn).catch(err => {
    console.error('[WRITE LOCK ERROR]', err);
    throw err;
  });
  writeLock = next;
  return next;
};

// 安全解析 JSON，避免空/损坏文件导致崩溃
const safeParseJSON = (data, defaultValue = []) => {
  try {
    return JSON.parse(data || '[]');
  } catch (err) {
    console.warn('[WARN] JSON parse failed, using default:', err.message);
    return defaultValue;
  }
};

// 启用 CORS 和 body parser
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// 检查文件是否可写
const isFileWritable = (filePath) => {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

// 读取 posts（支持强制刷新）
const readData = async (force = false) => {
  const now = Date.now();
  if (!force && postsCache !== null && (now - lastPostsRead) < CACHE_DURATION) {
    return postsCache;
  }

  try {
    if (!fs.existsSync(DATA_FILE)) {
      await writeFile(DATA_FILE, '[]', 'utf8');
      postsCache = [];
    } else {
      const rawData = await readFile(DATA_FILE, 'utf8');
      postsCache = safeParseJSON(rawData, []);
    }
    lastPostsRead = now;
    return postsCache;
  } catch (err) {
    console.error('Error reading posts file:', err);
    return postsCache || [];
  }
};

// 写入 posts（带互斥锁）
const writeData = async (data) => {
  return withWriteLock(async () => {
    // 可选：备份原文件（高可靠场景）
    // if (fs.existsSync(DATA_FILE)) await copyFile(DATA_FILE, `${DATA_FILE}.bak`);

    await writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    postsCache = data;
    lastPostsRead = Date.now();
    console.log(`[SUCCESS] Posts written to ${DATA_FILE}`);
    return true;
  }).catch(err => {
    console.error('[ERROR] Failed to write posts file:', err);
    return false;
  });
};

// 读取 talk 数据
const readTalkData = async (force = false) => {
  const now = Date.now();
  if (!force && talkCache !== null && (now - lastTalkRead) < CACHE_DURATION) {
    return talkCache;
  }

  if (fs.existsSync(TALK_FILE) && isFileWritable(TALK_FILE)) {
    try {
      const rawData = await readFile(TALK_FILE, 'utf8');
      talkCache = safeParseJSON(rawData, []);
      lastTalkRead = now;
      return talkCache;
    } catch (err) {
      console.error('Error reading talk file:', err);
      return talkDataMemory;
    }
  } else {
    console.log('[INFO] Using memory storage for talk data');
    return talkDataMemory;
  }
};

// 写入 talk 数据（带互斥锁 + fallback）
const writeTalkData = async (data) => {
  return withWriteLock(async () => {
    talkCache = data;
    lastTalkRead = Date.now();

    if (isFileWritable(TALK_FILE)) {
      try {
        const dir = path.dirname(TALK_FILE);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        await writeFile(TALK_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[SUCCESS] Talk data written to ${TALK_FILE}`);
        return true;
      } catch (err) {
        console.error('[ERROR] Failed to write talk file:', err);
        talkDataMemory = data;
        console.log('[INFO] Falling back to memory storage for talk data');
        return true;
      }
    } else {
      talkDataMemory = data;
      console.log('[INFO] Using memory storage (filesystem not writable)');
      return true;
    }
  });
};

// 获取客户端 IP
const getClientIP = (req) => {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    (req.connection?.socket ? req.connection.socket.remoteAddress : null) ||
    req.ip ||
    'unknown'
  );
};

// 加密 IP 为用户名
const encryptIP = (ip) => {
  const hash = crypto.createHash('sha256');
  hash.update(ip || 'unknown');
  return `user_${hash.digest('hex').substring(0, 12)}`;
};

// --- Routes ---

app.get('/api/talk/current-user', (req, res) => {
  const clientIP = getClientIP(req);
  const username = encryptIP(clientIP);
  res.json({ user: username });
});

app.get('/api/posts', async (req, res) => {
  console.log(`[GET] /api/posts - ${new Date().toISOString()}`);
  try {
    const posts = await readData();
    res.json({ data: posts || [], timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[ERROR] Fetch posts:', error);
    res.status(500).json({ data: [], error: 'Failed to load posts' });
  }
});

app.get('/api/posts/:slug', async (req, res) => {
  console.log(`[GET] /api/posts/${req.params.slug}`);
  try {
    const posts = await readData();
    const post = posts.find(p => p.slug === req.params.slug);
    if (post) {
      res.json({ data: post });
    } else {
      res.status(404).json({ error: 'Post not found' });
    }
  } catch (error) {
    console.error('[ERROR] Fetch single post:', error);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

app.post('/api/posts', async (req, res) => {
  const newPost = req.body;
  if (!newPost || !newPost.slug) {
    return res.status(400).json({ error: 'Invalid post data: missing slug' });
  }

  try {
    const posts = await readData();
    const existingIndex = posts.findIndex(p => p.slug === newPost.slug);

    if (existingIndex >= 0) {
      console.log(`[UPDATE] Post: ${newPost.title}`);
      posts[existingIndex] = newPost;
    } else {
      console.log(`[CREATE] Post: ${newPost.title}`);
      posts.unshift(newPost);
    }

    const success = await writeData(posts);
    if (success) {
      res.json({ data: newPost });
    } else {
      res.status(500).json({ error: 'Failed to save post to disk' });
    }
  } catch (error) {
    console.error('[ERROR] Process post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/talk', async (req, res) => {
  console.log(`[GET] /api/talk - ${new Date().toISOString()}`);
  try {
    const talks = await readTalkData();
    res.json({ data: talks || [], timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[ERROR] Fetch talk:', error);
    res.status(500).json({ data: [], error: 'Failed to load messages' });
  }
});

app.post('/api/talk', async (req, res) => {
  const newMessage = req.body;
  if (!newMessage || !newMessage.content?.trim()) {
    return res.status(400).json({ error: 'Invalid message: content is required' });
  }

  try {
    const clientIP = getClientIP(req);
    const username = encryptIP(clientIP);

    const message = {
      id: Date.now(),
      time: new Date().toISOString(),
      user: username,
      avatar: `https://www.weavefox.cn/api/bolt/unsplash_image?keyword=avatar&width=100&height=100&random=${username}`,
      content: newMessage.content.trim()
    };

    const talks = await readTalkData();
    talks.push(message);
    if (talks.length > 50) talks.shift(); // 保留最新50条

    const success = await writeTalkData(talks);
    if (success) {
      res.json({ data: message });
    } else {
      res.status(500).json({
        error: 'Failed to save message',
        debug: {
          talkFilePath: TALK_FILE,
          exists: fs.existsSync(TALK_FILE),
          writable: isFileWritable(TALK_FILE)
        }
      });
    }
  } catch (error) {
    console.error('[ERROR] Process talk message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- 启动服务器 ---
(async () => {
  // 预加载数据，避免首次请求为空
  await readData();
  await readTalkData();

  app.listen(PORT, () => {
    console.log(`
🚀 Server running on http://localhost:${PORT}
📂 Posts file: ${DATA_FILE}
💬 Talk file:   ${TALK_FILE}
-----------------------------------------------
✅ Ready to accept requests from wyperBlog frontend
    `);
  });
})();