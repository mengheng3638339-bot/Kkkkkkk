const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = { pdf: '📄', video: '🎬', html: '🌐', image: '🖼️', other: '📁' };
const S = { user: null, files: [], users: [], quizzes: [], attempts: [], sel: null, activeQuiz: null, msg: '', userMsg: '', quizMsg: '' };
let installPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('appinstalled', () => { installPrompt = null; });

function bindInstallButton() {
  const button = $('#install');
  if (!button) return;
  button.onclick = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      return;
    }
    const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    alert(isAppleMobile
      ? 'In Safari, tap Share, then Add to Home Screen.'
      : 'Open your browser menu and choose Install app or Add to Home screen.');
  };
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.error('Service worker registration failed:', e));
  }
  if (API.token) { try { S.user = await API.me(); await load(); } catch (e) { API.token = ''; } }
  render();
  setInterval(() => S.user && load().then(refreshList).catch(() => {}), 8000); // see new uploads live
}
async function load() {
  [S.files, S.quizzes, S.attempts] = await Promise.all([API.files(), API.quizzes(), API.attempts()]);
}

function render() { S.user ? renderMain() : renderLogin(); }

function renderLogin() {
  $('#app').innerHTML = `<form class="card login" id="login-form">
    <h1 style="margin:0">📚 Study Hub</h1>
    <label for="u">Username</label>
    <input type="text" id="u" name="username" placeholder="Username" autocomplete="username" required>
    <label for="p">Password</label>
    <div class="password-field"><input type="password" id="p" name="password" placeholder="Password" autocomplete="current-password" required><button class="btn g password-toggle" id="toggle-password" type="button" aria-label="Show password" aria-pressed="false">Show</button></div>
    <label for="r">Role</label>
    <select id="r" name="role">
      <option value="student">Student</option>
      <option value="teacher">Teacher</option>
      <option value="owner">Owner</option>
    </select>
    <button class="btn" id="go" type="submit">Log in</button><button class="btn g" id="install" type="button">Add to Home Screen</button><div class="mu" id="lm" role="status" aria-live="polite"></div></form>`;
  bindInstallButton();
  $('#toggle-password').onclick = () => {
    const password = $('#p'), button = $('#toggle-password');
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} password`);
    button.setAttribute('aria-pressed', String(show));
  };
  const go = async event => {
    event.preventDefault();
    const button = $('#go'), message = $('#lm');
    const role = $('#r').value;
    button.disabled = true;
    message.textContent = 'Signing in…';
    try { S.user = await API.login($('#u').value.trim().toLowerCase(), $('#p').value, role); await load(); render(); }
    catch (e) { message.textContent = e.message; button.disabled = false; }
  };
  $('#login-form').addEventListener('submit', go);
}

function renderMain() {
  const t = ['teacher', 'owner'].includes(S.user.role), isOwner = S.user.role === 'owner';
  const roleName = isOwner ? 'Owner' : t ? 'Teacher' : 'Student';
  $('#app').innerHTML = `<header><h1>📚 Study Hub</h1><span class="mu">${esc(S.user.name)} · ${roleName}</span><button class="btn g" id="install">Add to Home Screen</button><button class="btn g" id="lo">Log out</button></header>
  <div class="wrap"><div>
    ${t ? `<div class="card" style="margin-bottom:12px"><div class="drop" id="dz">Drop files here or <label style="color:var(--ac);cursor:pointer">browse<input type="file" id="fi" multiple hidden></label></div><div class="mu" id="um">${esc(S.msg)}</div></div>` : ''}
    <div class="card"><b>Materials</b><div id="list" style="margin-top:8px"></div></div>
    ${t ? `<section class="card quiz-panel"><h2>Quizzes</h2><div id="quiz-list" class="quiz-list"></div><div id="quiz-status" class="mu quiz-status" role="status" aria-live="polite">${esc(S.quizMsg)}</div><form id="quiz-form" class="quiz-form">
      <label>Quiz title<input name="title" maxlength="120" required></label>
      <label>Description<textarea name="description" rows="2" maxlength="500"></textarea></label>
      <div id="quiz-questions" class="quiz-questions"></div>
      <div class="row"><button class="btn g" type="button" id="add-question">Add question</button><button class="btn" type="submit">Save quiz</button></div>
    </form><h3>Student submissions</h3><div id="attempt-list" class="quiz-list"></div></section>` : `<section class="card quiz-panel"><h2>Quiz exercises</h2><div id="student-quiz-list" class="quiz-list"></div></section>`}
    ${isOwner ? `<section class="card account-admin"><h2>Manage users</h2><p class="mu">Create student or teacher accounts and change their access.</p>
      <form id="user-form" class="user-form">
        <label>Username<input name="username" autocomplete="off" minlength="3" maxlength="32" required></label>
        <label>Display name<input name="name" autocomplete="off" maxlength="80" required></label>
        <label>Temporary password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
        <label>Permission<select name="role"><option value="student">Student — view materials</option><option value="teacher">Teacher — manage materials</option></select></label>
        <button class="btn" type="submit">Create account</button>
      </form>
      <div id="user-status" class="mu" role="status" aria-live="polite">${esc(S.userMsg)}</div>
      <div id="user-list" class="user-list"><span class="mu">Loading accounts…</span></div>
    </section>` : ''}
  </div><div class="card viewer" id="vw"></div></div>`;
  bindInstallButton();
  $('#lo').onclick = async () => { await API.logout(); S.user = null; render(); };
  if (isOwner) {
    $('#user-form').addEventListener('submit', createUser);
    loadUsers().catch(e => { $('#user-list').textContent = e.message; });
  }
  if (t) {
    const dz = $('#dz'), up = async fl => { $('#um').textContent = 'Uploading…'; try { await API.upload(fl); await load(); S.msg = 'Uploaded ✓'; } catch (e) { S.msg = e.message; } renderMain(); };
    $('#fi').onchange = e => up(e.target.files);
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('h'); }; dz.ondragleave = () => dz.classList.remove('h');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('h'); up(e.dataTransfer.files); };
    setupQuizEditor();
  }
  refreshList(); renderViewer();
}

async function loadUsers() {
  S.users = await API.users();
  renderUsers();
}

function renderUsers() {
  const list = $('#user-list');
  if (!list) return;
  list.innerHTML = `<div class="user-rows">${S.users.map(user => `<div class="user-row">
    <div class="user-identity"><b>${esc(user.name)}</b><span class="mu">${esc(user.username)}</span></div>
    <div class="user-actions">
      <label class="user-role">Permission<select data-user="${esc(user.username)}" ${user.role === 'owner' ? 'disabled' : ''}>
        <option value="student" ${user.role === 'student' ? 'selected' : ''}>Student</option>
        <option value="teacher" ${user.role === 'teacher' ? 'selected' : ''}>Teacher</option>
        ${user.role === 'owner' ? '<option value="owner" selected>Owner</option>' : ''}
      </select></label>
      ${user.role === 'owner' ? '' : `<button class="btn r delete-user" type="button" data-delete-user="${esc(user.username)}">Delete</button>`}
    </div>
  </div>`).join('')}</div>`;
  list.querySelectorAll('select[data-user]').forEach(select => {
    select.onchange = async () => {
      const status = $('#user-status');
      select.disabled = true;
      status.textContent = 'Updating permission…';
      try {
        await API.updateUser(select.dataset.user, { role: select.value });
        S.userMsg = 'Permission updated.';
        await loadUsers();
        status.textContent = S.userMsg;
      } catch (e) {
        status.textContent = e.message;
        await loadUsers();
      }
    };
  });
  list.querySelectorAll('button[data-delete-user]').forEach(button => {
    button.onclick = async () => {
      const username = button.dataset.deleteUser;
      const user = S.users.find(account => account.username === username);
      if (!user || !confirm(`Delete the account "${user.name}" (@${username})? They will lose access immediately.`)) return;
      const status = $('#user-status');
      button.disabled = true;
      status.textContent = 'Deleting account…';
      try {
        await API.deleteUser(username);
        S.userMsg = `Deleted account ${username}.`;
        await loadUsers();
        status.textContent = S.userMsg;
      } catch (e) {
        status.textContent = e.message;
        button.disabled = false;
      }
    };
  });
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget, status = $('#user-status');
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  button.disabled = true;
  status.textContent = 'Creating account…';
  try {
    await API.createUser(values);
    form.reset();
    S.userMsg = 'Account created.';
    status.textContent = S.userMsg;
    await loadUsers();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

function refreshList() {
  const el = $('#list'); if (!el) return; const t = ['teacher', 'owner'].includes(S.user.role);
  el.innerHTML = S.files.map(f => `<div class="item ${f.id === S.sel ? 'on' : ''}" data-id="${f.id}">
    <span>${ICON[f.kind] || '📁'}</span><span class="t">${esc(f.name)}</span>
    ${t ? `<button class="btn g s" data-a="rn" title="Rename">✏️</button><button class="btn g s" data-a="cp" title="Caption">${f.caption ? '💬✓' : '💬'}</button>` : ''}</div>`).join('') || '<div class="mu">No files yet.</div>';
  el.querySelectorAll('.item').forEach(i => i.onclick = () => { S.sel = i.dataset.id; S.activeQuiz = null; refreshList(); renderViewer(); });
  el.querySelectorAll('.item button').forEach(b => b.onclick = e => { e.stopPropagation(); edit(b.closest('.item').dataset.id, b.dataset.a); });
  refreshQuizPanels();
}

async function edit(id, what) {
  const f = S.files.find(x => x.id === id); if (!f) return;
  let patch;
  if (what === 'rn') { const n = prompt('New file name', f.name); if (!n || !n.trim()) return; patch = { name: n }; }
  else { const c = prompt('Caption (empty = remove)', f.caption || ''); if (c === null) return; patch = { caption: c }; }
  try { await API.update(id, patch); await load(); refreshList(); renderViewer(); } catch (e) { alert(e.message); }
}

function renderViewer() {
  const vw = $('#vw');
  if (S.activeQuiz && S.user.role === 'student') {
    const quiz = S.quizzes.find(item => item.id === S.activeQuiz);
    if (quiz) { renderStudentQuiz(quiz); return; }
    S.activeQuiz = null;
  }
  const f = S.files.find(x => x.id === S.sel);
  if (!f) { vw.innerHTML = '<div class="mu">Select a file to open it.</div>'; return; }
  const t = ['teacher', 'owner'].includes(S.user.role), u = API.rawUrl(f.id);
  const body = f.kind === 'html' ? `<iframe sandbox="allow-scripts allow-forms allow-modals" src="${u}"></iframe>`
    : f.kind === 'image' ? `<img src="${u}" alt="${esc(f.name)}">`
    : f.kind === 'video' ? `<video controls src="${u}"></video>`
    : f.kind === 'pdf' ? `<embed type="application/pdf" src="${u}">`
    : `<a href="${u}" target="_blank" rel="noopener">Download ${esc(f.name)}</a>`;
  vw.innerHTML = `<div class="row"><b style="flex:1">${esc(f.name)}</b>${t ? `<button class="btn g" id="rn">Rename</button><button class="btn g" id="cp">${f.caption ? 'Edit caption' : 'Add caption'}</button><button class="btn r" id="dl">Delete</button>` : ''}</div>
    ${body}${f.caption ? `<div class="caption">${esc(f.caption)}</div>` : ''}`;
  if (t) {
    $('#rn').onclick = () => edit(f.id, 'rn'); $('#cp').onclick = () => edit(f.id, 'cp');
    $('#dl').onclick = async () => { if (!confirm('Delete ' + f.name + '?')) return; try { await API.remove(f.id); S.sel = null; await load(); refreshList(); renderViewer(); } catch (e) { alert(e.message); } };
  }
}

function buildQuizQuestionMarkup(index, question = { question: '', options: ['', ''], correctIndex: 0, explanation: '' }) {
  return `<div class="quiz-question" data-index="${index}">
    <div class="row quiz-head"><strong>Question ${index + 1}</strong><button type="button" class="btn g s remove-question">Remove</button></div>
    <label>Prompt<textarea name="question" rows="2" required>${esc(question.question || '')}</textarea></label>
    <div class="quiz-options">
      ${question.options.map((option, optionIndex) => `<label>Choice ${optionIndex + 1}<input name="option-${optionIndex}" value="${esc(option)}" type="text" required></label>`).join('')}
    </div>
    <label>Correct answer<select name="correctIndex">
      ${question.options.map((_, optionIndex) => `<option value="${optionIndex}" ${optionIndex === (question.correctIndex ?? 0) ? 'selected' : ''}>Choice ${optionIndex + 1}</option>`).join('')}
    </select></label>
    <label>Explanation<textarea name="explanation" rows="2">${esc(question.explanation || '')}</textarea></label>
  </div>`;
}

function setupQuizEditor() {
  const form = $('#quiz-form');
  if (!form) return;
  const list = $('#quiz-list');
  const questionsWrap = $('#quiz-questions');
  const addQuestionButton = $('#add-question');
  const createQuestion = (q = {}) => ({
    question: q.question || '',
    options: Array.isArray(q.options) && q.options.length ? q.options : ['', ''],
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
    explanation: q.explanation || ''
  });

  const renderQuestions = (questions = []) => {
    const items = (questions.length ? questions : [createQuestion()]).map((question, index) => buildQuizQuestionMarkup(index, question));
    questionsWrap.innerHTML = items.join('');
    questionsWrap.querySelectorAll('.remove-question').forEach((button) => {
      button.onclick = () => {
        const questionNodes = [...questionsWrap.querySelectorAll('.quiz-question')];
        if (questionNodes.length <= 1) return;
        const current = button.closest('.quiz-question');
        const nextQuestions = questionNodes.filter(node => node !== current).map(node => ({
          question: node.querySelector('[name="question"]').value,
          options: Array.from(node.querySelectorAll('input[type="text"]')).map(i => i.value),
          correctIndex: Number(node.querySelector('[name="correctIndex"]').value),
          explanation: node.querySelector('[name="explanation"]').value
        }));
        renderQuestions(nextQuestions.length ? nextQuestions : [createQuestion()]);
      };
    });
    questionsWrap.querySelectorAll('.quiz-question').forEach((node, index) => {
      node.querySelectorAll('input[type="text"]').forEach((input, optionIndex) => {
        input.onchange = () => {
          const field = node.querySelector('[name="correctIndex"]');
          if (!field) return;
          const max = node.querySelectorAll('input[type="text"]').length;
          if (Number(field.value) >= max) field.value = String(Math.max(0, max - 1));
        };
      });
    });
  };

  addQuestionButton.onclick = () => {
    const questions = [...questionsWrap.querySelectorAll('.quiz-question')].map(node => ({
      question: node.querySelector('[name="question"]').value,
      options: Array.from(node.querySelectorAll('input[type="text"]')).map(i => i.value),
      correctIndex: Number(node.querySelector('[name="correctIndex"]').value),
      explanation: node.querySelector('[name="explanation"]').value
    }));
    renderQuestions([...questions, createQuestion()]);
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const status = $('#quiz-status');
    const title = form.querySelector('[name="title"]').value.trim();
    const description = form.querySelector('[name="description"]').value.trim();
    const questions = [...questionsWrap.querySelectorAll('.quiz-question')].map((node, index) => {
      const optionInputs = [...node.querySelectorAll('input[type="text"]')];
      const options = optionInputs.map(input => input.value.trim()).filter(Boolean);
      const correctIndex = Number(node.querySelector('[name="correctIndex"]').value);
      const question = node.querySelector('[name="question"]').value.trim();
      const explanation = node.querySelector('[name="explanation"]').value.trim();
      if (!question || options.length < 2) return null;
      return { question, options, correctIndex: Math.min(correctIndex, options.length - 1), explanation, order: index };
    }).filter(Boolean);
    if (!title) {
      S.quizMsg = 'Please add a quiz title.';
      if (status) status.textContent = S.quizMsg;
      return;
    }
    if (!questions.length) {
      S.quizMsg = 'Please add at least one complete question with two or more choices.';
      if (status) status.textContent = S.quizMsg;
      return;
    }
    try {
      await API.createQuiz({ title, description, questions });
      form.reset();
      renderQuizList();
      renderQuestions([createQuestion()]);
      S.quizMsg = 'Quiz exercise added ✓';
      if (status) status.textContent = S.quizMsg;
    } catch (e) {
      S.quizMsg = e.message;
      if (status) status.textContent = S.quizMsg;
    }
  };

  renderQuestions();
  renderQuizList();
}

async function renderQuizList() {
  const list = $('#quiz-list');
  if (!list) return;
  try {
    const quizzes = await API.quizzes();
    S.quizzes = quizzes;
    list.innerHTML = quizzes.length ? quizzes.map(quiz => `<div class="quiz-item">
      <div class="row"><b>${esc(quiz.title)}</b><button class="btn r s" data-delete-quiz="${esc(quiz.id)}" type="button">Delete</button></div>
      <div class="mu">${esc(quiz.description || 'No description')}</div>
      <div class="mu">${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}</div>
    </div>`).join('') : '<div class="mu">No quizzes yet.</div>';
    list.querySelectorAll('[data-delete-quiz]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('Delete this quiz?')) return;
        try {
          await API.deleteQuiz(button.dataset.deleteQuiz);
          await renderQuizList();
        } catch (e) { alert(e.message); }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="mu">${esc(e.message)}</div>`;
  }
}

