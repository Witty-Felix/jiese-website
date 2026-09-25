// 戒色打卡 前端逻辑：登录 → 打卡 → 打卡榜
// 草稿与用户状态存 localStorage；提交目标为同源 /api/*（无 CORS 问题）

const LS_USER = 'jiese-user-v1';
const LS_DRAFT = 'jiese-draft-v1';

const $ = (id) => document.getElementById(id);
const views = { login: $('view-login'), checkin: $('view-checkin'), done: $('view-done') };

function show(name) {
  Object.values(views).forEach((v) => { v.hidden = true; });
  views[name].hidden = false;
  window.scrollTo(0, 0);
}

function getUser() {
  try { return JSON.parse(localStorage.getItem(LS_USER)); } catch { return null; }
}
function setUser(u) {
  if (u) localStorage.setItem(LS_USER, JSON.stringify(u));
  else localStorage.removeItem(LS_USER);
}

function todayLine() {
  const t = new Date(Date.now() + 8 * 3600e3).toISOString();
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(t).getUTCDay()];
  return `${t.slice(0, 10)} · 星期${week}`;
}

/* ---------- 登录 ---------- */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.hidden = true;
  const nickname = $('login-nickname').value.trim();
  const invite_code = $('login-invite').value.trim();
  if (!nickname || !invite_code) {
    err.textContent = '请填写昵称和邀请码'; err.hidden = false; return;
  }
  const btn = $('login-btn');
  btn.disabled = true; btn.textContent = '验证中…';
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, invite_code }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '验证失败');
    setUser({ nickname, invite_code });
    enterCheckin();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = '进入打卡';
  }
});

$('logout-btn').addEventListener('click', () => {
  setUser(null);
  $('login-invite').value = '';
  show('login');
});

/* ---------- 打卡 ---------- */

let pickedImage = null;
let pickedAudio = null;

