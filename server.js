import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import { readFile, writeFile } from 'fs/promises';
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

// 内存缓存，避免频繁读取文件
let postsCache = null;
let talkCache = null;
let lastPostsRead = 0;
let lastTalkRead = 0;
const CACHE_DURATION = 1000; // 1秒缓存

// 写入锁，防止并发写入问题
let writeLock = Promise.resolve();

// 内存存储用于临时存储消息（当文件系统不可写时）
let talkDataMemory = [];

// 启用 CORS 允许前端跨域请求
app.use(cors());
// 增加 payload 限制，防止大图片/长文章导致请求失败
app.use(bodyParser.json({ limit: '50mb' }));

// Helper to read data with caching
const readData = async () => {
  const now = Date.now();
  // 如果有缓存且未过期，直接返回缓存数据
  if (postsCache !== null && (now - lastPostsRead) < CACHE_DURATION) {
    return postsCache;
  }
  
  try {
    if (!fs.existsSync(DATA_FILE)) {
      // 如果文件不存在，初始化为空数组
      await writeFile(DATA_FILE, '[]', 'utf8');
      postsCache = [];
      lastPostsRead = now;
      return postsCache;
    }
    
    const data = await readFile(DATA_FILE, 'utf8');
    const parsedData = JSON.parse(data || '[]');
    postsCache = parsedData;
    lastPostsRead = now;
    return parsedData;
  } catch (err) {
    console.error('Error reading data file:', err);
    // 出错时返回缓存数据或空数组
    return postsCache || [];
  }
};

// Helper to write data with lock
const writeData = async (data) => {
  // 使用锁确保写入操作的原子性
  writeLock = writeLock.then(async () => {
    try {
      await writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
      console.log(`[SUCCESS] Data written to ${DATA_FILE}`);
      // 更新缓存
      postsCache = data;
      lastPostsRead = Date.now();
      return true;
    } catch (err) {
      console.error('[ERROR] Failed to write data file:', err);
      return false;
    }
  });
  
  return writeLock;
};

// Helper to check if file is writable
const isFileWritable = (filePath) => {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
};

// Helper to read talk data with caching
const readTalkData = async () => {
  const now = Date.now();
  // 如果有缓存且未过期，直接返回缓存数据
  if (talkCache !== null && (now - lastTalkRead) < CACHE_DURATION) {
    return talkCache;
  }
  
  // 首先检查是否可以访问文件系统
  if (fs.existsSync(TALK_FILE) && isFileWritable(TALK_FILE)) {
    try {
      const data = await readFile(TALK_FILE, 'utf8');
      const parsedData = JSON.parse(data || '[]');
      talkCache = parsedData;
      lastTalkRead = now;
      return parsedData;
    } catch (err) {
      console.error('Error reading talk file:', err);
      // 回退到内存存储
      return talkDataMemory;
    }
  } else {
    // 如果文件不可访问，使用内存存储
    console.log('[INFO] Using memory storage for talk data');
    return talkDataMemory;
  }
};

