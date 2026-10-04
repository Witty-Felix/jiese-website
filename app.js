// 戒色打卡 前端逻辑：登录 → 打卡 → 打卡榜
// 草稿、用户状态与提交检查点存 localStorage；提交目标为同源 /api/*（无 CORS 问题）

const LS_USER = 'jiese-user-v1';
const LS_DRAFT = 'jiese-draft-v1';

// Keep the browser preflight limits aligned with functions/api/_upload-contract.js.
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const H5_AUDIO_MAX_BYTES = 200 * 1024 * 1024;
// 提交检查点（ADR-0010）：一次提交的 submission_id 与两个直传回执。
// 按昵称分键——同一台设备上换人登录不会串到对方的提交上。
const LS_PENDING = 'jiese-pending-v1';

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

// 业务日期一律按 Asia/Shanghai（与服务端 shanghaiDate 同一口径）
function todayDate() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
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

// Browser/WeChat drag sources may omit MIME; use the supported extension only then.
const FILE_TYPES = {
  image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' },
  audio: { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac' },
};
function uploadType(file, kind) {
  const ext = file.name.split('.').pop().toLowerCase();
  const supported = FILE_TYPES[kind];
  const expected = supported[ext];
  if (!expected) return null;
  if (!file.type || file.type === 'application/octet-stream') return expected;
  if (file.type === expected || (ext === 'm4a' && file.type === 'audio/x-m4a') ||
      (ext === 'wav' && file.type === 'audio/x-wav')) return file.type;
  return null;
}

function bindFilebox(boxId, inputId, emptyId, pickedId, kind) {
  const box = $(boxId), input = $(inputId), empty = $(emptyId), picked = $(pickedId), feedback = $(`feedback-${kind}`);
  const isImage = kind === 'image';
  const maxSize = isImage ? IMAGE_MAX_BYTES : H5_AUDIO_MAX_BYTES;
  const open = () => input.click();
  box.addEventListener('click', (e) => { if (!e.target.closest('.clear')) open(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  input.addEventListener('change', () => {
    if (input.files[0]) setPicked(input.files[0]);
  });
  box.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    box.classList.add('is-dragging');
  });
  box.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    box.classList.add('is-dragging');
  });
  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('is-dragging');
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('is-dragging');
    const files = e.dataTransfer?.files;
    if (!files || !files.length) {
      showFeedback('没有识别到文件，请从微信聊天窗口拖入，或点击“系统选择”作为兜底。');
      return;
    }
    if (files.length > 1) {
      showFeedback('每个上传框一次只接收一个文件，请只拖入一项；也可以点击“系统选择”。');
      return;
    }
    setPicked(files[0]);
  });
  function hasFiles(dataTransfer) {
    return Array.from(dataTransfer?.types || []).includes('Files') || dataTransfer?.files?.length > 0;
  }
  function showFeedback(message) {
    feedback.textContent = message;
    feedback.hidden = !message;
    box.classList.toggle('is-invalid', Boolean(message));
  }
  function clearFeedback() { showFeedback(''); }
  function setPicked(file) {
    if (!uploadType(file, kind)) {
      reset();
      showFeedback(isImage
        ? '无法识别这张图片，请选择 PNG / JPG / WebP；微信语音消息不支持。'
        : '无法识别这段录音，请选择 MP3 / M4A / WAV / AAC；微信语音消息不支持。');
      input.value = '';
      return;
    }
    if (file.size > maxSize) {
      reset();
      showFeedback(isImage ? '图片超过 30MB，请压缩后再试。' : '录音超过 200MB，请选择更小的文件。');
      input.value = '';
      return;
    }
    clearFeedback();
    if (isImage) pickedImage = file; else pickedAudio = file;
    // 换了材料就是另一次提交：老检查点的 submission_id 对应的是老素材，
    // 留着它会让「重交本次」把新选的图配上旧回执——必须在这里丢掉（ADR-0010）
    dropPending();

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
    clear.addEventListener('click', reset); // 与整体重置同一套清理逻辑，避免两处口径漂移
    picked.appendChild(clear);
    empty.hidden = true; picked.hidden = false;
    updateBtn();
  }

  // 重置文件框：清空 input.files（否则同一文件无法再选）、预览区与已选文件变量
  function reset() {
    input.value = '';
    clearFeedback();
    if (kind === 'image') pickedImage = null; else pickedAudio = null;
    picked.innerHTML = '';
    picked.hidden = true;
    empty.hidden = false;
    updateBtn();
  }

  return { reset };
}

