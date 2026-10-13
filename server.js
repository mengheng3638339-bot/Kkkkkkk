// load .env if present (no extra package needed)
try { require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch (e) {}
// Study Hub server: login, upload, rename/caption, public API + webhook for other drives
const express = require('express'), multer = require('multer'), cors = require('cors');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me-long-random';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
// DATA_DIR = where users, file list and uploads live. On a host, point it at a persistent disk.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS = path.join(DATA_DIR, 'data/users.json');
const FILES = path.join(DATA_DIR, 'data/files.json');
const QUIZZES = path.join(DATA_DIR, 'data/quizzes.json');
const ATTEMPTS = path.join(DATA_DIR, 'data/attempts.json');
const UP = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
fs.mkdirSync(UP, { recursive: true });

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, d) => {
  const temp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(temp, f);
};
const hash = (pw, salt = crypto.randomBytes(8).toString('hex')) =>
  `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
const check = (pw, h) => {
  if (typeof pw !== 'string' || typeof h !== 'string') return false;
  const [salt, expectedHex] = h.split(':');
  if (!salt || !/^[\da-f]{64}$/i.test(expectedHex || '')) return false;
  const actualHex = hash(pw, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'));
};

if (!fs.existsSync(USERS)) {
  const username = (process.env.INITIAL_OWNER_USERNAME || 'heng').trim().toLowerCase();
  const name = (process.env.INITIAL_OWNER_NAME || 'Heng').trim();
  const password = process.env.INITIAL_OWNER_PASSWORD;
  if (!/^[a-z0-9._-]{3,32}$/.test(username))
    throw new Error('INITIAL_OWNER_USERNAME must be 3–32 letters, numbers, dots, underscores, or hyphens');
  if (!name || name.length > 80)
    throw new Error('INITIAL_OWNER_NAME must be between 1 and 80 characters');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    throw new Error('Set INITIAL_OWNER_PASSWORD (8–128 characters) before starting with an empty user store');
  write(USERS, [{ username, name, role: 'owner', hash: hash(password) }]);
}
if (!fs.existsSync(FILES)) write(FILES, []);
if (!fs.existsSync(QUIZZES)) write(QUIZZES, []);
if (!fs.existsSync(ATTEMPTS)) write(ATTEMPTS, []);

// The existing heng account owns user administration; migrate existing data stores too.
let users = read(USERS);
let usersChanged = false;
users = users.map(u => {
  const account = u.password
    ? { username: u.username, name: u.name, role: u.role, hash: hash(u.password) }
    : u;
  if (u.password) usersChanged = true;
  if ((account.username || '').toLowerCase() === 'heng') {
    if (account.role !== 'owner') {
      account.role = 'owner';
      usersChanged = true;
    }
    if (process.env.INITIAL_OWNER_PASSWORD && process.env.LEGACY_OWNER_PASSWORD &&
        check(process.env.LEGACY_OWNER_PASSWORD, account.hash)) {
      account.hash = hash(process.env.INITIAL_OWNER_PASSWORD);
      usersChanged = true;
    }
  }
  return account;
});
if (usersChanged) {
  write(USERS, users);
}

const sessions = new Map(); // token -> user
const kindOf = (name, type = '') => {
  const n = name.toLowerCase();
  if (/\.html?$/.test(n)) return 'html';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (n.endsWith('.pdf')) return 'pdf';
  return 'other';
};

function notify(event, file) {
  if (!WEBHOOK_URL) return;
  fetch(WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, file: pub(file), at: new Date().toISOString() })
  }).catch(e => console.error('webhook failed:', e.message));
}
const pub = f => ({ id: f.id, name: f.name, caption: f.caption, kind: f.kind, size: f.size, mime: f.mime,
  uploadedBy: f.by, createdAt: f.at, url: `${PUBLIC_URL}/api/public/files/${f.id}/raw?key=${API_KEY}` });

const app = express();
app.use(cors());
app.use(express.json());

const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const u = sessions.get(t);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  req.user = u; next();
};
const teacher = (req, res, next) => ['teacher', 'owner'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Teacher only' });
const student = (req, res, next) => req.user.role === 'student' ? next() : res.status(403).json({ error: 'Student only' });
const owner = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' });
const apiKey = (req, res, next) =>
  (req.headers['x-api-key'] || req.query.key) === API_KEY ? next() : res.status(401).json({ error: 'Bad API key' });
const publicUser = u => ({ username: u.username, name: u.name, role: u.role });

// ---- Login ----
app.post('/api/login', (req, res) => {
  const { username, password, role } = req.body || {};
  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const u = read(USERS).find(x => x.username === String(username).toLowerCase());
  if (!u || !check(String(password), u.hash)) return res.status(401).json({ error: 'Wrong username or password' });
  if (normalizedRole && !['student', 'teacher', 'owner'].includes(normalizedRole))
    return res.status(400).json({ error: 'Role must be student, teacher, or owner' });
  if (normalizedRole && u.role !== normalizedRole)
    return res.status(403).json({ error: `This account is a ${u.role}, not a ${normalizedRole}.` });
  const token = crypto.randomBytes(24).toString('hex');
  const user = { username: u.username, name: u.name, role: u.role };
  sessions.set(token, user);
  res.json({ token, user });
});
app.post('/api/logout', auth, (req, res) => { sessions.delete((req.headers.authorization || '').replace('Bearer ', '')); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---- User administration (owner only) ----
app.get('/api/users', auth, owner, (req, res) => res.json(read(USERS).map(publicUser)));
app.post('/api/users', auth, owner, (req, res) => {
  const { username, name, password, role } = req.body || {};
  const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(normalizedUsername))
    return res.status(400).json({ error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens' });
  if (!normalizedName || normalizedName.length > 80)
    return res.status(400).json({ error: 'Name must be between 1 and 80 characters' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  if (!['student', 'teacher'].includes(role))
    return res.status(400).json({ error: 'Role must be student or teacher' });

  const list = read(USERS);
  if (list.some(u => u.username.toLowerCase() === normalizedUsername))
    return res.status(409).json({ error: 'Username already exists' });
  const user = { username: normalizedUsername, name: normalizedName, role, hash: hash(password) };
  list.push(user);
  write(USERS, list);
  res.status(201).json(publicUser(user));
});
app.patch('/api/users/:username', auth, owner, (req, res) => {
  const list = read(USERS);
  const user = list.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, role } = req.body || {};
  if (name === undefined && role === undefined)
    return res.status(400).json({ error: 'Provide a name or role to update' });
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
      return res.status(400).json({ error: 'Name must be between 1 and 80 characters' });
    user.name = name.trim();
  }
  if (role !== undefined) {
    if (user.role === 'owner')
      return res.status(403).json({ error: 'Owner permissions cannot be changed here' });
    if (!['student', 'teacher'].includes(role))
      return res.status(400).json({ error: 'Role must be student or teacher' });
    user.role = role;
    for (const [token, sessionUser] of sessions) {
      if (sessionUser.username === user.username) sessions.delete(token);
    }
  }
  write(USERS, list);
  res.json(publicUser(user));
});
app.delete('/api/users/:username', auth, owner, (req, res) => {
  const list = read(USERS);
  const user = list.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'owner') return res.status(403).json({ error: 'Owner accounts cannot be deleted here' });

  write(USERS, list.filter(u => u !== user));
  for (const [token, sessionUser] of sessions) {
    if (sessionUser.username === user.username) sessions.delete(token);
  }
  res.json({ ok: true });
});

// ---- Files (logged-in users) ----
app.get('/api/files', auth, (req, res) => res.json(read(FILES).sort((a, b) => b.at - a.at)));
app.get('/api/files/:id/raw', auth, (req, res) => sendRaw(req, res));

function sanitizeQuiz(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((q, index) => {
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    const explanation = typeof q?.explanation === 'string' ? q.explanation.trim() : '';
    const options = Array.isArray(q?.options) ? q.options.map(opt => typeof opt === 'string' ? opt.trim() : '').filter(Boolean).slice(0, 6) : [];
    const correctIndex = Number.isInteger(q?.correctIndex) ? q.correctIndex : 0;
    const normalizedCorrect = options.length ? Math.max(0, Math.min(options.length - 1, correctIndex)) : 0;
    return {
      id: typeof q?.id === 'string' && q.id ? q.id : crypto.randomUUID(),
      question,
      options,
      correctIndex: normalizedCorrect,
      explanation,
      order: Number.isInteger(q?.order) ? q.order : index
    };
  }).filter(q => q.question && q.options.length >= 2);
}

app.get('/api/quizzes', auth, (req, res) => {
  const quizzes = read(QUIZZES).map(q => ({
    id: q.id,
    title: q.title,
    description: q.description || '',
    questions: sanitizeQuiz(q.questions || []).map(question => {
      if (['teacher', 'owner'].includes(req.user.role)) return question;
      const { id, question: prompt, options, order } = question;
      return { id, question: prompt, options, order };
    }),
    createdBy: q.createdBy || 'teacher',
    createdAt: q.createdAt || Date.now()
  }));
  res.json(quizzes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
});
app.get('/api/attempts', auth, (req, res) => {
  const attempts = read(ATTEMPTS);
  const visible = ['teacher', 'owner'].includes(req.user.role)
    ? attempts
    : attempts.filter(attempt => attempt.username === req.user.username);
  res.json(visible.sort((a, b) => b.submittedAt - a.submittedAt));
});
app.post('/api/quizzes/:id/attempts', auth, student, (req, res) => {
  const quiz = read(QUIZZES).find(item => item.id === req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  const questions = sanitizeQuiz(quiz.questions || []);
  const { answers } = req.body || {};
  if (!Array.isArray(answers) || answers.length !== questions.length ||
      answers.some((answer, index) => !Number.isInteger(answer) || answer < 0 || answer >= questions[index].options.length))
    return res.status(400).json({ error: 'Choose an answer for every question before submitting' });

  const questionResults = questions.map((question, index) => ({
    id: question.id,
    question: question.question,
    options: question.options,
    selectedIndex: answers[index],
    correctIndex: question.correctIndex,
    correct: answers[index] === question.correctIndex,
    explanation: question.explanation
  }));
  const score = questionResults.filter(result => result.correct).length;
  const attempt = {
    id: crypto.randomUUID(),
    quizId: quiz.id,
    quizTitle: quiz.title,
    username: req.user.username,
    studentName: req.user.name,
    answers: questionResults,
    score,
    total: questionResults.length,
    submittedAt: Date.now()
  };
  const attempts = read(ATTEMPTS);
  attempts.push(attempt);
  write(ATTEMPTS, attempts);
  res.status(201).json(attempt);
});
app.post('/api/quizzes', auth, teacher, (req, res) => {
  const { title, description, questions } = req.body || {};
  const list = read(QUIZZES);
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  if (!safeTitle) return res.status(400).json({ error: 'Quiz title is required' });
  const safeQuestions = sanitizeQuiz(questions);
  if (!safeQuestions.length) return res.status(400).json({ error: 'Add at least one valid question with multiple choices' });
  const quiz = {
    id: crypto.randomUUID(),
    title: safeTitle,
    description: typeof description === 'string' ? description.trim() : '',
    questions: safeQuestions,
    createdBy: req.user.username,
    createdAt: Date.now()
  };
  list.push(quiz);
  write(QUIZZES, list);
  res.status(201).json(quiz);
});
app.patch('/api/quizzes/:id', auth, teacher, (req, res) => {
  const list = read(QUIZZES);
  const quiz = list.find(x => x.id === req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  const { title, description, questions } = req.body || {};
  if (typeof title === 'string') quiz.title = title.trim() || quiz.title;
  if (typeof description === 'string') quiz.description = description.trim();
  if (Array.isArray(questions)) quiz.questions = sanitizeQuiz(questions);
  if (!quiz.title) return res.status(400).json({ error: 'Quiz title is required' });
  if (!quiz.questions.length) return res.status(400).json({ error: 'Add at least one valid question with multiple choices' });
  write(QUIZZES, list);
  res.json(quiz);
});
app.delete('/api/quizzes/:id', auth, teacher, (req, res) => {
  const list = read(QUIZZES);
  const quiz = list.find(x => x.id === req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  write(QUIZZES, list.filter(x => x !== quiz));
  res.json({ ok: true });
});

const upload = multer({ dest: UP, limits: { fileSize: 500 * 1024 * 1024 } });
// Raw single-file upload (used by the web app): POST /api/files?name=...  body = file bytes
app.post('/api/files', auth, teacher, (req, res, next) => {
  if (!req.query.name) return next();
  const name = String(req.query.name).trim(), stored = crypto.randomUUID();
  const out = fs.createWriteStream(path.join(UP, stored));
  let size = 0;
  req.on('data', c => { size += c.length; });
  req.pipe(out);
  out.on('finish', () => {
    const mime = req.headers['content-type'] || 'application/octet-stream';
    const rec = { id: crypto.randomUUID(), name, caption: '', kind: kindOf(name, mime), mime, size, stored, by: req.user.name, at: Date.now() };
    const list = read(FILES); list.push(rec); write(FILES, list); notify('uploaded', rec);
    res.json([rec]);
  });
  out.on('error', () => res.status(500).json({ error: 'Upload failed' }));
}, upload.array('files'), (req, res) => {
  const list = read(FILES), added = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const rec = { id: crypto.randomUUID(), name, caption: '', kind: kindOf(name, f.mimetype),
      mime: f.mimetype, size: f.size, stored: f.filename, by: req.user.name, at: Date.now() };
    list.push(rec); added.push(rec); notify('uploaded', rec);
  }
  write(FILES, list); res.json(added);
});
app.patch('/api/files/:id', auth, teacher, (req, res) => {
  const list = read(FILES), f = list.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) f.name = req.body.name.trim();
  if (typeof req.body.caption === 'string') f.caption = req.body.caption.trim();
  write(FILES, list); notify('updated', f); res.json(f);
});
app.delete('/api/files/:id', auth, teacher, (req, res) => {
  const list = read(FILES), f = list.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(path.join(UP, f.stored), { force: true });
  write(FILES, list.filter(x => x !== f)); notify('deleted', f); res.json({ ok: true });
});

function sendRaw(req, res) {
  const f = read(FILES).find(x => x.id === req.params.id);
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.kind === 'html' ? 'text/html; charset=utf-8' : f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  if (f.kind === 'html') res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals');
  res.sendFile(path.join(UP, f.stored));
}

// ---- Public API for other drives / apps (needs x-api-key) ----
app.get('/api/public/files', apiKey, (req, res) => res.json(read(FILES).map(pub)));
app.get('/api/public/files/:id', apiKey, (req, res) => {
  const f = read(FILES).find(x => x.id === req.params.id);
  f ? res.json(pub(f)) : res.status(404).json({ error: 'Not found' });
});
app.get('/api/public/files/:id/raw', apiKey, sendRaw);

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Study Hub running on ${PUBLIC_URL}`));