// Helper to write talk data with lock and fallback to memory
const writeTalkData = async (data) => {
  // 更新缓存
  talkCache = data;
  lastTalkRead = Date.now();
  
  // 使用锁确保写入操作的原子性
  writeLock = writeLock.then(async () => {
    // 尝试写入文件系统
    if (isFileWritable(TALK_FILE)) {
      try {
        // 确保目录存在
        const dir = path.dirname(TALK_FILE);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        // 写入文件
        await writeFile(TALK_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[SUCCESS] Talk data written to ${TALK_FILE}`);
        return true;
      } catch (err) {
        console.error('[ERROR] Failed to write talk file:', err);
        // 出错时回退到内存存储
        talkDataMemory = data;
        console.log('[INFO] Falling back to memory storage for talk data');
        return true; // 返回true表示数据已保存（在内存中）
      }
    } else {
      // 文件系统不可写，直接使用内存存储
      talkDataMemory = data;
      console.log('[INFO] Using memory storage for talk data (filesystem not writable)');
      return true;
    }
  });
  
  return writeLock;
};

// Helper to get client IP address
const getClientIP = (req) => {
  // 尝试从各种可能的头部获取真实IP地址
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         req.ip;
};

// Helper to encrypt IP address as username
const encryptIP = (ip) => {
  // 使用 SHA-256 哈希函数加密 IP 地址
  const hash = crypto.createHash('sha256');
  hash.update(ip);
  const encrypted = hash.digest('hex').substring(0, 12); // 取前12位作为用户名
  return `user_${encrypted}`;
};

// GET current user info
app.get('/api/talk/current-user', (req, res) => {
  const clientIP = getClientIP(req) || 'unknown';
  const username = encryptIP(clientIP);
  res.json({ user: username });
});

// GET all posts
app.get('/api/posts', async (req, res) => {
  console.log(`[GET] /api/posts - ${new Date().toISOString()}`);
  const posts = await readData();
  res.json(posts);
});

// GET single post
app.get('/api/posts/:slug', async (req, res) => {
  console.log(`[GET] /api/posts/${req.params.slug}`);
  const posts = await readData();
  const post = posts.find(p => p.slug === req.params.slug);
  if (post) {
    res.json(post);
  } else {
    res.status(404).json({ message: 'Post not found' });
  }
});

// POST create/update post
app.post('/api/posts', async (req, res) => {
  console.log(`[POST] /api/posts - Receiving data...`);
  const newPost = req.body;
  
  if (!newPost || !newPost.slug) {
    return res.status(400).json({ message: 'Invalid post data' });
  }

  const posts = await readData();
  const existingIndex = posts.findIndex(p => p.slug === newPost.slug);
  
  if (existingIndex >= 0) {
    console.log(`[UPDATE] Updating post: ${newPost.title}`);
    posts[existingIndex] = newPost;
  } else {
    console.log(`[CREATE] Creating new post: ${newPost.title}`);
    posts.unshift(newPost);
  }
  
  if (await writeData(posts)) {
    res.json(newPost);
  } else {
    res.status(500).json({ message: 'Failed to save post to disk' });
  }
});

// GET all talk messages
app.get('/api/talk', async (req, res) => {
  console.log(`[GET] /api/talk - ${new Date().toISOString()}`);
  const talks = await readTalkData();
  res.json(talks);
});

// POST new talk message
app.post('/api/talk', async (req, res) => {
  console.log(`[POST] /api/talk - Receiving message...`);
  const newMessage = req.body;
  
  if (!newMessage || !newMessage.content) {
    return res.status(400).json({ message: 'Invalid message data' });
  }

  // 获取客户端IP并加密作为用户名
  const clientIP = getClientIP(req) || 'unknown';
  const username = encryptIP(clientIP);
  
  // 创建新消息对象
  const message = {
    id: Date.now(),
    time: new Date().toISOString(),
    user: username, // 使用加密后的用户名而不是固定的'guest'
    avatar: `https://www.weavefox.cn/api/bolt/unsplash_image?keyword=avatar&width=100&height=100&random=${username}`,
    content: newMessage.content
  };

  const talks = await readTalkData();
  talks.push(message);
  
  // 只保留最新的50条消息
  if (talks.length > 50) {
    talks.shift();
  }
  
  if (await writeTalkData(talks)) {
    res.json(message);
  } else {
    res.status(500).json({ 
      message: 'Failed to save message to disk',
      debug: {
        talkFilePath: TALK_FILE,
        talkFileExists: fs.existsSync(TALK_FILE),
        talkFileWritable: isFileWritable(TALK_FILE)
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`
  🚀 Server running on http://localhost:${PORT}
  📂 Data file: ${DATA_FILE}
  💬 Talk file: ${TALK_FILE}
  -----------------------------------------------
  Ready to accept requests from wyperBlog frontend
  `);
});