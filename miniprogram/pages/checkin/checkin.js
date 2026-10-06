const { createCheckinClient } = require('../../checkin-client.js');

Page({
  data: {
    loggedIn: false,
    nickname: '',
    inviteCode: '',
    image: null,
    audio: null,
    reflection: '',
    uploaded: false,
    pending: false,
    busy: false,
    busyLabel: '',
    error: '',
    success: '',
    duplicatePrompt: false,
    duplicateMessage: '',
  },

  onLoad() {
    const app = getApp();
    this.client = createCheckinClient(wx, { apiBaseUrl: app.globalData.apiBaseUrl });
  },

  onShow() {
    if (this.client && this.data.loggedIn) this.syncPending(this.data.nickname);
  },

  clearMessage() {
    this.setData({ error: '', success: '' });
  },

  showError(error) {
    this.setData({ error: error?.message || '操作失败，请稍后重试', success: '' });
  },

  syncPending(nickname = this.data.nickname) {
    const pending = this.client?.getPending(nickname);
    this.setData({
      pending: Boolean(pending && pending.phase !== 'uploaded'),
      uploaded: Boolean(pending && pending.phase === 'uploaded'),
      ...(pending && !this.data.reflection ? { reflection: pending.reflection || '' } : {}),
    });
  },

  async onLogin(event) {
    if (this.data.busy) return;
    const nickname = String(event.detail.value.nickname || '').trim();
    const invite_code = String(event.detail.value.invite_code || '').trim();
    this.clearMessage();
    if (!nickname || !invite_code) {
      this.showError(new Error('请填写昵称和邀请码'));
      return;
    }
    this.setData({ busy: true, busyLabel: '验证中…' });
    try {
      await this.client.verify({ nickname, invite_code });
      this.setData({ loggedIn: true, nickname, inviteCode: invite_code });
      this.syncPending(nickname);
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  logout() {
    if (this.data.busy) return;
    this.setData({ loggedIn: false, nickname: '', inviteCode: '', image: null, audio: null, reflection: '', pending: false, uploaded: false });
    this.clearMessage();
  },
  async chooseImage() {
    if (this.data.busy) return;
    if (this.data.pending) { this.showError(new Error('请先重交本次登记，确认结果后再选择新材料')); return; }
    this.clearMessage();
    this.setData({ busy: true, busyLabel: '选择材料…' });
    try {
      const image = await this.client.chooseImageFile();
      // 重新选材料意味着开始新提交；结果未知重交只能继续使用旧回执。
      this.client.clearPending(this.data.nickname);
      this.setData({ image, pending: false, uploaded: false });
      await this.uploadWhenReady();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  async chooseAudio() {
    if (this.data.busy) return;
    if (this.data.pending) { this.showError(new Error('请先重交本次登记，确认结果后再选择新材料')); return; }
    this.clearMessage();
    this.setData({ busy: true, busyLabel: '选择材料…' });
    try {
      const audio = await this.client.chooseAudioFile();
      this.client.clearPending(this.data.nickname);
      this.setData({ audio, pending: false, uploaded: false });
      await this.uploadWhenReady();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

  async uploadWhenReady() {
    if (!this.data.image || !this.data.audio) return;
    this.setData({ busyLabel: '材料齐备，正在自动上传…' });
    const result = await this.client.uploadMaterials({ nickname: this.data.nickname, invite_code: this.data.inviteCode, image: this.data.image, audio: this.data.audio, confirmDuplicateDay: message => this.askDuplicateDay(message) });
    if (result.status === 'cancelled') { this.showError(new Error(result.error)); return; }
    this.syncPending();
  },

  removeImage() {
    if (this.data.busy || this.data.pending) return;
    this.client.clearPending(this.data.nickname);
    this.setData({ image: null, pending: false, uploaded: false });
    this.clearMessage();
  },

  removeAudio() {
    if (this.data.busy || this.data.pending) return;
    this.client.clearPending(this.data.nickname);
    this.setData({ audio: null, pending: false, uploaded: false });
    this.clearMessage();
  },

  onReflectionInput(event) {
    this.setData({ reflection: event.detail.value });
  },

  askDuplicateDay(message) {
    this.setData({ duplicatePrompt: true, duplicateMessage: message });
    return new Promise((resolve) => { this.duplicateResolver = resolve; });
  },

  resolveDuplicate(event) {
    const answer = event?.currentTarget?.dataset?.answer === 'true';
    const resolve = this.duplicateResolver;
    this.duplicateResolver = null;
    this.setData({ duplicatePrompt: false });
    resolve?.(answer);
  },

  async submit() {
    if (this.data.busy) return;
    const pending = this.client.getPending(this.data.nickname);
    if (!pending && (!this.data.image || !this.data.audio)) {
      this.showError(new Error('请先选择运动截图和阅读录音'));
      return;
    }
    this.clearMessage();
    this.setData({ busy: true, busyLabel: pending?.phase === 'uploaded' ? '登记打卡…' : pending ? '重交本次登记…' : '准备材料并上传…' });
    try {
      const result = await this.client.submit({
        nickname: this.data.nickname,
        invite_code: this.data.inviteCode,
        reflection: this.data.reflection,
        image: this.data.image,
        audio: this.data.audio,
        confirmDuplicateDay: (message) => this.askDuplicateDay(message),
      });
      if (result.status === 'cancelled') {
        this.showError(new Error(result.error));
        return;
      }
      const already = result.status === 'already';
      const statsPending = result.stats_updated === false;
      this.setData({
        image: null,
        audio: null,
        reflection: '',
        pending: statsPending,
        uploaded: false,
        success: statsPending
          ? '材料已经登记，但统计暂未更新；请重交本次登记以补齐统计，不会重复写入 ima。'
          : (already ? '本次是安全重交：此前已经登记成功，没有重复写入。' : '打卡成功：截图、录音和感悟已登记。'),
        error: '',
      });
    } catch (error) {
      this.syncPending(this.data.nickname);
      this.showError(error);
    } finally {
      this.setData({ busy: false, busyLabel: '' });
    }
  },

});