const imageBox = bindFilebox('box-image', 'input-image', 'empty-image', 'picked-image', 'image');
const audioBox = bindFilebox('box-audio', 'input-audio', 'empty-audio', 'picked-audio', 'audio');

function updateBtn() {
  // 有未完成的提交时按钮必须可点：刷新页面后文件框是空的（浏览器不保留文件选择），
  // 但检查点还在——「重交本次」正是为了这种时候存在的（ADR-0010）
  $('checkin-btn').disabled = !(pickedImage && pickedAudio) && !readPending(getUser()?.nickname);
  syncResumeHint();
}

/* ---------- 提交检查点与「今天已打过卡」确认（ADR-0010）----------
 * 直传成功后、finalize 的回执丢失时，材料其实已经躺在知识库存储里，只是「登记」这一步结果未知。
 * 这时**绝不能重新 prepare**：那会换一个新的 submission_id，服务端就认不出是同一次提交了。
 * 检查点把这一次提交的身份（submission_id）与回执（两个 media_id / cos_key）留在本地，
 * 让「重交本次」能原样再问一次 —— 服务端因此幂等命中，而不是把素材写第二遍。
 */
const pendingKey = (nickname) => `${LS_PENDING}:${nickname}`;

function readPending(nickname) {
  if (!nickname) return null;
  let p;
  try { p = JSON.parse(localStorage.getItem(pendingKey(nickname))); } catch { return null; }
  if (!p?.submission_id) return null;
  if (p.date !== todayDate()) {
    // 跨天即作废：服务端那条记录 24 小时后也过期了，留着只会让重交撞上「提交已过期」
    localStorage.removeItem(pendingKey(nickname));
    return null;
  }
  return p;
}

function savePending(p) {
  localStorage.setItem(pendingKey(p.nickname), JSON.stringify(p));
}

function dropPending() {
  const nickname = getUser()?.nickname;
  if (nickname) localStorage.removeItem(pendingKey(nickname));
}

// 按钮文案与提示随检查点状态联动
function syncResumeHint() {
  const pending = readPending(getUser()?.nickname);
  $('checkin-btn').textContent = pending ? '重交本次登记' : '提交打卡';
  const hint = $('resume-hint');
  hint.textContent = pending
    ? '上一次的登记结果没有收到回执。材料已经上传好了，直接点上面的按钮重交即可——服务端认得出是同一次提交，不会重复登记。想换材料就重新选，那会算作新的一次打卡。'
    : '';
  hint.hidden = !pending;
}

