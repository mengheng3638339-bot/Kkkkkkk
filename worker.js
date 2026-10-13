// Study Hub on Cloudflare Workers: static site (public/) + API backed by D1 (database) and R2 (uploaded files).
const SESSION_MS = 7 * 24 * 3600 * 1000;
const PBKDF2_ITER = 100000; // Workers' maximum

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const err = (status, error) => json({ error }, status);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));

async function derive(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITER }, key, 256);
}
async function hashPw(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${hex(salt)}:${hex(await derive(password, salt))}`;
}
async function checkPw(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [saltHex, expected] = stored.split(':');
  if (!/^[\da-f]{32}$/i.test(saltHex || '') || !/^[\da-f]{64}$/i.test(expected || '')) return false;
  const actual = hex(await derive(password, unhex(saltHex)));
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.toLowerCase().charCodeAt(i);
  return diff === 0;
}

let ready = null;
function init(env) {
  if (!ready) ready = (async () => {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, hash TEXT NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, caption TEXT, kind TEXT, mime TEXT, size INTEGER, stored TEXT, by TEXT, at INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS quizzes (id TEXT PRIMARY KEY, title TEXT, description TEXT, questions TEXT, createdBy TEXT, createdAt INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, quizId TEXT, quizTitle TEXT, username TEXT, studentName TEXT, answers TEXT, score INTEGER, total INTEGER, submittedAt INTEGER)')
    ]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');
    const pw = env.INITIAL_OWNER_PASSWORD;
    if (!n && typeof pw === 'string' && pw.length >= 8 && pw.length <= 128) {
      const username = (env.INITIAL_OWNER_USERNAME || 'heng').trim().toLowerCase();
      const name = (env.INITIAL_OWNER_NAME || 'Heng').trim();
      await env.DB.prepare('INSERT INTO users (username, name, role, hash) VALUES (?, ?, ?, ?)')
        .bind(username, name, 'owner', await hashPw(pw)).run();
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const kindOf = (name, type = '') => {
  const n = name.toLowerCase();
  if (/\.html?$/.test(n)) return 'html';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (n.endsWith('.pdf')) return 'pdf';
  return 'other';
};
const publicUser = u => ({ username: u.username, name: u.name, role: u.role });

function sanitizeQuiz(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((q, index) => {
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    const explanation = typeof q?.explanation === 'string' ? q.explanation.trim() : '';
    const options = Array.isArray(q?.options) ? q.options.map(o => typeof o === 'string' ? o.trim() : '').filter(Boolean).slice(0, 6) : [];
    const ci = Number.isInteger(q?.correctIndex) ? q.correctIndex : 0;
    return {
      id: typeof q?.id === 'string' && q.id ? q.id : crypto.randomUUID(),
      question, options,
      correctIndex: options.length ? Math.max(0, Math.min(options.length - 1, ci)) : 0,
      explanation,
      order: Number.isInteger(q?.order) ? q.order : index
    };
  }).filter(q => q.question && q.options.length >= 2);
}
const parseQuiz = r => ({ ...r, questions: JSON.parse(r.questions || '[]') });

async function getUser(request, env, url) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '') || url.searchParams.get('token');
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.username, u.name, u.role, s.expires FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?'
  ).bind(token).first();
  if (!row || row.expires < Date.now()) return null;
  return { username: row.username, name: row.name, role: row.role };
}

function pubFile(env, url, f) {
  const base = env.PUBLIC_URL || url.origin;
  return { id: f.id, name: f.name, caption: f.caption, kind: f.kind, size: f.size, mime: f.mime, uploadedBy: f.by, createdAt: f.at,
    url: `${base}/api/public/files/${f.id}/raw?key=${env.API_KEY}` };
}
function notify(env, ctx, url, event, f) {
  if (!env.WEBHOOK_URL) return;
  ctx.waitUntil(fetch(env.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, file: pubFile(env, url, f), at: new Date().toISOString() }) }).catch(() => {}));
}

async function sendRaw(env, id) {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!f) return new Response(null, { status: 404 });
  const obj = await env.BUCKET.get(f.stored);
  if (!obj) return new Response(null, { status: 404 });
  const headers = new Headers();
  headers.set('Content-Type', f.kind === 'html' ? 'text/html; charset=utf-8' : f.mime || 'application/octet-stream');
  headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  if (f.kind === 'html') headers.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals');
  return new Response(obj.body, { headers });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname, method = request.method;
  const body = async () => { try { return await request.json(); } catch { return {}; } };
  let m;

  // Lightweight endpoint for deployment checks.
  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, service: 'Study Hub', mode: 'cloudflare' });
  }

  // ---- Public API (x-api-key) ----
  if (path.startsWith('/api/public/')) {
    if ((request.headers.get('x-api-key') || url.searchParams.get('key')) !== env.API_KEY || !env.API_KEY)
      return err(401, 'Bad API key');
    if (path === '/api/public/files') {
      const { results } = await env.DB.prepare('SELECT * FROM files').all();
      return json(results.map(f => pubFile(env, url, f)));
    }
    if ((m = path.match(/^\/api\/public\/files\/([^/]+)\/raw$/))) return sendRaw(env, m[1]);
    if ((m = path.match(/^\/api\/public\/files\/([^/]+)$/))) {
      const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(m[1]).first();
      return f ? json(pubFile(env, url, f)) : err(404, 'Not found');
    }
    return err(404, 'Not found');
  }

  // ---- Login ----
  if (path === '/api/login' && method === 'POST') {
    const { username, password, role } = await body();
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(username || '').toLowerCase()).first();
    if (!u) {
      const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');
      if (!total) return err(500, 'No owner account yet. In Cloudflare, add the secret INITIAL_OWNER_PASSWORD (8+ characters), then try again.');
    }
    if (!u || !(await checkPw(String(password), u.hash))) return err(401, 'Wrong username or password');
    if (normalizedRole && !['student', 'teacher', 'owner'].includes(normalizedRole))
      return err(400, 'Role must be student, teacher, or owner');
    if (normalizedRole && u.role !== normalizedRole) return err(403, `This account is a ${u.role}, not a ${normalizedRole}.`);
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
      env.DB.prepare('INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)').bind(token, u.username, Date.now() + SESSION_MS)
    ]);
    return json({ token, user: publicUser(u) });
  }

  // ---- Everything below needs a logged-in user ----
  const user = await getUser(request, env, url);
  if (!user) return err(401, 'Not logged in');
  const isTeacher = ['teacher', 'owner'].includes(user.role);
  const needTeacher = () => isTeacher ? null : err(403, 'Teacher only');
  const needOwner = () => user.role === 'owner' ? null : err(403, 'Owner only');

  if (path === '/api/logout' && method === 'POST') {
    const t = (request.headers.get('Authorization') || '').replace('Bearer ', '');
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(t).run();
    return json({ ok: true });
  }
  if (path === '/api/me') return json(user);

  // ---- Users (owner) ----
  if (path === '/api/users' && method === 'GET') {
    const d = needOwner(); if (d) return d;
    const { results } = await env.DB.prepare('SELECT username, name, role FROM users').all();
    return json(results);
  }
  if (path === '/api/users' && method === 'POST') {
    const d = needOwner(); if (d) return d;
    const { username, name, password, role } = await body();
    const u = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const n = typeof name === 'string' ? name.trim() : '';
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) return err(400, 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens');
    if (!n || n.length > 80) return err(400, 'Name must be between 1 and 80 characters');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return err(400, 'Password must be between 8 and 128 characters');
    if (!['student', 'teacher'].includes(role)) return err(400, 'Role must be student or teacher');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(u).first()) return err(409, 'Username already exists');
    await env.DB.prepare('INSERT INTO users (username, name, role, hash) VALUES (?, ?, ?, ?)').bind(u, n, role, await hashPw(password)).run();
    return json({ username: u, name: n, role }, 201);
  }
  if ((m = path.match(/^\/api\/users\/([^/]+)$/))) {
    const d = needOwner(); if (d) return d;
    const uname = decodeURIComponent(m[1]).toLowerCase();
    const target = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(uname).first();
    if (!target) return err(404, 'User not found');
    if (method === 'PATCH') {
      const { name, role } = await body();
      if (name === undefined && role === undefined) return err(400, 'Provide a name or role to update');
      let newName = target.name, newRole = target.role;
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) return err(400, 'Name must be between 1 and 80 characters');
        newName = name.trim();
      }
      if (role !== undefined) {
        if (target.role === 'owner') return err(403, 'Owner permissions cannot be changed here');
        if (!['student', 'teacher'].includes(role)) return err(400, 'Role must be student or teacher');
        newRole = role;
        await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(uname).run();
      }
      await env.DB.prepare('UPDATE users SET name = ?, role = ? WHERE username = ?').bind(newName, newRole, uname).run();
      return json({ username: uname, name: newName, role: newRole });
    }
    if (method === 'DELETE') {
      if (target.role === 'owner') return err(403, 'Owner accounts cannot be deleted here');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM users WHERE username = ?').bind(uname),
        env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(uname)
      ]);
      return json({ ok: true });
    }
  }

  // ---- Files ----
  if (path === '/api/files' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM files ORDER BY at DESC').all();
    return json(results);
  }
  if (path === '/api/files' && method === 'POST') {
    const d = needTeacher(); if (d) return d;
    const insert = async rec => {
      await env.DB.prepare('INSERT INTO files (id, name, caption, kind, mime, size, stored, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(rec.id, rec.name, rec.caption, rec.kind, rec.mime, rec.size, rec.stored, rec.by, rec.at).run();
      notify(env, ctx, url, 'uploaded', rec);
    };
    const qname = (url.searchParams.get('name') || '').trim();
    if (qname) {
      // Raw body upload: one file per request (streams straight into R2).
      const mime = request.headers.get('Content-Type') || 'application/octet-stream';
      const stored = crypto.randomUUID();
      const obj = await env.BUCKET.put(stored, request.body, { httpMetadata: { contentType: mime } });
      const rec = { id: crypto.randomUUID(), name: qname, caption: '', kind: kindOf(qname, mime), mime, size: obj.size, stored, by: user.name, at: Date.now() };
      await insert(rec);
      return json([rec]);
    }
    // Multipart upload (original web app): field name "files"
    const form = await request.formData();
    const added = [];
    for (const f of form.getAll('files')) {
      if (typeof f === 'string') continue;
      const name = f.name || 'file', stored = crypto.randomUUID();
      await env.BUCKET.put(stored, f.stream(), { httpMetadata: { contentType: f.type || 'application/octet-stream' } });
      const rec = { id: crypto.randomUUID(), name, caption: '', kind: kindOf(name, f.type || ''), mime: f.type || 'application/octet-stream', size: f.size, stored, by: user.name, at: Date.now() };
      await insert(rec); added.push(rec);
    }
    if (!added.length) return err(400, 'No files received');
    return json(added);
  }
  if ((m = path.match(/^\/api\/files\/([^/]+)\/raw$/)) && method === 'GET') return sendRaw(env, m[1]);
  if ((m = path.match(/^\/api\/files\/([^/]+)$/))) {
    const d = needTeacher(); if (d) return d;
    const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(m[1]).first();
    if (!f) return err(404, 'Not found');
    if (method === 'PATCH') {
      const b = await body();
      if (typeof b.name === 'string' && b.name.trim()) f.name = b.name.trim();
      if (typeof b.caption === 'string') f.caption = b.caption.trim();
      await env.DB.prepare('UPDATE files SET name = ?, caption = ? WHERE id = ?').bind(f.name, f.caption, f.id).run();
      notify(env, ctx, url, 'updated', f);
      return json(f);
    }
    if (method === 'DELETE') {
      await env.BUCKET.delete(f.stored);
      await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f.id).run();
      notify(env, ctx, url, 'deleted', f);
      return json({ ok: true });
    }
  }

  // ---- Quizzes ----
  if (path === '/api/quizzes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM quizzes ORDER BY createdAt DESC').all();
    return json(results.map(parseQuiz).map(q => ({
      id: q.id, title: q.title, description: q.description || '', createdBy: q.createdBy, createdAt: q.createdAt,
      questions: sanitizeQuiz(q.questions).map(x => isTeacher ? x : { id: x.id, question: x.question, options: x.options, order: x.order })
    })));
  }
  if (path === '/api/quizzes' && method === 'POST') {
    const d = needTeacher(); if (d) return d;
    const { title, description, questions } = await body();
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t) return err(400, 'Quiz title is required');
    const qs = sanitizeQuiz(questions);
    if (!qs.length) return err(400, 'Add at least one valid question with multiple choices');
    const quiz = { id: crypto.randomUUID(), title: t, description: typeof description === 'string' ? description.trim() : '',
      questions: qs, createdBy: user.username, createdAt: Date.now() };
    await env.DB.prepare('INSERT INTO quizzes (id, title, description, questions, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(quiz.id, quiz.title, quiz.description, JSON.stringify(qs), quiz.createdBy, quiz.createdAt).run();
    return json(quiz, 201);
  }
  if ((m = path.match(/^\/api\/quizzes\/([^/]+)\/attempts$/)) && method === 'POST') {
    if (user.role !== 'student') return err(403, 'Student only');
    const row = await env.DB.prepare('SELECT * FROM quizzes WHERE id = ?').bind(m[1]).first();
    if (!row) return err(404, 'Quiz not found');
    const quiz = parseQuiz(row), questions = sanitizeQuiz(quiz.questions);
    const { answers } = await body();
    if (!Array.isArray(answers) || answers.length !== questions.length ||
        answers.some((a, i) => !Number.isInteger(a) || a < 0 || a >= questions[i].options.length))
      return err(400, 'Choose an answer for every question before submitting');
    const results = questions.map((q, i) => ({ id: q.id, question: q.question, options: q.options, selectedIndex: answers[i],
      correctIndex: q.correctIndex, correct: answers[i] === q.correctIndex, explanation: q.explanation }));
    const attempt = { id: crypto.randomUUID(), quizId: quiz.id, quizTitle: quiz.title, username: user.username, studentName: user.name,
      answers: results, score: results.filter(r => r.correct).length, total: results.length, submittedAt: Date.now() };
    await env.DB.prepare('INSERT INTO attempts (id, quizId, quizTitle, username, studentName, answers, score, total, submittedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(attempt.id, attempt.quizId, attempt.quizTitle, attempt.username, attempt.studentName, JSON.stringify(results), attempt.score, attempt.total, attempt.submittedAt).run();
    return json(attempt, 201);
  }
  if ((m = path.match(/^\/api\/quizzes\/([^/]+)$/))) {
    const d = needTeacher(); if (d) return d;
    const row = await env.DB.prepare('SELECT * FROM quizzes WHERE id = ?').bind(m[1]).first();
    if (!row) return err(404, 'Quiz not found');
    if (method === 'PATCH') {
      const quiz = parseQuiz(row);
      const { title, description, questions } = await body();
      if (typeof title === 'string') quiz.title = title.trim() || quiz.title;
      if (typeof description === 'string') quiz.description = description.trim();
      if (Array.isArray(questions)) quiz.questions = sanitizeQuiz(questions);
      if (!quiz.questions.length) return err(400, 'Add at least one valid question with multiple choices');
      await env.DB.prepare('UPDATE quizzes SET title = ?, description = ?, questions = ? WHERE id = ?')
        .bind(quiz.title, quiz.description, JSON.stringify(quiz.questions), quiz.id).run();
      return json(quiz);
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM quizzes WHERE id = ?').bind(row.id).run();
      return json({ ok: true });
    }
  }
  if (path === '/api/attempts' && method === 'GET') {
    const q = isTeacher
      ? env.DB.prepare('SELECT * FROM attempts ORDER BY submittedAt DESC')
      : env.DB.prepare('SELECT * FROM attempts WHERE username = ? ORDER BY submittedAt DESC').bind(user.username);
    const { results } = await q.all();
    return json(results.map(a => ({ ...a, answers: JSON.parse(a.answers || '[]') })));
  }

  return err(404, 'Not found');
}

export default {
  async fetch(request, env, ctx) {
    try {
      await init(env);
      return await handle(request, env, ctx);
    } catch (e) {
      console.error(e);
      return err(500, 'Server error: ' + (e && e.message ? e.message : 'unknown'));
    }
  }
};
