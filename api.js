// Small API client used by app.js (all calls to the server live here)
const API = {
  token: localStorage.getItem('sh_token') || '',
  async req(method, url, body, isForm) {
    const opt = { method, headers: {} };
    if (this.token) opt.headers.Authorization = 'Bearer ' + this.token;
    if (body && !isForm) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    if (isForm) opt.body = body;
    let r; try { r = await fetch(url, opt); } catch (e) { throw new Error('Cannot reach the server. Check your connection and try again.'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + '). Please check the Study Hub deployment and API route.'));
    return data;
  },
  async login(username, password, role) {
    const d = await this.req('POST', '/api/login', { username, password, role });
    this.token = d.token; localStorage.setItem('sh_token', d.token); return d.user;
  },
  async logout() { try { await this.req('POST', '/api/logout'); } catch (e) {} this.token = ''; localStorage.removeItem('sh_token'); },
  me: () => API.req('GET', '/api/me'),
  files: () => API.req('GET', '/api/files'),
  users: () => API.req('GET', '/api/users'),
  quizzes: () => API.req('GET', '/api/quizzes'),
  attempts: () => API.req('GET', '/api/attempts'),
  createUser: user => API.req('POST', '/api/users', user),
  updateUser: (username, patch) => API.req('PATCH', '/api/users/' + encodeURIComponent(username), patch),
  deleteUser: username => API.req('DELETE', '/api/users/' + encodeURIComponent(username)),
  async upload(fileList) {
    const out = [];
    for (const f of [...fileList]) {
      const r = await fetch('/api/files?name=' + encodeURIComponent(f.name), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': f.type || 'application/octet-stream' },
        body: f
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('Upload failed (' + r.status + ')'));
      out.push(...d);
    }
    return out;
  },
  update: (id, patch) => API.req('PATCH', '/api/files/' + id, patch),
  remove: id => API.req('DELETE', '/api/files/' + id),
  createQuiz: quiz => API.req('POST', '/api/quizzes', quiz),
  updateQuiz: (id, quiz) => API.req('PATCH', '/api/quizzes/' + id, quiz),
  deleteQuiz: id => API.req('DELETE', '/api/quizzes/' + id),
  submitQuiz: (id, answers) => API.req('POST', '/api/quizzes/' + id + '/attempts', { answers }),
  rawUrl: id => `/api/files/${id}/raw?token=${API.token}`
};