function refreshQuizPanels() {
  if (['teacher', 'owner'].includes(S.user.role)) {
    renderQuizList();
    renderAttemptList();
  } else {
    renderStudentQuizList();
  }
}

function renderStudentQuizList() {
  const list = $('#student-quiz-list');
  if (!list) return;
  list.innerHTML = S.quizzes.length ? S.quizzes.map(quiz => {
    const submissions = S.attempts.filter(attempt => attempt.quizId === quiz.id);
    const latest = submissions[0];
    return `<div class="quiz-item">
      <div class="row"><b>${esc(quiz.title)}</b><button class="btn s" type="button" data-take-quiz="${esc(quiz.id)}">${latest ? 'Try again' : 'Start'}</button></div>
      <div class="mu">${esc(quiz.description || 'No description')}</div>
      <div class="mu">${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}${latest ? ` · Latest score: ${latest.score}/${latest.total}` : ''}</div>
    </div>`;
  }).join('') : '<div class="mu">No quiz exercises yet.</div>';
  list.querySelectorAll('[data-take-quiz]').forEach(button => {
    button.onclick = () => {
      S.activeQuiz = button.dataset.takeQuiz;
      S.sel = null;
      renderViewer();
    };
  });
}

function renderAttemptList() {
  const list = $('#attempt-list');
  if (!list) return;
  list.innerHTML = S.attempts.length ? S.attempts.map(attempt => `<div class="quiz-item">
    <b>${esc(attempt.studentName)} (@${esc(attempt.username)})</b>
    <div>${esc(attempt.quizTitle)} — ${attempt.score}/${attempt.total}</div>
    <div class="mu">${esc(new Date(attempt.submittedAt).toLocaleString())}</div>
  </div>`).join('') : '<div class="mu">No student submissions yet.</div>';
}