function fmtSize(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function bindFilebox(boxId, inputId, emptyId, pickedId, kind) {
  const box = $(boxId), input = $(inputId), empty = $(emptyId), picked = $(pickedId);
  const open = () => input.click();
  box.addEventListener('click', (e) => { if (!e.target.closest('.clear')) open(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  input.addEventListener('change', () => { if (input.files[0]) setPicked(input.files[0]); });
  box.addEventListener('dragover', (e) => e.preventDefault());
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) {
      input.files = e.dataTransfer.files;
      setPicked(e.dataTransfer.files[0]);
    }
  });
  function setPicked(file) {
    const isImage = kind === 'image';
    const ok = isImage
      ? ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
      : /\.(mp3|m4a|wav|aac)$/i.test(file.name);
    if (!ok) { alert(isImage ? '请选择 PNG/JPG/WebP 图片' : '请选择 MP3/M4A/WAV/AAC 音频'); return; }
    if (isImage && file.size > 30 * 1024 * 1024) { alert('图片超过 30MB'); return; }
    if (!isImage && file.size > 200 * 1024 * 1024) { alert('录音超过 200MB'); return; }
    if (isImage) pickedImage = file; else pickedAudio = file;

    picked.innerHTML = '';
    if (isImage) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);
      picked.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'icon'; icon.textContent = '♪';
      picked.appendChild(icon);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<strong></strong><span>${fmtSize(file.size)}</span>`;
    meta.querySelector('strong').textContent = file.name;
    picked.appendChild(meta);
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'btn btn-ghost btn-sm clear'; clear.textContent = '移除';
    clear.addEventListener('click', () => {
      input.value = '';
      if (isImage) pickedImage = null; else pickedAudio = null;
      empty.hidden = false; picked.hidden = true;
      updateBtn();
    });
    picked.appendChild(clear);
    empty.hidden = true; picked.hidden = false;
    updateBtn();
  }
}

bindFilebox('box-image', 'input-image', 'empty-image', 'picked-image', 'image');
bindFilebox('box-audio', 'input-audio', 'empty-audio', 'picked-audio', 'audio');

function updateBtn() {
  $('checkin-btn').disabled = !(pickedImage && pickedAudio);
}

const reflectionEl = $('input-reflection');
reflectionEl.addEventListener('input', () => {
  $('reflection-count').textContent = String(reflectionEl.value.length);
  localStorage.setItem(LS_DRAFT, JSON.stringify({ reflection: reflectionEl.value }));
});
try {
  const draft = JSON.parse(localStorage.getItem(LS_DRAFT));
  if (draft?.reflection) { reflectionEl.value = draft.reflection; $('reflection-count').textContent = String(draft.reflection.length); }
} catch { /* 忽略 */ }

// 浏览器直传 COS（ADR-0005）：预签好 Authorization，跳过服务器中转
function cosPut(item, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', item.cos_url);
    xhr.setRequestHeader('Authorization', item.authorization);
    xhr.setRequestHeader('x-cos-security-token', item.token);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(true);
      else reject(new Error(`截图/录音直传失败（HTTP ${xhr.status}），请重试`));
    };
    xhr.onerror = () => reject(new Error('直传网络错误，请重试'));
    xhr.ontimeout = () => reject(new Error('直传超时，请重试'));
    xhr.timeout = 600000;
    xhr.send(blob);
  });
}

$('checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = getUser();
  if (!user) { show('login'); return; }
  const err = $('checkin-error');
  err.hidden = true;

  const btn = $('checkin-btn');
  const progress = $('progress');
  const pText = $('progress-text');
  const bar = $('progress-bar');
  const barFill = $('progress-bar-fill');
  const setProgress = (text, pct) => {
    pText.textContent = text;
    if (pct == null) { bar.hidden = true; }
    else { bar.hidden = false; barFill.style.width = pct + '%'; }
  };
  btn.disabled = true; btn.hidden = true;
  progress.hidden = false;
  setProgress('准备直传…', null);

  try {
    // ① 准备：服务端校验 + 签发直传凭证
    const prepRes = await fetch('/api/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname: user.nickname,
        invite_code: user.invite_code,
        image: { size: pickedImage.size, type: pickedImage.type },
        audio: { size: pickedAudio.size, type: pickedAudio.type },
      }),
    });
    const prep = await prepRes.json();
    if (!prep.ok) throw new Error(prep.error || '准备直传失败');

    // ② 直传：两个文件并行推到 COS，进度按总字节合并显示
    const total = pickedImage.size + pickedAudio.size;
    let doneBytes = 0;
    const mkTracker = (size) => {
      let last = 0;
      return (loaded) => {
        doneBytes += loaded - last;
        last = loaded;
        const pct = Math.min(99, Math.floor((doneBytes / total) * 100));
        setProgress(`直传材料中 ${pct}%`, pct);
      };
    };
    await Promise.all([
      cosPut(prep.image, pickedImage, mkTracker(pickedImage.size)),
      cosPut(prep.audio, pickedAudio, mkTracker(pickedAudio.size)),
    ]);
    setProgress('材料已到知识库存储，正在登记打卡…', 99);

    // ③ 登记：入库 ima + 写统计
    const finRes = await fetch('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname: user.nickname,
        invite_code: user.invite_code,
        reflection: reflectionEl.value,
        image: { media_id: prep.image.media_id, cos_key: prep.image.cos_key, size: pickedImage.size },
        audio: { media_id: prep.audio.media_id, cos_key: prep.audio.cos_key, size: pickedAudio.size },
      }),
    });
    const fin = await finRes.json();
    if (!fin.ok) throw new Error(fin.error || '登记失败，请稍后重试');

    $('done-line').textContent = `${user.nickname} · ${fin.date} 已记录`;
    localStorage.removeItem(LS_DRAFT);
    reflectionEl.value = ''; $('reflection-count').textContent = '0';
    show('done');
    loadStats();
  } catch (ex) {
    err.textContent = ex.message || '提交失败，请稍后重试';
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.hidden = false;
    progress.hidden = true;
    bar.hidden = true;
    barFill.style.width = '0%';
    updateBtn();
  }
});

$('done-back').addEventListener('click', () => { show('checkin'); });

/* ---------- 打卡榜 ---------- */

async function loadStats() {
  const body = $('stats-body');
  const empty = $('stats-empty');
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const me = getUser()?.nickname;
    body.innerHTML = '';
    data.rows.forEach((r) => {
      const tr = document.createElement('tr');
      if (r.nickname === me) tr.className = 'me';
      const name = document.createElement('td');
      name.textContent = r.nickname;
      if (r.checked_today) {
        const b = document.createElement('span');
        b.className = 'badge'; b.textContent = '今日已打卡';
        name.appendChild(b);
      }
      tr.appendChild(name);
      for (const v of [r.total, r.streak, r.last_date]) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      // 管理操作列（ADR-0006）：仅管理模式下可见（CSS body.admin-mode 控制）
      const actions = document.createElement('td');
      actions.className = 'admin-col';
      const acts = document.createElement('div');
      acts.className = 'admin-actions';
      const btnDay = document.createElement('button');
      btnDay.type = 'button'; btnDay.className = 'btn btn-ghost btn-sm'; btnDay.textContent = '删某天';
      btnDay.addEventListener('click', () => deleteDay(r.nickname));
      const btnAll = document.createElement('button');
      btnAll.type = 'button'; btnAll.className = 'btn btn-ghost btn-sm danger'; btnAll.textContent = '清空';
      btnAll.addEventListener('click', () => clearUser(r.nickname));
      acts.append(btnDay, btnAll);
      actions.appendChild(acts);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
    empty.hidden = data.rows.length > 0;
    $('stats-updated-line').textContent = `统计日期 ${data.today} · 按累计天数排序`;
  } catch {
    empty.hidden = false;
    empty.textContent = '统计加载失败，请稍后刷新重试';
  }
}

$('refresh-stats').addEventListener('click', loadStats);

/* ---------- 管理模式（ADR-0006） ---------- */
// 密码存 sessionStorage（随删除请求携带，不落 localStorage）；站内删除仅作用于 KV 统计，
// ima 知识库内容无站内删除通道，只能在 ima 客户端自行删除。

const SS_ADMIN_PWD = 'jiese-admin-pwd';
let adminMode = false;

function setAdminMode(on) {
  adminMode = on;
  document.body.classList.toggle('admin-mode', on);
  $('admin-toggle').textContent = on ? '退出管理' : '管理';
}

$('admin-toggle').addEventListener('click', async () => {
  if (adminMode) {
    sessionStorage.removeItem(SS_ADMIN_PWD);
    setAdminMode(false);
    return;
  }
  const pwd = prompt('请输入管理密码：');
  if (!pwd) return;
  try {
    const res = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_password: pwd }),
    });
    const data = await res.json();
    if (!data.ok) { alert(data.error || '管理密码不正确'); return; }
    sessionStorage.setItem(SS_ADMIN_PWD, pwd);
    setAdminMode(true);
    loadStats();
  } catch {
    alert('验证失败，请稍后重试');
  }
});

async function adminDelete(payload) {
  const res = await fetch('/api/admin/checkin', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      admin_password: sessionStorage.getItem(SS_ADMIN_PWD) || '',
      operator: getUser()?.nickname || 'admin',
    }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (res.status === 401) {
    // 密码失效（服务端已更换）：自动退回未解锁态
    sessionStorage.removeItem(SS_ADMIN_PWD);
    setAdminMode(false);
    throw new Error(data.error || '管理密码已失效，请重新解锁');
  }
  if (!data.ok) throw new Error(data.error || '删除失败，请稍后重试');
  return data;
}

async function deleteDay(nickname) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const raw = prompt(`删除 ${nickname} 哪一天的打卡记录？\n格式 yyyy-mm-dd，例如 ${today}`);
  if (!raw) return;
  const date = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('日期格式应为 yyyy-mm-dd'); return; }
  if (!confirm(`确认删除 ${nickname} ${date} 的打卡统计记录？\n删除后当天可重新打卡；ima 知识库中的内容不受影响。`)) return;
  try {
    await adminDelete({ nickname, date });
    alert('已删除 1 条记录');
    loadStats();
  } catch (ex) {
    alert(ex.message);
  }
}

async function clearUser(nickname) {
  const c = prompt(`⚠️ 整户清空不可恢复！\n将删除 ${nickname} 的全部打卡统计记录（从打卡榜消失）。\nima 知识库中的内容不受影响，只能在 ima 客户端自行删除。\n\n请输入该成员昵称以确认：`);
  if (c === null) return;
  if (c.trim() !== nickname) { alert('昵称不一致，已取消'); return; }
  try {
    const r = await adminDelete({ nickname, all: true });
    alert(`已删除 ${r.deleted} 条记录`);
    loadStats();
  } catch (ex) {
    alert(ex.message);
  }
}

// 刷新页面后 sessionStorage 存活期内自动恢复管理模式
if (sessionStorage.getItem(SS_ADMIN_PWD)) setAdminMode(true);

/* ---------- 入口 ---------- */

function enterCheckin() {
  $('user-nickname').textContent = getUser()?.nickname || '';
  $('today-line').textContent = todayLine();
  show('checkin');
  loadStats();
}

if (getUser()) enterCheckin(); else show('login');