// 就地确认，不用 window.confirm：它是在 await 之后才弹的，已脱离用户手势上下文，
// 微信内置浏览器会直接拦掉，用户什么也看不到
function askDuplicateDay(message) {
  return new Promise((resolve) => {
    const box = $('checkin-confirm');
    const yes = $('confirm-yes');
    const no = $('confirm-no');
    $('checkin-confirm-text').textContent = message;
    box.hidden = false;
    const finish = (answer) => {
      box.hidden = true;
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      resolve(answer);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
  });
}

// 打卡成功后表单必须回到「干净」状态：否则截图/录音仍挂在页面上，
// updateBtn() 会让提交按钮再次可点，等于允许用同一批文件重复打卡
function resetCheckinForm() {
  imageBox.reset();
  audioBox.reset();
  reflectionEl.value = '';
  $('reflection-count').textContent = '0';
  localStorage.removeItem(LS_DRAFT);
  dropPending(); // 登记已落定，检查点使命结束
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
function cosPut(item, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', item.cos_url);
    xhr.setRequestHeader('Authorization', item.authorization);
    xhr.setRequestHeader('x-cos-security-token', item.token);
    xhr.setRequestHeader('Content-Type', contentType);
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

// finalize 的单次调用。响应读不出来（网络断在半路、网关吐了非 JSON）就是「结果未知」：
// 检查点此刻已经落好了，用户重交即可，所以这里只给一句可行动的提示，不假装知道成败。
async function postFinalize(body) {
  let res;
  try {
    res = await fetch('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      stage: 'result_unknown',
      retryable: true,
      error: '没有收到登记结果，服务端可能已经登记。请点「重交本次登记」再试一次',
    };
  }
  const data = await res.json().catch(() => null);
  return data || {
    ok: false,
    stage: 'result_unknown',
    retryable: true,
    error: `没有收到登记结果（HTTP ${res.status}），服务端可能已经登记。请点「重交本次登记」再试一次`,
  };
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
    const nickname = user.nickname;
    const pending = readPending(nickname);
    let submissionId;
    let items;
    let retryReflection = reflectionEl.value;
    // 用户在 prepare 阶段就确认过「今天已有记录仍要再登记」；finalize 的闸门是权威的，
    // 提前确认过就得把它带过去，否则会被再问一遍（ADR-0010）
    let confirmedDuplicateDay = false;

    if (pending) {
      // 重交本次：整段 prepare + 直传跳过，复用第一次的 submission_id 与回执。
      // 这是幂等键生效的前提——重新 prepare 会换一个新 id，服务端就认不出是同一次提交了
      submissionId = pending.submission_id;
      items = { image: pending.image, audio: pending.audio };
      // 同一次提交的笔记内容也固定在检查点里，避免结果未知后修改感悟造成
      // 「同一 submission_id 对应两份不同登记内容」的歧义。
      retryReflection = typeof pending.reflection === 'string' ? pending.reflection : reflectionEl.value;
      setProgress('正在重交本次登记…', 99);
    } else {
      // ① 准备：服务端校验 + 签发本次提交的 submission_id 与直传凭证
      const prepRes = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname,
          invite_code: user.invite_code,
          image: { size: pickedImage.size, type: uploadType(pickedImage, 'image') },
          audio: { size: pickedAudio.size, type: uploadType(pickedAudio, 'audio') },
        }),
      });
      const prep = await prepRes.json();
      if (!prep.ok) throw new Error(prep.error || '准备直传失败');

      // 本日已有记录：在上传 200MB 之前就问，而不是等传完才拒（ADR-0010）
      if (prep.already_today) {
        if (!(await askDuplicateDay('你今天已经打过卡了。确认要再登记一次吗？'))) {
          err.textContent = '已取消：今天的打卡记录保持不变。';
          err.hidden = false;
          return;
        }
        confirmedDuplicateDay = true;
      }
      submissionId = prep.submission_id;

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
        cosPut(prep.image, pickedImage, uploadType(pickedImage, 'image'), mkTracker(pickedImage.size)),
        cosPut(prep.audio, pickedAudio, uploadType(pickedAudio, 'audio'), mkTracker(pickedAudio.size)),
      ]);
      setProgress('材料已到知识库存储，正在登记打卡…', 99);

      items = {
        image: { media_id: prep.image.media_id, cos_key: prep.image.cos_key, size: pickedImage.size },
        audio: { media_id: prep.audio.media_id, cos_key: prep.audio.cos_key, size: pickedAudio.size },
      };
      // 材料已就位、结果尚未可知 —— 从这里开始才需要检查点
      savePending({ nickname, date: prep.date, submission_id: submissionId, reflection: reflectionEl.value, ...items });
    }

    // ③ 登记：入库 ima + 写统计。重交与首次走同一段代码，差别只在 submission_id 是不是老的
    const finBody = {
      nickname,
      invite_code: user.invite_code,
      submission_id: submissionId,
      reflection: retryReflection,
      image: items.image,
      audio: items.audio,
      ...(confirmedDuplicateDay ? { allow_duplicate_day: true } : {}),
    };
    let fin = await postFinalize(finBody);

    // 自然日闸门（权威）：prepare 之后状态可能又变了，或客户端当时没问 —— 就地再问一次
    if (!fin.ok && fin.status === 'duplicate_day') {
      if (!(await askDuplicateDay(fin.error || '你今天已经打过卡了，确认要再登记一次吗？'))) {
        err.textContent = '已取消：今天的打卡记录保持不变。';
        err.hidden = false;
        return;
      }
      fin = await postFinalize({ ...finBody, allow_duplicate_day: true });
    }
    if (!fin.ok) {
      // 明确不可重试的提交（过期、身份/通道不匹配、ima 凭据失效）不能继续用旧回执重交。
      // 清掉检查点后，按钮回到「提交打卡」，用户可在修复问题后重新创建一次新提交。
      if (fin.retryable === false) dropPending();
      throw new Error(fin.error || '登记失败，请稍后重试');
    }

    dropPending(); // 登记已落定，检查点使命结束
    // already = 此前那一次其实登记成功了，本次是幂等命中——如实告诉用户，别让他以为又打了一次
    $('done-line').textContent = fin.status === 'already'
      ? `${nickname} · ${fin.date} 已登记（本次是重交，没有重复登记）`
      : `${nickname} · ${fin.date} 已记录`;
    resetCheckinForm(); // 清空截图/录音/感悟与草稿，回到可再次提交的干净状态
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