function renderStudentQuiz(quiz) {
  const vw = $('#vw');
  const latestAttempt = S.attempts.find(attempt => attempt.quizId === quiz.id);
  vw.innerHTML = `<div class="row"><h2 class="quiz-player-title">${esc(quiz.title)}</h2><button class="btn g" id="back-to-quizzes" type="button">Back to quizzes</button></div>
    ${quiz.description ? `<p>${esc(quiz.description)}</p>` : ''}
    ${latestAttempt ? `<p class="mu">Your latest score: ${latestAttempt.score}/${latestAttempt.total}</p>` : ''}
    <form id="student-quiz-form" class="quiz-form">
      ${quiz.questions.map((question, index) => `<fieldset class="student-question">
        <legend>${index + 1}. ${esc(question.question)}</legend>
        ${question.options.map((option, optionIndex) => `<label class="answer-option"><input type="radio" name="answer-${esc(question.id)}" value="${optionIndex}" required> ${esc(option)}</label>`).join('')}
      </fieldset>`).join('')}
      <button class="btn" type="submit">Submit answers</button>
      <div class="mu" id="submission-status" role="status" aria-live="polite"></div>
    </form>`;
  $('#back-to-quizzes').onclick = () => { S.activeQuiz = null; renderViewer(); };
  $('#student-quiz-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const answers = [...form.querySelectorAll('.student-question')].map(question => {
      const selected = question.querySelector('input[type="radio"]:checked');
      return selected ? Number(selected.value) : null;
    });
    const button = form.querySelector('button[type="submit"]');
    const status = $('#submission-status');
    button.disabled = true;
    status.textContent = 'Saving your answers…';
    try {
      const attempt = await API.submitQuiz(quiz.id, answers);
      S.attempts.unshift(attempt);
      refreshQuizPanels();
      renderStudentQuizResult(quiz, attempt);
    } catch (e) {
      status.textContent = e.message;
      button.disabled = false;
    }
  };
}

function renderStudentQuizResult(quiz, attempt) {
  const vw = $('#vw');
  vw.innerHTML = `<div class="row"><h2 class="quiz-player-title">${esc(quiz.title)}</h2><button class="btn g" id="back-to-quizzes" type="button">Back to quizzes</button></div>
    <h3>Your score: ${attempt.score}/${attempt.total}</h3>
    ${attempt.answers.map((answer, index) => `<div class="quiz-result ${answer.correct ? 'correct' : 'incorrect'}">
      <b>${index + 1}. ${esc(answer.question)}</b>
      <div>Your answer: ${esc(answer.options[answer.selectedIndex] || '')}</div>
      <div>Correct answer: ${esc(answer.options[answer.correctIndex] || '')}</div>
      ${answer.explanation ? `<div class="mu">${esc(answer.explanation)}</div>` : ''}
    </div>`).join('')}`;
  $('#back-to-quizzes').onclick = () => { S.activeQuiz = null; renderViewer(); };
}

init();