// 最近一次成功拉取的榜单数据；删除后的即时更新基于它本地重渲（KV list 有最终一致延迟，不能回源重拉）
let lastRows = null;
let lastToday = '';

function rowSort(a, b) {
  return b.total - a.total || b.streak - a.streak || a.nickname.localeCompare(b.nickname, 'zh');
}

function buildStatsRow(r, me) {
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
  return tr;
}

function renderStats(rows, today) {
  const body = $('stats-body');
  const empty = $('stats-empty');
  const me = getUser()?.nickname;
  body.innerHTML = '';
  rows.forEach((r) => body.appendChild(buildStatsRow(r, me)));
  empty.hidden = rows.length > 0;
  empty.textContent = '还没有任何打卡记录，来当第一个吧。';
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('stats-updated-line').textContent =
    `统计日期 ${today} · 按累计天数排序 · 更新于 ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

async function loadStats() {
  const empty = $('stats-empty');
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    lastRows = data.rows;
    lastToday = data.today;
    renderStats(lastRows, lastToday);
  } catch {
    empty.hidden = false;
    empty.textContent = '统计加载失败，请稍后刷新重试';
  }
}

// 删除后的本地即时更新：row 为该用户重算后的榜单行（null = 整户清空/无剩余记录）
function applyRowUpdate(nickname, row) {
  if (!lastRows) { loadStats(); return; }
  lastRows = lastRows.filter((r) => r.nickname !== nickname);
  if (row) lastRows.push(row);
  lastRows.sort(rowSort);
  renderStats(lastRows, lastToday);
}

$('refresh-stats').addEventListener('click', async () => {
  const btn = $('refresh-stats');
  btn.disabled = true; btn.textContent = '刷新中…';
  try { await loadStats(); } finally { btn.disabled = false; btn.textContent = '刷新'; }
});

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

// marked=false 表示删除标记未写入：KV list 同步窗口内刷新可能短暂看到已删记录（ADR-0007）
function markWarn(r) {
  return r?.marked === false
    ? '\n\n注意：统计过滤标记写入失败，刷新后可能短暂看到这条记录，稍后会自动消失。'
    : '';
}

async function deleteDay(nickname) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const raw = prompt(`删除 ${nickname} 哪一天的打卡记录？\n格式 yyyy-mm-dd，例如 ${today}`);
  if (!raw) return;
  const date = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('日期格式应为 yyyy-mm-dd'); return; }
  if (!confirm(`确认删除 ${nickname} ${date} 的打卡统计记录？\n删除后当天可重新打卡；ima 知识库中的内容不受影响。`)) return;
  try {
    const r = await adminDelete({ nickname, date });
    // 用响应中重算的行本地即时更新，避免 KV 最终一致延迟让已删记录短暂「复活」
    if (r && 'row' in r) applyRowUpdate(nickname, r.row);
    else loadStats(); // 兜底：旧版本 Function 未回传重算行
    alert('已删除 1 条记录' + markWarn(r));
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
    // 用响应中重算的行本地即时更新（正常情况下 row=null = 已无记录，直接移除该行）；
    // 若仍有剩余记录（并发新打卡等），以服务端重算结果为准，避免乐观 UI 与刷新后的榜单打架
    if (r && 'row' in r) applyRowUpdate(nickname, r.row);
    else loadStats();
    alert(`已删除 ${r.deleted} 条记录` + markWarn(r));
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
  updateBtn(); // 未完成的提交要在这里被认出来：刷新后文件框是空的，但检查点还在
  loadStats();
}

if (getUser()) enterCheckin(); else show('login');
