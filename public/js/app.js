// ═══════════════════════════════════════════════════════════
// Haven — Main Client Application
// Features: chat, voice, themes, images, multi-server,
//           notifications, volume sliders, status bar
// ═══════════════════════════════════════════════════════════

class HavenApp {
  constructor() {
    this.token = localStorage.getItem('haven_token');
    this.user = JSON.parse(localStorage.getItem('haven_user') || 'null');
    this.socket = null;
    this.voice = null;
    this.currentChannel = null;
    this.channels = [];
    this.typingTimeout = null;
    this.lastTypingEmit = 0;
    this.unreadCounts = {};
    this.onlineCount = 0;
    this.pingInterval = null;
    this.serverManager = new ServerManager();
    this.notifications = new NotificationManager();
    this.replyingTo = null;        // message object being replied to
    this.channelMembers = [];      // for @mention autocomplete
    this.mentionQuery = '';        // current partial @mention being typed
    this.mentionStart = -1;        // cursor position of the '@'
    this.editingMsgId = null;      // message currently being edited
    this.serverSettings = {};      // server-wide settings
    this.adminActionTarget = null; // { userId, username, action } for modal
    this.highScores = {};          // { flappy: [{user_id, username, score}] }
    this.userStatus = 'online';    // current user's status
    this.userStatusText = '';      // custom status text
    this.idleTimer = null;         // auto-away timer
    this.voiceCounts = {};         // { channelCode: count } for sidebar voice indicators

    // Slash command definitions for autocomplete
    this.slashCommands = [
      { cmd: 'shrug',      args: '[text]',   desc: 'Appends ¯\\_(ツ)_/¯' },
      { cmd: 'tableflip',  args: '[text]',   desc: 'Flip a table (╯°□°)╯︵ ┻━┻' },
      { cmd: 'unflip',     args: '[text]',   desc: 'Put the table back ┬─┬ ノ( ゜-゜ノ)' },
      { cmd: 'lenny',      args: '[text]',   desc: 'Lenny face ( ͡° ͜ʖ ͡°)' },
      { cmd: 'disapprove', args: '[text]',   desc: 'ಠ_ಠ look of disapproval' },
      { cmd: 'me',         args: '<action>', desc: 'Italic action message' },
      { cmd: 'spoiler',    args: '<text>',   desc: 'Hidden spoiler text' },
      { cmd: 'tts',        args: '<text>',   desc: 'Text-to-speech message' },
      { cmd: 'bbs',        args: '',         desc: 'Announce you\'ll be back soon' },
      { cmd: 'brb',        args: '',         desc: 'Announce you\'ll be right back' },
      { cmd: 'afk',        args: '',         desc: 'Away from keyboard' },
      { cmd: 'boobs',      args: '',         desc: '( . Y . )' },
      { cmd: 'butt',       args: '',         desc: '( . )( . )' },
      { cmd: 'nick',       args: '<name>',   desc: 'Change your username' },
      { cmd: 'clear',      args: '',         desc: 'Clear your chat view' },
      { cmd: 'flip',       args: '',         desc: 'Flip a coin: heads or tails' },
      { cmd: 'roll',       args: '[NdN]',    desc: 'Roll dice (e.g. /roll 2d6)' },
      { cmd: 'hug',        args: '<@user>',  desc: 'Send a hug to someone' },
      { cmd: 'wave',       args: '[text]',   desc: 'Wave at the chat 👋' },
    ];

    // Emoji palette organized by category
    this.emojiCategories = {
      'Smileys':  ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🙂','🤗','🤩','🤔','😐','🙄','😏','😣','😥','😮','😯','😴','😛','😜','😝','😒','😔','🙃','😲','😤','😭','😢','😱','🥺','😠','😡','🤬','😈','💀','💩','🤡','👻','😺','😸','🫠'],
      'People':   ['👋','🤚','✋','🖖','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','👍','👎','✊','👊','🤛','🤜','👏','🙌','🤝','🙏','💪','🫡','🫶','💅','💃','🕺','🤳','🖕'],
      'Animals':  ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🦆','🦅','🦉','🐺','🐴','🦄','🐝','🦋','🐌','🐞','🐢','🐍','🐙','🐬','🐳','🦈','🐊','🦖'],
      'Food':     ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🌶️','🍕','🍔','🍟','🌭','🍿','🧁','🍩','🍪','🍰','☕','🍺','🍷','🥤','🧊'],
      'Activities':['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🎮','🕹️','🎲','🧩','🎯','🎳','🎭','🎨','🎼','🎵','🎸','🥁','🎹','🏆','🥇','🏅','🎪','🎬'],
      'Travel':   ['🚗','🚕','🚀','✈️','🚁','🛸','🚢','🏠','🏢','🏰','🗼','🗽','⛩️','🌋','🏔️','🌊','🌅','🌄','🌉','🎡','🎢','🗺️','🧭','🏖️','🏕️'],
      'Objects':  ['⌚','📱','💻','⌨️','🖥️','💾','📷','🔭','🔬','💡','🔦','📚','📝','✏️','📎','📌','🔑','🔒','🔓','🛡️','⚔️','🔧','💰','💎','📦','🎁','✉️','🔔'],
      'Symbols':  ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💓','💗','✨','⭐','🌟','💫','🔥','💯','✅','❌','‼️','⁉️','❓','💤','🚫','⚠️','♻️','🏳️','🏴','🎵','➕','➖','➗','💲']
    };

    // Flat list for quick access (used by search)
    this.emojis = Object.values(this.emojiCategories).flat();

    if (!this.token || !this.user) {
      window.location.href = '/';
      return;
    }

    this._init();
  }

  // ── Initialization ────────────────────────────────────

  _init() {
    this.socket = io({ auth: { token: this.token } });
    this.voice = new VoiceManager(this.socket);

    this._setupSocketListeners();
    this._setupUI();
    this._setupThemes();
    this._setupServerBar();
    this._setupNotifications();
    this._setupImageUpload();
    this._setupGifPicker();
    this._startStatusBar();
    this._setupMobile();
    this._setupStatusPicker();
    this._setupFileUpload();
    this._setupIdleDetection();
    this._initSliderFills();

    // CSP-safe image error handling (no inline onerror attributes)
    document.getElementById('messages')?.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.style.display = 'none';
    }, true);

    this.socket.emit('get-channels');
    this.socket.emit('get-server-settings');
    this.socket.emit('get-preferences');
    this.socket.emit('get-high-scores', { game: 'flappy' });

    document.getElementById('current-user').textContent = this.user.displayName || this.user.username;
    const loginEl = document.getElementById('login-name');
    if (loginEl) loginEl.textContent = `@${this.user.username}`;

    if (this.user.isAdmin) {
      document.getElementById('admin-controls').style.display = 'block';
      document.getElementById('admin-mod-panel').style.display = 'block';
    }
  }

  // ── Socket Event Listeners ────────────────────────────

  _setupSocketListeners() {
    // Authoritative user info pushed by server on every connect
    this.socket.on('session-info', (data) => {
      this.user = { ...this.user, ...data };
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      // Refresh display name + admin UI with authoritative data
      document.getElementById('current-user').textContent = this.user.displayName || this.user.username;
      const loginEl = document.getElementById('login-name');
      if (loginEl) loginEl.textContent = `@${this.user.username}`;
      if (this.user.isAdmin) {
        document.getElementById('admin-controls').style.display = 'block';
        document.getElementById('admin-mod-panel').style.display = 'block';
      } else {
        document.getElementById('admin-controls').style.display = 'none';
        document.getElementById('admin-mod-panel').style.display = 'none';
      }
    });

    this.socket.on('connect', () => {
      this._setLed('connection-led', 'on');
      this._setLed('status-server-led', 'on');
      document.getElementById('status-server-text').textContent = 'Connected';
      this._startPingMonitor();
      // Re-join channel after reconnect (server lost our room membership)
      this.socket.emit('get-channels');
      this.socket.emit('get-server-settings');
      if (this.currentChannel) {
        this.socket.emit('enter-channel', { code: this.currentChannel });
        this.socket.emit('get-messages', { code: this.currentChannel });
        this.socket.emit('get-channel-members', { code: this.currentChannel });
      }
    });

    this.socket.on('disconnect', () => {
      this._setLed('connection-led', 'danger pulse');
      this._setLed('status-server-led', 'danger pulse');
      document.getElementById('status-server-text').textContent = 'Disconnected';
      document.getElementById('status-ping').textContent = '--';
    });

    this.socket.on('connect_error', (err) => {
      if (err.message === 'Invalid token' || err.message === 'Authentication required') {
        localStorage.removeItem('haven_token');
        localStorage.removeItem('haven_user');
        window.location.href = '/';
      }
      this._setLed('connection-led', 'danger');
      this._setLed('status-server-led', 'danger');
      document.getElementById('status-server-text').textContent = 'Error';
    });

    this.socket.on('channels-list', (channels) => {
      this.channels = channels;
      this._renderChannels();
    });

    this.socket.on('channel-created', (channel) => {
      this.channels.push(channel);
      this._renderChannels();
      this._showToast(`Channel "#${channel.name}" created!\nCode: ${channel.code}`, 'success');
      this.switchChannel(channel.code);
    });

    this.socket.on('channel-joined', (channel) => {
      if (!this.channels.find(c => c.code === channel.code)) {
        this.channels.push(channel);
        this._renderChannels();
      }
      this.switchChannel(channel.code);
    });

    this.socket.on('message-history', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._renderMessages(data.messages);
      }
    });

    this.socket.on('new-message', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._appendMessage(data.message);
        this._markRead(data.message.id);
        if (data.message.user_id !== this.user.id) {
          // Check if message contains @mention of current user
          const mentionRegex = new RegExp(`@${this.user.username}\\b`, 'i');
          if (mentionRegex.test(data.message.content)) {
            this.notifications.play('mention');
          } else {
            this.notifications.play('message');
          }
        }
        // TTS: speak the message aloud for all listeners
        if (data.message.tts) {
          this.notifications.speak(`${data.message.username} says: ${data.message.content}`);
        }
      } else {
        this.unreadCounts[data.channelCode] = (this.unreadCounts[data.channelCode] || 0) + 1;
        this._updateBadge(data.channelCode);
        // Check @mention even in other channels
        const mentionRegex = new RegExp(`@${this.user.username}\\b`, 'i');
        if (data.message.user_id !== this.user.id && mentionRegex.test(data.message.content)) {
          this.notifications.play('mention');
        } else {
          this.notifications.play('message');
        }
      }
    });

    this.socket.on('online-users', (data) => {
      if (data.channelCode === this.currentChannel) {
        this.onlineCount = data.users.length;
        this._renderOnlineUsers(data.users);
        document.getElementById('status-online-count').textContent = data.users.length;
      }
    });

    this.socket.on('voice-users-update', (data) => {
      // Always render voice panel when viewing the matching text channel
      if (data.channelCode === this.currentChannel) {
        this._renderVoiceUsers(data.users);
      }
      // Also update if we're in voice for this channel (we may be viewing a different text channel)
      if (this.voice && this.voice.inVoice && this.voice.currentChannel === data.channelCode) {
        // Keep voice bar up to date
        this._updateVoiceBar();
      }
    });

    // Lightweight sidebar voice count — fires for every voice join/leave
    this.socket.on('voice-count-update', (data) => {
      if (data.count > 0) {
        this.voiceCounts[data.code] = data.count;
      } else {
        delete this.voiceCounts[data.code];
      }
      this._updateChannelVoiceIndicators();
    });

    this.socket.on('user-typing', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._showTyping(data.username);
      }
    });

    this.socket.on('user-joined', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._appendSystemMessage(`${data.user.username} joined the channel`);
        this.notifications.play('join');
      }
    });

    this.socket.on('channel-deleted', (data) => {
      this.channels = this.channels.filter(c => c.code !== data.code);
      this._renderChannels();
      if (this.currentChannel === data.code) {
        this.currentChannel = null;
        this._showWelcome();
        this._showToast('Channel was deleted', 'error');
      }
    });

    this.socket.on('error-msg', (msg) => {
      this._showToast(msg, 'error');
    });

    this.socket.on('pong-check', () => {
      if (this._pingStart) {
        const latency = Date.now() - this._pingStart;
        document.getElementById('status-ping').textContent = latency;
      }
    });

    // ── Reactions ──────────────────────────────────────
    this.socket.on('reactions-updated', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._updateMessageReactions(data.messageId, data.reactions);
      }
    });

    // ── Channel members (for @mentions) ────────────────
    this.socket.on('channel-members', (data) => {
      if (data.channelCode === this.currentChannel) {
        this.channelMembers = data.members;
      }
    });

    // ── Channel topic changed ───────────────────────
    this.socket.on('channel-topic-changed', (data) => {
      const ch = this.channels.find(c => c.code === data.code);
      if (ch) ch.topic = data.topic;
      if (data.code === this.currentChannel) {
        this._updateTopicBar(data.topic);
      }
    });

    // ── DM opened ───────────────────────────────────
    this.socket.on('dm-opened', (data) => {
      if (!this.channels.find(c => c.code === data.code)) {
        this.channels.push(data);
        this._renderChannels();
      }
      this.switchChannel(data.code);
      // Scroll the DM channel into view in the sidebar
      const dmEl = document.querySelector(`.channel-item[data-code="${data.code}"]`);
      if (dmEl) dmEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Re-enable any disabled DM buttons
      document.querySelectorAll('.user-dm-btn[disabled]').forEach(b => { b.disabled = false; b.style.opacity = ''; });
    });

    // ── Status updated ──────────────────────────────
    this.socket.on('status-updated', (data) => {
      this.userStatus = data.status;
      this.userStatusText = data.statusText;
      this._updateStatusPickerUI();
    });

    // ── Username rename ──────────────────────────────
    this.socket.on('renamed', (data) => {
      this.token = data.token;
      this.user = data.user;
      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      document.getElementById('current-user').textContent = data.user.displayName || data.user.username;
      const loginEl = document.getElementById('login-name');
      if (loginEl) loginEl.textContent = `@${data.user.username}`;
      this._showToast(`Display name changed to "${data.user.displayName || data.user.username}"`, 'success');
      // Refresh admin UI in case admin status changed
      if (data.user.isAdmin) {
        document.getElementById('admin-controls').style.display = 'block';
        document.getElementById('admin-mod-panel').style.display = 'block';
        if (this.currentChannel) {
          document.getElementById('delete-channel-btn').style.display = 'inline-flex';
        }
      } else {
        document.getElementById('admin-controls').style.display = 'none';
        document.getElementById('admin-mod-panel').style.display = 'none';
        document.getElementById('delete-channel-btn').style.display = 'none';
      }
    });

    this.socket.on('user-renamed', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._appendSystemMessage(`${data.oldName} is now known as ${data.newName}`);
      }
    });

    // ── Message edit / delete ──────────────────────────
    this.socket.on('message-edited', (data) => {
      if (data.channelCode === this.currentChannel) {
        const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
        if (!msgEl) return;
        const contentEl = msgEl.querySelector('.message-content');
        if (contentEl) {
          contentEl.innerHTML = this._formatContent(data.content);
          // Add or update edited indicator
          let editedTag = msgEl.querySelector('.edited-tag');
          if (!editedTag) {
            editedTag = document.createElement('span');
            editedTag.className = 'edited-tag';
            editedTag.title = `Edited at ${new Date(data.editedAt).toLocaleString()}`;
            editedTag.textContent = '(edited)';
            contentEl.appendChild(editedTag);
          }
        }
      }
    });

    this.socket.on('message-deleted', (data) => {
      if (data.channelCode === this.currentChannel) {
        const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
        if (msgEl) msgEl.remove();
      }
    });

    // ── Pin / Unpin ──────────────────────────────────
    this.socket.on('message-pinned', (data) => {
      if (data.channelCode === this.currentChannel) {
        const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
        if (msgEl) {
          msgEl.classList.add('pinned');
          msgEl.dataset.pinned = '1';
          // Add pin tag to header
          const header = msgEl.querySelector('.message-header');
          if (header && !header.querySelector('.pinned-tag')) {
            header.insertAdjacentHTML('beforeend', '<span class="pinned-tag" title="Pinned message">📌</span>');
          }
          // Update toolbar: swap pin → unpin
          const pinBtn = msgEl.querySelector('[data-action="pin"]');
          if (pinBtn) { pinBtn.dataset.action = 'unpin'; pinBtn.title = 'Unpin'; }
        }
        this._appendSystemMessage(`📌 ${data.pinnedBy} pinned a message`);
      }
    });

    this.socket.on('message-unpinned', (data) => {
      if (data.channelCode === this.currentChannel) {
        const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
        if (msgEl) {
          msgEl.classList.remove('pinned');
          delete msgEl.dataset.pinned;
          const tag = msgEl.querySelector('.pinned-tag');
          if (tag) tag.remove();
          // Update toolbar: swap unpin → pin
          const unpinBtn = msgEl.querySelector('[data-action="unpin"]');
          if (unpinBtn) { unpinBtn.dataset.action = 'pin'; unpinBtn.title = 'Pin'; }
        }
        this._appendSystemMessage('📌 A message was unpinned');
      }
    });

    this.socket.on('pinned-messages', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._renderPinnedPanel(data.pins);
      }
    });

    // ── Admin moderation events ────────────────────────
    this.socket.on('kicked', (data) => {
      this._showToast(`You were kicked${data.reason ? ': ' + data.reason : ''}`, 'error');
      if (this.currentChannel === data.channelCode) {
        this.currentChannel = null;
        this._showWelcome();
      }
    });

    this.socket.on('banned', (data) => {
      this._showToast(`You have been banned${data.reason ? ': ' + data.reason : ''}`, 'error');
      setTimeout(() => {
        localStorage.removeItem('haven_token');
        localStorage.removeItem('haven_user');
        window.location.href = '/';
      }, 3000);
    });

    this.socket.on('muted', (data) => {
      this._showToast(`You have been muted for ${data.duration} min${data.reason ? ': ' + data.reason : ''}`, 'error');
    });

    this.socket.on('ban-list', (data) => {
      this._renderBanList(data);
    });

    // ── Server settings ────────────────────────────────
    this.socket.on('server-settings', (settings) => {
      this.serverSettings = settings;
      this._applyServerSettings();
    });

    this.socket.on('server-setting-changed', (data) => {
      this.serverSettings[data.key] = data.value;
      this._applyServerSettings();
    });

    // ── User preferences (persistent theme etc.) ───────
    this.socket.on('preferences', (prefs) => {
      if (prefs.theme) {
        applyThemeFromServer(prefs.theme);
      }
    });

    // ── Search results ─────────────────────────────────
    this.socket.on('search-results', (data) => {
      const panel = document.getElementById('search-results-panel');
      const list = document.getElementById('search-results-list');
      const count = document.getElementById('search-results-count');
      count.textContent = `${data.results.length} result${data.results.length !== 1 ? 's' : ''} for "${this._escapeHtml(data.query)}"`;
      list.innerHTML = data.results.length === 0
        ? '<p class="muted-text" style="padding:12px">No results found</p>'
        : data.results.map(r => `
          <div class="search-result-item" data-msg-id="${r.id}">
            <span class="search-result-author" style="color:${this._getUserColor(r.username)}">${this._escapeHtml(r.username)}</span>
            <span class="search-result-time">${this._formatTime(r.created_at)}</span>
            <div class="search-result-content">${this._highlightSearch(this._escapeHtml(r.content), data.query)}</div>
          </div>
        `).join('');
      panel.style.display = 'block';

      // Click to scroll to message
      list.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          const msgId = item.dataset.msgId;
          const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
          if (msgEl) {
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgEl.classList.add('highlight-flash');
            setTimeout(() => msgEl.classList.remove('highlight-flash'), 2000);
          }
        });
      });
    });

    // ── High Scores ──────────────────────────────────
    this.socket.on('high-scores', (data) => {
      this.highScores[data.game] = data.leaderboard;
      // Re-render online users to update score badges
      if (this._lastOnlineUsers) {
        this._renderOnlineUsers(this._lastOnlineUsers);
      }
      // Relay to game window if open
      try { if (this._gameWindow && !this._gameWindow.closed) this._gameWindow.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch {}
    });

    this.socket.on('new-high-score', (data) => {
      this._showToast(`🏆 ${data.username} set a new Shippy Container record: ${data.score}!`, 'success');
    });
  }

  // ── UI Event Bindings ─────────────────────────────────

  _setupUI() {
    const msgInput = document.getElementById('message-input');

    // Shorter placeholder on narrow screens to prevent wrapping
    if (window.innerWidth <= 480) {
      msgInput.placeholder = 'Message...';
    }

    msgInput.addEventListener('keydown', (e) => {
      // If slash dropdown is visible, hijack arrow keys and enter
      const slashDd = document.getElementById('slash-dropdown');
      if (slashDd && slashDd.style.display !== 'none') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._navigateSlashDropdown(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Tab') {
          const active = slashDd.querySelector('.slash-item.active');
          if (active) { e.preventDefault(); active.click(); return; }
        }
        if (e.key === 'Escape') { this._hideSlashDropdown(); return; }
      }

      // If mention dropdown is visible, hijack arrow keys and enter
      const dropdown = document.getElementById('mention-dropdown');
      if (dropdown && dropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._navigateMentionDropdown(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const active = dropdown.querySelector('.mention-item.active');
          if (active) {
            e.preventDefault();
            active.click();
            return;
          }
        }
        if (e.key === 'Escape') {
          this._hideMentionDropdown();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });

    msgInput.addEventListener('input', () => {
      const maxH = window.innerWidth <= 480 ? 90 : 120;
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, maxH) + 'px';

      const now = Date.now();
      if (now - this.lastTypingEmit > 2000 && this.currentChannel) {
        this.socket.emit('typing', { code: this.currentChannel });
        this.lastTypingEmit = now;
      }

      // Check for @mention trigger
      this._checkMentionTrigger();
      // Check for /command trigger
      this._checkSlashTrigger();
    });

    document.getElementById('send-btn').addEventListener('click', () => this._sendMessage());

    // Join channel
    const joinBtn = document.getElementById('join-channel-btn');
    const codeInput = document.getElementById('channel-code-input');
    joinBtn.addEventListener('click', () => {
      const code = codeInput.value.trim();
      if (code) { this.socket.emit('join-channel', { code }); codeInput.value = ''; }
    });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

    // Create channel (admin)
    const createBtn = document.getElementById('create-channel-btn');
    const nameInput = document.getElementById('new-channel-name');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (name) { this.socket.emit('create-channel', { name }); nameInput.value = ''; }
      });
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });
    }

    // Copy code
    document.getElementById('copy-code-btn').addEventListener('click', () => {
      if (this.currentChannel) {
        navigator.clipboard.writeText(this.currentChannel).then(() => {
          this._showToast('Channel code copied!', 'success');
        });
      }
    });

    // Delete channel
    document.getElementById('delete-channel-btn').addEventListener('click', () => {
      if (this.currentChannel && confirm('Delete this channel? All messages will be lost.')) {
        this.socket.emit('delete-channel', { code: this.currentChannel });
      }
    });

    // Voice buttons
    document.getElementById('voice-join-btn').addEventListener('click', () => this._joinVoice());
    document.getElementById('voice-join-mobile')?.addEventListener('click', () => {
      this._joinVoice();
      this._closeMobilePanels();
    });
    document.getElementById('voice-mute-btn').addEventListener('click', () => this._toggleMute());
    document.getElementById('voice-deafen-btn').addEventListener('click', () => this._toggleDeafen());
    document.getElementById('voice-leave-btn').addEventListener('click', () => this._leaveVoice());
    document.getElementById('screen-share-btn').addEventListener('click', () => this._toggleScreenShare());
    document.getElementById('screen-share-close').addEventListener('click', () => this._hideScreenShare());

    // Voice controls dropdown
    document.getElementById('voice-dropdown-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = document.getElementById('voice-dropdown-panel');
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });
    // Close dropdown when clicking elsewhere
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('voice-dropdown-panel');
      if (panel && panel.style.display !== 'none' && !e.target.closest('.voice-dropdown')) {
        panel.style.display = 'none';
      }
    });
    // Stream size slider
    const streamSizeSlider = document.getElementById('stream-size-slider');
    if (streamSizeSlider) {
      const savedSize = localStorage.getItem('haven_stream_size');
      if (savedSize) streamSizeSlider.value = savedSize;
      const applySize = () => {
        const vh = parseInt(streamSizeSlider.value, 10);
        const container = document.getElementById('screen-share-container');
        container.style.maxHeight = vh + 'vh';
        const grid = document.getElementById('screen-share-grid');
        grid.style.maxHeight = (vh - 2) + 'vh';
        document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
        localStorage.setItem('haven_stream_size', vh);
      };
      applySize();
      streamSizeSlider.addEventListener('input', applySize);
    }
    document.getElementById('voice-ns-slider').addEventListener('input', (e) => {
      if (this.voice && this.voice.inVoice) {
        this.voice.setNoiseSensitivity(parseInt(e.target.value, 10));
      }
    });

    // Wire up the voice manager's video callback
    this.voice.onScreenStream = (userId, stream) => this._handleScreenStream(userId, stream);

    // Wire up voice join/leave audio cues
    this.voice.onVoiceJoin = (userId, username) => {
      this.notifications.playDirect('voice_join');
    };
    this.voice.onVoiceLeave = (userId, username) => {
      this.notifications.playDirect('voice_leave');
    };

    // Wire up talking indicator
    this.voice.onTalkingChange = (userId, isTalking) => {
      const resolvedId = userId === 'self' ? this.user.id : userId;
      const el = document.querySelector(`.voice-user-item[data-user-id="${resolvedId}"]`);
      if (el) el.classList.toggle('talking', isTalking);
    };

    // Search
    let searchTimeout = null;
    document.getElementById('search-toggle-btn').addEventListener('click', () => {
      const sc = document.getElementById('search-container');
      sc.style.display = sc.style.display === 'none' ? 'flex' : 'none';
      if (sc.style.display === 'flex') document.getElementById('search-input').focus();
    });
    document.getElementById('search-close-btn').addEventListener('click', () => {
      document.getElementById('search-container').style.display = 'none';
      document.getElementById('search-results-panel').style.display = 'none';
      document.getElementById('search-input').value = '';
    });
    document.getElementById('search-results-close').addEventListener('click', () => {
      document.getElementById('search-results-panel').style.display = 'none';
    });
    document.getElementById('search-input').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const q = e.target.value.trim();
      if (q.length >= 2 && this.currentChannel) {
        searchTimeout = setTimeout(() => {
          this.socket.emit('search-messages', { code: this.currentChannel, query: q });
        }, 400);
      } else {
        document.getElementById('search-results-panel').style.display = 'none';
      }
    });
    document.getElementById('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('search-container').style.display = 'none';
        document.getElementById('search-results-panel').style.display = 'none';
      }
    });

    // Pinned messages panel
    document.getElementById('pinned-toggle-btn').addEventListener('click', () => {
      const panel = document.getElementById('pinned-panel');
      if (panel.style.display === 'block') {
        panel.style.display = 'none';
      } else if (this.currentChannel) {
        this.socket.emit('get-pinned-messages', { code: this.currentChannel });
      }
    });
    document.getElementById('pinned-close').addEventListener('click', () => {
      document.getElementById('pinned-panel').style.display = 'none';
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+F = search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && this.currentChannel) {
        e.preventDefault();
        const sc = document.getElementById('search-container');
        sc.style.display = 'flex';
        document.getElementById('search-input').focus();
      }
      // Escape = close modals, search, theme popup
      if (e.key === 'Escape') {
        document.getElementById('search-container').style.display = 'none';
        document.getElementById('search-results-panel').style.display = 'none';
        document.getElementById('theme-popup').style.display = 'none';
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      }
    });

    // Theme popup toggle
    document.getElementById('theme-popup-toggle')?.addEventListener('click', () => {
      const popup = document.getElementById('theme-popup');
      popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('theme-popup-close')?.addEventListener('click', () => {
      document.getElementById('theme-popup').style.display = 'none';
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => {
      if (this.voice && this.voice.inVoice) this.voice.leave();
      localStorage.removeItem('haven_token');
      localStorage.removeItem('haven_user');
      window.location.href = '/';
    });

    // Flappy Container game (sidebar button) — single delegated listener with origin check
    if (!this._gameScoreListenerAdded) {
      window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data && e.data.type === 'flappy-score' && typeof e.data.score === 'number') {
          this.socket.emit('submit-high-score', { game: 'flappy', score: e.data.score });
        }
        if (e.data && e.data.type === 'get-leaderboard') {
          const scores = this.highScores?.flappy || [];
          e.source?.postMessage({ type: 'leaderboard-data', leaderboard: scores }, e.origin);
        }
      });
      this._gameScoreListenerAdded = true;
    }
    document.getElementById('play-flappy-btn')?.addEventListener('click', () => {
      this._gameWindow = window.open('/games/flappy', '_blank', 'width=520,height=760');
    });

    // Image click + spoiler click delegation (CSP-safe — no inline handlers)
    document.getElementById('messages').addEventListener('click', (e) => {
      if (e.target.classList.contains('chat-image')) {
        window.open(e.target.src, '_blank');
      }
      // Spoiler reveal toggle
      if (e.target.closest('.spoiler')) {
        e.target.closest('.spoiler').classList.toggle('revealed');
      }
    });

    // Emoji picker toggle
    document.getElementById('emoji-btn').addEventListener('click', () => {
      this._toggleEmojiPicker();
    });

    // Close emoji picker when clicking outside
    document.addEventListener('click', (e) => {
      const picker = document.getElementById('emoji-picker');
      const btn = document.getElementById('emoji-btn');
      if (picker && picker.style.display !== 'none' &&
          !picker.contains(e.target) && !btn.contains(e.target)) {
        picker.style.display = 'none';
      }
    });

    // Reply close button
    document.getElementById('reply-close-btn').addEventListener('click', () => {
      this._clearReply();
    });

    // Messages container — delegate reaction and reply button clicks
    document.getElementById('messages').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const msgEl = target.closest('.message, .message-compact');
      if (!msgEl) return;

      const msgId = parseInt(msgEl.dataset.msgId);
      if (!msgId) return;

      if (action === 'react') {
        this._showReactionPicker(msgEl, msgId);
      } else if (action === 'reply') {
        this._setReply(msgEl, msgId);
      } else if (action === 'edit') {
        this._startEditMessage(msgEl, msgId);
      } else if (action === 'delete') {
        if (confirm('Delete this message?')) {
          this.socket.emit('delete-message', { messageId: msgId });
        }
      } else if (action === 'pin') {
        this.socket.emit('pin-message', { messageId: msgId });
      } else if (action === 'unpin') {
        this.socket.emit('unpin-message', { messageId: msgId });
      }
    });

    // Reaction badge click (toggle own reaction)
    document.getElementById('messages').addEventListener('click', (e) => {
      const badge = e.target.closest('.reaction-badge');
      if (!badge) return;
      const msgEl = badge.closest('.message, .message-compact');
      if (!msgEl) return;
      const msgId = parseInt(msgEl.dataset.msgId);
      const emoji = badge.dataset.emoji;
      const hasOwn = badge.classList.contains('own');
      if (hasOwn) {
        this.socket.emit('remove-reaction', { messageId: msgId, emoji });
      } else {
        this.socket.emit('add-reaction', { messageId: msgId, emoji });
      }
    });

    // Rename username
    document.getElementById('rename-btn').addEventListener('click', () => {
      document.getElementById('rename-modal').style.display = 'flex';
      const input = document.getElementById('rename-input');
      input.value = this.user.displayName || this.user.username;
      input.focus();
      input.select();
    });

    document.getElementById('cancel-rename-btn').addEventListener('click', () => {
      document.getElementById('rename-modal').style.display = 'none';
    });

    document.getElementById('save-rename-btn').addEventListener('click', () => this._saveRename());

    document.getElementById('rename-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._saveRename();
    });

    document.getElementById('rename-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // ── Admin moderation bindings ───────────────────────
    document.getElementById('cancel-admin-action-btn').addEventListener('click', () => {
      document.getElementById('admin-action-modal').style.display = 'none';
    });

    document.getElementById('admin-action-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    document.getElementById('confirm-admin-action-btn').addEventListener('click', () => {
      if (!this.adminActionTarget) return;
      const { action, userId } = this.adminActionTarget;
      const reason = document.getElementById('admin-action-reason').value.trim();
      const duration = parseInt(document.getElementById('admin-action-duration').value) || 10;

      if (action === 'kick') {
        this.socket.emit('kick-user', { userId, reason });
      } else if (action === 'ban') {
        this.socket.emit('ban-user', { userId, reason });
      } else if (action === 'mute') {
        this.socket.emit('mute-user', { userId, reason, duration });
      }

      document.getElementById('admin-action-modal').style.display = 'none';
      this.adminActionTarget = null;
    });

    // ── Settings popout modal ────────────────────────────
    document.getElementById('open-settings-btn').addEventListener('click', () => {
      document.getElementById('settings-modal').style.display = 'flex';
    });
    document.getElementById('close-settings-btn').addEventListener('click', () => {
      document.getElementById('settings-modal').style.display = 'none';
    });
    document.getElementById('settings-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // ── Password change ──────────────────────────────────
    document.getElementById('change-password-btn').addEventListener('click', async () => {
      const cur  = document.getElementById('current-password').value;
      const np   = document.getElementById('new-password').value;
      const conf = document.getElementById('confirm-password').value;
      const hint = document.getElementById('password-status');
      hint.textContent = '';
      hint.className = 'settings-hint';

      if (!cur || !np) return hint.textContent = 'Fill in all fields';
      if (np.length < 8) return hint.textContent = 'New password must be 8+ characters';
      if (np !== conf)   return hint.textContent = 'Passwords do not match';

      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`
          },
          body: JSON.stringify({ currentPassword: cur, newPassword: np })
        });
        const data = await res.json();
        if (!res.ok) {
          hint.textContent = data.error || 'Failed';
          hint.classList.add('error');
          return;
        }
        // Store the fresh token
        this.token = data.token;
        localStorage.setItem('haven_token', data.token);
        hint.textContent = '✅ Password changed!';
        hint.classList.add('success');
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
      } catch {
        hint.textContent = 'Network error';
        hint.classList.add('error');
      }
    });

    // Member visibility select (admin)
    const visSelect = document.getElementById('member-visibility-select');
    if (visSelect) {
      visSelect.addEventListener('change', () => {
        this.socket.emit('update-server-setting', {
          key: 'member_visibility',
          value: visSelect.value
        });
      });
    }

    // View bans button
    document.getElementById('view-bans-btn').addEventListener('click', () => {
      this.socket.emit('get-bans');
      document.getElementById('bans-modal').style.display = 'flex';
    });

    document.getElementById('close-bans-btn').addEventListener('click', () => {
      document.getElementById('bans-modal').style.display = 'none';
    });

    document.getElementById('bans-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // ── Cleanup controls (admin) ─────────────────────────
    const cleanupEnabled = document.getElementById('cleanup-enabled');
    if (cleanupEnabled) {
      cleanupEnabled.addEventListener('change', () => {
        this.socket.emit('update-server-setting', {
          key: 'cleanup_enabled',
          value: cleanupEnabled.checked ? 'true' : 'false'
        });
      });
    }

    const cleanupAge = document.getElementById('cleanup-max-age');
    if (cleanupAge) {
      cleanupAge.addEventListener('change', () => {
        const val = Math.max(0, Math.min(3650, parseInt(cleanupAge.value) || 0));
        cleanupAge.value = val;
        this.socket.emit('update-server-setting', {
          key: 'cleanup_max_age_days',
          value: String(val)
        });
      });
    }

    const cleanupSize = document.getElementById('cleanup-max-size');
    if (cleanupSize) {
      cleanupSize.addEventListener('change', () => {
        const val = Math.max(0, Math.min(100000, parseInt(cleanupSize.value) || 0));
        cleanupSize.value = val;
        this.socket.emit('update-server-setting', {
          key: 'cleanup_max_size_mb',
          value: String(val)
        });
      });
    }

    const runCleanupBtn = document.getElementById('run-cleanup-now-btn');
    if (runCleanupBtn) {
      runCleanupBtn.addEventListener('click', () => {
        this.socket.emit('run-cleanup-now');
        this._showToast('Cleanup triggered — check server console for results', 'success');
      });
    }

    // ── Whitelist controls (admin) ───────────────────────
    const whitelistToggle = document.getElementById('whitelist-enabled');
    if (whitelistToggle) {
      whitelistToggle.addEventListener('change', () => {
        this.socket.emit('whitelist-toggle', { enabled: whitelistToggle.checked });
        this.socket.emit('update-server-setting', {
          key: 'whitelist_enabled',
          value: whitelistToggle.checked ? 'true' : 'false'
        });
      });
    }

    document.getElementById('whitelist-add-btn').addEventListener('click', () => {
      const input = document.getElementById('whitelist-username-input');
      const username = input.value.trim();
      if (!username) return;
      this.socket.emit('whitelist-add', { username });
      input.value = '';
    });

    document.getElementById('whitelist-username-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('whitelist-add-btn').click();
    });

    // Listen for whitelist list updates
    this.socket.on('whitelist-list', (list) => {
      this._renderWhitelist(list);
    });
  }

  // ═══════════════════════════════════════════════════════
  // SERVER BAR — multi-server with live status
  // ═══════════════════════════════════════════════════════

  _setupServerBar() {
    this.serverManager.startPolling(30000);
    this._renderServerBar();
    setInterval(() => this._renderServerBar(), 30000);

    document.getElementById('home-server').addEventListener('click', () => {
      // Already home — pulse the icon for fun
      const el = document.getElementById('home-server');
      el.classList.add('bounce');
      setTimeout(() => el.classList.remove('bounce'), 400);
    });

    document.getElementById('add-server-btn').addEventListener('click', () => {
      document.getElementById('add-server-modal').style.display = 'flex';
      document.getElementById('server-name-input').value = '';
      document.getElementById('server-url-input').value = '';
      document.getElementById('server-name-input').focus();
    });

    document.getElementById('cancel-server-btn').addEventListener('click', () => {
      document.getElementById('add-server-modal').style.display = 'none';
    });

    document.getElementById('save-server-btn').addEventListener('click', () => this._addServer());

    // Enter key in modal inputs
    document.getElementById('server-url-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._addServer();
    });

    // Close modal on overlay click
    document.getElementById('add-server-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
  }

  _addServer() {
    const name = document.getElementById('server-name-input').value.trim();
    const url = document.getElementById('server-url-input').value.trim();
    if (!name || !url) return this._showToast('Name and address are both required', 'error');

    if (this.serverManager.add(name, url)) {
      document.getElementById('add-server-modal').style.display = 'none';
      this._renderServerBar();
      this._showToast(`Added "${name}"`, 'success');
    } else {
      this._showToast('Server already in your list', 'error');
    }
  }

  _renderServerBar() {
    const list = document.getElementById('server-list');
    const servers = this.serverManager.getAll();

    list.innerHTML = servers.map(s => {
      const initial = s.name.charAt(0).toUpperCase();
      const online = s.status.online;
      const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
      const statusText = online === true ? '● Online' : online === false ? '○ Offline' : '◌ Checking...';
      return `
        <div class="server-icon remote" data-url="${this._escapeHtml(s.url)}"
             title="${this._escapeHtml(s.name)} — ${statusText}">
          <span class="server-icon-text">${initial}</span>
          <span class="server-status-dot ${statusClass}"></span>
          <button class="server-remove" title="Remove">&times;</button>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.server-icon.remote').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('server-remove')) {
          e.stopPropagation();
          this.serverManager.remove(el.dataset.url);
          this._renderServerBar();
          this._showToast('Server removed', 'success');
          return;
        }
        window.open(el.dataset.url, '_blank', 'noopener');
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // IMAGE UPLOAD — button, paste, drag & drop
  // ═══════════════════════════════════════════════════════

  _setupImageUpload() {
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const messageArea = document.getElementById('message-area');

    uploadBtn.addEventListener('click', () => {
      if (!this.currentChannel) return this._showToast('Select a channel first', 'error');
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) this._uploadImage(fileInput.files[0]);
      fileInput.value = '';
    });

    // Paste image from clipboard
    document.getElementById('message-input').addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          this._uploadImage(item.getAsFile());
          return;
        }
      }
    });

    // Drag & drop
    messageArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      messageArea.classList.add('drag-over');
    });

    messageArea.addEventListener('dragleave', () => {
      messageArea.classList.remove('drag-over');
    });

    messageArea.addEventListener('drop', (e) => {
      e.preventDefault();
      messageArea.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file && file.type.startsWith('image/')) {
        this._uploadImage(file);
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  // MOBILE — hamburger, overlay, swipe gestures
  // ═══════════════════════════════════════════════════════

  _setupMobile() {
    const menuBtn = document.getElementById('mobile-menu-btn');
    const usersBtn = document.getElementById('mobile-users-btn');
    const overlay = document.getElementById('mobile-overlay');
    const appBody = document.getElementById('app-body');

    // Hamburger — toggle left sidebar
    menuBtn.addEventListener('click', () => {
      const isOpen = appBody.classList.toggle('mobile-sidebar-open');
      appBody.classList.remove('mobile-right-open');
      if (isOpen) overlay.classList.add('active');
      else overlay.classList.remove('active');
    });

    // Users button — toggle right sidebar
    usersBtn.addEventListener('click', () => {
      const isOpen = appBody.classList.toggle('mobile-right-open');
      appBody.classList.remove('mobile-sidebar-open');
      if (isOpen) overlay.classList.add('active');
      else overlay.classList.remove('active');
    });

    // Overlay click — close everything
    overlay.addEventListener('click', () => this._closeMobilePanels());

    // Close sidebar when switching channels on mobile
    const origSwitch = this.switchChannel.bind(this);
    this.switchChannel = (code) => {
      origSwitch(code);
      this._closeMobilePanels();
    };

    // Swipe gesture support (touch)
    let touchStartX = 0;
    let touchStartY = 0;
    const SWIPE_THRESHOLD = 60;

    document.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      // Only process horizontal swipes (not scrolling)
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;

      if (dx > 0 && touchStartX < 40) {
        // Swipe right from left edge → open left sidebar
        appBody.classList.add('mobile-sidebar-open');
        appBody.classList.remove('mobile-right-open');
        overlay.classList.add('active');
      } else if (dx < 0 && touchStartX > window.innerWidth - 40) {
        // Swipe left from right edge → open right sidebar
        appBody.classList.add('mobile-right-open');
        appBody.classList.remove('mobile-sidebar-open');
        overlay.classList.add('active');
      } else if (dx < 0 && appBody.classList.contains('mobile-sidebar-open')) {
        this._closeMobilePanels();
      } else if (dx > 0 && appBody.classList.contains('mobile-right-open')) {
        this._closeMobilePanels();
      }
    }, { passive: true });

    // ── Tap-to-show message toolbar on mobile ──
    const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (isTouchDevice) {
      const messagesEl = document.getElementById('messages');

      messagesEl.addEventListener('click', (e) => {
        // Don't interfere with toolbar button clicks, links, images, reactions, spoilers
        if (e.target.closest('.msg-toolbar') || e.target.closest('a') ||
            e.target.closest('img') || e.target.closest('.reaction-badge') ||
            e.target.closest('.spoiler') || e.target.closest('.reply-banner')) return;

        const msgEl = e.target.closest('.message, .message-compact');
        if (!msgEl) {
          // Tapped empty space — deselect all
          messagesEl.querySelectorAll('.msg-selected').forEach(el => el.classList.remove('msg-selected'));
          return;
        }

        const wasSelected = msgEl.classList.contains('msg-selected');
        // Deselect all
        messagesEl.querySelectorAll('.msg-selected').forEach(el => el.classList.remove('msg-selected'));
        // Toggle — if it wasn't selected, select it
        if (!wasSelected) msgEl.classList.add('msg-selected');
      });

      // Deselect when tapping input area or outside messages
      document.getElementById('message-input').addEventListener('focus', () => {
        messagesEl.querySelectorAll('.msg-selected').forEach(el => el.classList.remove('msg-selected'));
      });
    }
  }

  _closeMobilePanels() {
    const appBody = document.getElementById('app-body');
    const overlay = document.getElementById('mobile-overlay');
    appBody.classList.remove('mobile-sidebar-open', 'mobile-right-open');
    overlay.classList.remove('active');
  }

  _saveRename() {
    const input = document.getElementById('rename-input');
    const newName = input.value.trim().replace(/\s+/g, ' ');
    if (!newName || newName.length < 2) {
      return this._showToast('Display name must be at least 2 characters', 'error');
    }
    if (!/^[a-zA-Z0-9_ ]+$/.test(newName)) {
      return this._showToast('Letters, numbers, underscores, and spaces only', 'error');
    }
    this.socket.emit('rename-user', { username: newName });
    document.getElementById('rename-modal').style.display = 'none';
  }

  async _uploadImage(file) {
    if (!this.currentChannel) return;
    if (file.size > 5 * 1024 * 1024) {
      return this._showToast('Image too large (max 5 MB)', 'error');
    }

    const formData = new FormData();
    formData.append('image', file);

    try {
      this._showToast('Uploading image...', 'info');
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: formData
      });
      if (!res.ok) {
        let errMsg = `Upload failed (${res.status})`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
        return this._showToast(errMsg, 'error');
      }
      const data = await res.json();

      // Send the image URL as a message (prefix with img: to avoid slash-command parsing)
      this.socket.emit('send-message', {
        code: this.currentChannel,
        content: data.url,
        isImage: true
      });
    } catch {
      this._showToast('Upload failed — check your connection', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════════

  _setupNotifications() {
    const toggle = document.getElementById('notif-enabled');
    const volume = document.getElementById('notif-volume');
    const msgSound = document.getElementById('notif-msg-sound');
    const mentionVolume = document.getElementById('notif-mention-volume');
    const mentionSound = document.getElementById('notif-mention-sound');

    toggle.checked = this.notifications.enabled;
    volume.value = this.notifications.volume * 100;
    msgSound.value = this.notifications.sounds.message;
    mentionVolume.value = this.notifications.mentionVolume * 100;
    mentionSound.value = this.notifications.sounds.mention;

    toggle.addEventListener('change', () => {
      this.notifications.setEnabled(toggle.checked);
    });

    volume.addEventListener('input', () => {
      this.notifications.setVolume(volume.value / 100);
    });

    msgSound.addEventListener('change', () => {
      this.notifications.setSound('message', msgSound.value);
      this.notifications.play('message'); // Preview the selected sound
    });

    mentionVolume.addEventListener('input', () => {
      this.notifications.setMentionVolume(mentionVolume.value / 100);
    });

    mentionSound.addEventListener('change', () => {
      this.notifications.setSound('mention', mentionSound.value);
      this.notifications.play('mention'); // Preview the selected sound
    });
  }

  // ── Theme System ──────────────────────────────────────

  _setupThemes() {
    initThemeSwitcher('theme-selector', this.socket);
  }

  // ── Status Bar ────────────────────────────────────────

  _startStatusBar() {
    this._updateClock();
    setInterval(() => this._updateClock(), 1000);
  }

  _updateClock() {
    const now = new Date();
    const h = now.getHours().toString().padStart(2, '0');
    const m = now.getMinutes().toString().padStart(2, '0');
    const s = now.getSeconds().toString().padStart(2, '0');
    document.getElementById('status-clock').textContent = `${h}:${m}:${s}`;
  }

  _startPingMonitor() {
    if (this.pingInterval) clearInterval(this.pingInterval);

    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.connected) {
        this._pingStart = Date.now();
        this.socket.emit('ping-check');
      }
    }, 5000);

    this._pingStart = Date.now();
    this.socket.emit('ping-check');
  }

  _setLed(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'led ' + state;
  }

  // ── Channel Management ────────────────────────────────

  switchChannel(code) {
    if (this.currentChannel === code) return;

    // Voice persists across channel switches — no auto-disconnect

    this.currentChannel = code;
    const channel = this.channels.find(c => c.code === code);
    const isDm = channel && channel.is_dm;
    const displayName = isDm && channel.dm_target
      ? `@ ${channel.dm_target.username}`
      : channel ? `# ${channel.name}` : code;

    document.getElementById('channel-header-name').textContent = displayName;
    document.getElementById('channel-code-display').textContent = isDm ? '' : code;
    document.getElementById('copy-code-btn').style.display = isDm ? 'none' : 'inline-flex';
    // Update voice button state — persist controls if in voice anywhere
    if (this.voice && this.voice.inVoice) {
      this._updateVoiceButtons(true);
    } else {
      // Show just the join button (not the dropdown/leave)
      document.getElementById('voice-join-btn').style.display = 'inline-flex';
      document.getElementById('voice-dropdown-toggle').style.display = 'none';
      document.getElementById('voice-leave-btn').style.display = 'none';
      const mobileJoin = document.getElementById('voice-join-mobile');
      if (mobileJoin) mobileJoin.style.display = '';
    }
    document.getElementById('search-toggle-btn').style.display = 'inline-flex';
    document.getElementById('pinned-toggle-btn').style.display = 'inline-flex';

    // Show/hide topic bar
    this._updateTopicBar(channel?.topic || '');

    if (this.user.isAdmin && !isDm) {
      document.getElementById('delete-channel-btn').style.display = 'inline-flex';
    } else {
      document.getElementById('delete-channel-btn').style.display = 'none';
    }

    document.getElementById('messages').innerHTML = '';
    document.getElementById('message-area').style.display = 'flex';
    document.getElementById('no-channel-msg').style.display = 'none';

    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.querySelector(`.channel-item[data-code="${code}"]`);
    if (activeEl) activeEl.classList.add('active');

    this.unreadCounts[code] = 0;
    this._updateBadge(code);

    document.getElementById('status-channel').textContent = isDm && channel.dm_target
      ? `DM: ${channel.dm_target.username}` : channel ? channel.name : code;

    this.socket.emit('enter-channel', { code });
    this.socket.emit('get-messages', { code });
    this.socket.emit('get-channel-members', { code });
    this._clearReply();
  }

  _updateTopicBar(topic) {
    let bar = document.getElementById('channel-topic-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'channel-topic-bar';
      bar.className = 'channel-topic-bar';
      const header = document.querySelector('.channel-header');
      header.parentNode.insertBefore(bar, header.nextSibling);
    }
    if (topic) {
      bar.textContent = topic;
      bar.style.display = 'block';
      bar.title = this.user.isAdmin ? 'Click to edit topic' : topic;
      bar.onclick = this.user.isAdmin ? () => this._editTopic() : null;
      bar.style.cursor = this.user.isAdmin ? 'pointer' : 'default';
    } else {
      if (this.user.isAdmin) {
        bar.textContent = 'Click to set a topic...';
        bar.style.display = 'block';
        bar.style.opacity = '0.4';
        bar.style.cursor = 'pointer';
        bar.onclick = () => this._editTopic();
      } else {
        bar.style.display = 'none';
      }
    }
    if (topic) bar.style.opacity = '1';
  }

  _editTopic() {
    const channel = this.channels.find(c => c.code === this.currentChannel);
    const current = channel?.topic || '';
    const newTopic = prompt('Set channel topic (max 256 chars):', current);
    if (newTopic === null) return; // cancelled
    this.socket.emit('set-channel-topic', { code: this.currentChannel, topic: newTopic.slice(0, 256) });
  }

  _showWelcome() {
    document.getElementById('message-area').style.display = 'none';
    document.getElementById('no-channel-msg').style.display = 'flex';
    document.getElementById('channel-header-name').textContent = 'Select a channel';
    document.getElementById('channel-code-display').textContent = '';
    document.getElementById('copy-code-btn').style.display = 'none';
    document.getElementById('delete-channel-btn').style.display = 'none';
    document.getElementById('voice-join-btn').style.display = 'none';
    document.getElementById('voice-dropdown-toggle').style.display = 'none';
    document.getElementById('voice-leave-btn').style.display = 'none';
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) mobileJoin.style.display = 'none';
    document.getElementById('search-toggle-btn').style.display = 'none';
    document.getElementById('pinned-toggle-btn').style.display = 'none';
    document.getElementById('status-channel').textContent = 'None';
    document.getElementById('status-online-count').textContent = '0';
    const topicBar = document.getElementById('channel-topic-bar');
    if (topicBar) topicBar.style.display = 'none';
  }

  _renderChannels() {
    const list = document.getElementById('channel-list');
    list.innerHTML = '';

    const regularChannels = this.channels.filter(c => !c.is_dm);
    const dmChannels = this.channels.filter(c => c.is_dm);

    // Regular channels
    regularChannels.forEach(ch => {
      const el = document.createElement('div');
      el.className = 'channel-item' + (ch.code === this.currentChannel ? ' active' : '');
      el.dataset.code = ch.code;
      el.innerHTML = `
        <span class="channel-hash">#</span>
        <span class="channel-name">${this._escapeHtml(ch.name)}</span>
      `;

      const count = this.unreadCounts[ch.code] || ch.unreadCount || 0;
      if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'channel-badge';
        badge.textContent = count > 99 ? '99+' : count;
        el.appendChild(badge);
      }

      el.addEventListener('click', () => this.switchChannel(ch.code));
      list.appendChild(el);
    });

    // DM section
    if (dmChannels.length > 0) {
      const dmLabel = document.createElement('h5');
      dmLabel.className = 'section-label dm-section-label';
      dmLabel.textContent = 'Direct Messages';
      list.appendChild(dmLabel);

      dmChannels.forEach(ch => {
        const el = document.createElement('div');
        el.className = 'channel-item dm-item' + (ch.code === this.currentChannel ? ' active' : '');
        el.dataset.code = ch.code;
        const dmName = ch.dm_target ? ch.dm_target.username : 'Unknown';
        el.innerHTML = `
          <span class="channel-hash">@</span>
          <span class="channel-name">${this._escapeHtml(dmName)}</span>
        `;

        const count = this.unreadCounts[ch.code] || ch.unreadCount || 0;
        if (count > 0) {
          const badge = document.createElement('span');
          badge.className = 'channel-badge';
          badge.textContent = count > 99 ? '99+' : count;
          el.appendChild(badge);
        }

        el.addEventListener('click', () => this.switchChannel(ch.code));
        list.appendChild(el);
      });
    }

    // Render voice indicators for channels with active voice users
    this._updateChannelVoiceIndicators();
  }

  _updateBadge(code) {
    const el = document.querySelector(`.channel-item[data-code="${code}"]`);
    if (!el) return;

    let badge = el.querySelector('.channel-badge');
    const count = this.unreadCounts[code] || 0;

    if (count > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'channel-badge'; el.appendChild(badge); }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }
  }

  _updateChannelVoiceIndicators() {
    document.querySelectorAll('.channel-item').forEach(el => {
      const code = el.dataset.code;
      let indicator = el.querySelector('.channel-voice-indicator');
      const count = this.voiceCounts[code] || 0;
      if (count > 0) {
        if (!indicator) {
          indicator = document.createElement('span');
          indicator.className = 'channel-voice-indicator';
          el.appendChild(indicator);
        }
        indicator.innerHTML = `<span class="voice-icon">🔊</span>${count}`;
      } else if (indicator) {
        indicator.remove();
      }
    });
  }

  // ── Messages ──────────────────────────────────────────

  _sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content || !this.currentChannel) return;

    // Client-side slash commands (not sent to server)
    if (content.startsWith('/')) {
      const parts = content.match(/^\/(\w+)(?:\s+(.*))?$/);
      if (parts) {
        const cmd = parts[1].toLowerCase();
        const arg = (parts[2] || '').trim();
        if (cmd === 'clear') {
          document.getElementById('messages').innerHTML = '';
          input.value = '';
          input.style.height = 'auto';
          this._hideMentionDropdown();
          this._hideSlashDropdown();
          return;
        }
        if (cmd === 'nick' && arg) {
          this.socket.emit('rename-user', { username: arg });
          input.value = '';
          input.style.height = 'auto';
          this._hideMentionDropdown();
          this._hideSlashDropdown();
          return;
        }
      }
    }

    const payload = { code: this.currentChannel, content };
    if (this.replyingTo) {
      payload.replyTo = this.replyingTo.id;
    }

    this.socket.emit('send-message', payload);
    input.value = '';
    input.style.height = 'auto';
    input.focus();
    this._clearReply();
    this._hideMentionDropdown();
    this._hideSlashDropdown();
  }

  _renderMessages(messages) {
    const container = document.getElementById('messages');
    container.innerHTML = '';
    messages.forEach((msg, i) => {
      const prevMsg = i > 0 ? messages[i - 1] : null;
      container.appendChild(this._createMessageEl(msg, prevMsg));
    });
    this._scrollToBottom(true);
    // Re-scroll after any images finish loading
    container.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => this._scrollToBottom(true), { once: true });
    });
    // Fetch link previews for all messages
    this._fetchLinkPreviews(container);
    // Mark as read (last message ID)
    if (messages.length > 0) {
      this._markRead(messages[messages.length - 1].id);
    }
  }

  _appendMessage(message) {
    const container = document.getElementById('messages');
    const lastMsg = container.lastElementChild;

    let prevMsg = null;
    // Only use last element for grouping if it's an actual message (not a system message)
    if (lastMsg && lastMsg.dataset && lastMsg.dataset.userId && lastMsg.dataset.msgId) {
      prevMsg = {
        user_id: parseInt(lastMsg.dataset.userId),
        created_at: lastMsg.dataset.time
      };
    }

    const wasAtBottom = this._isScrolledToBottom();
    const msgEl = this._createMessageEl(message, prevMsg);
    container.appendChild(msgEl);
    // Fetch link previews for this message
    this._fetchLinkPreviews(msgEl);
    if (wasAtBottom) {
      this._scrollToBottom(true);
      // Also scroll after images load (they shift content down)
      const imgs = container.lastElementChild?.querySelectorAll('img');
      if (imgs) imgs.forEach(img => {
        if (!img.complete) img.addEventListener('load', () => this._scrollToBottom(), { once: true });
      });
    }
  }

  _createMessageEl(msg, prevMsg) {
    const isImage = this._isImageUrl(msg.content);
    const isCompact = !isImage && prevMsg &&
      prevMsg.user_id === msg.user_id &&
      !msg.reply_to &&
      (new Date(msg.created_at) - new Date(prevMsg.created_at)) < 5 * 60 * 1000;

    const reactionsHtml = this._renderReactions(msg.id, msg.reactions || []);
    const editedHtml = msg.edited_at ? `<span class="edited-tag" title="Edited at ${new Date(msg.edited_at).toLocaleString()}">(edited)</span>` : '';
    const pinnedTag = msg.pinned ? '<span class="pinned-tag" title="Pinned message">📌</span>' : '';

    // Build toolbar with context-aware buttons
    let toolbarBtns = `<button data-action="react" title="React">😀</button><button data-action="reply" title="Reply">↩️</button>`;
    if (this.user.isAdmin) {
      toolbarBtns += msg.pinned
        ? `<button data-action="unpin" title="Unpin">📌</button>`
        : `<button data-action="pin" title="Pin">📌</button>`;
    }
    if (msg.user_id === this.user.id) {
      toolbarBtns += `<button data-action="edit" title="Edit">✏️</button>`;
    }
    if (msg.user_id === this.user.id || this.user.isAdmin) {
      toolbarBtns += `<button data-action="delete" title="Delete">🗑️</button>`;
    }
    const toolbarHtml = `<div class="msg-toolbar">${toolbarBtns}</div>`;
    const replyHtml = msg.replyContext ? this._renderReplyBanner(msg.replyContext) : '';

    if (isCompact) {
      const el = document.createElement('div');
      el.className = 'message-compact' + (msg.pinned ? ' pinned' : '');
      el.dataset.userId = msg.user_id;
      el.dataset.username = msg.username;
      el.dataset.time = msg.created_at;
      el.dataset.msgId = msg.id;
      if (msg.pinned) el.dataset.pinned = '1';
      el.innerHTML = `
        <span class="compact-time">${new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
        <div class="message-content">${pinnedTag}${this._formatContent(msg.content)}${editedHtml}</div>
        ${toolbarHtml}
        ${reactionsHtml}
      `;
      return el;
    }

    const color = this._getUserColor(msg.username);
    const initial = msg.username.charAt(0).toUpperCase();

    const el = document.createElement('div');
    el.className = 'message' + (isImage ? ' message-has-image' : '') + (msg.pinned ? ' pinned' : '');
    el.dataset.userId = msg.user_id;
    el.dataset.time = msg.created_at;
    el.dataset.msgId = msg.id;
    if (msg.pinned) el.dataset.pinned = '1';
    el.innerHTML = `
      ${replyHtml}
      <div class="message-row">
        <div class="message-avatar" style="background-color:${color}">${initial}</div>
        <div class="message-body">
          <div class="message-header">
            <span class="message-author" style="color:${color}">${this._escapeHtml(msg.username)}</span>
            <span class="message-time">${this._formatTime(msg.created_at)}</span>
            ${pinnedTag}
          </div>
          <div class="message-content">${this._formatContent(msg.content)}${editedHtml}</div>
          ${reactionsHtml}
        </div>
        ${toolbarHtml}
      </div>
    `;
    return el;
  }

  _appendSystemMessage(text) {
    const container = document.getElementById('messages');
    const wasAtBottom = this._isScrolledToBottom();
    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = text;
    container.appendChild(el);
    if (wasAtBottom) this._scrollToBottom();
  }

  // ── Pinned Messages Panel ─────────────────────────────

  _renderPinnedPanel(pins) {
    const panel = document.getElementById('pinned-panel');
    const list = document.getElementById('pinned-list');
    const count = document.getElementById('pinned-count');

    count.textContent = `📌 ${pins.length} pinned message${pins.length !== 1 ? 's' : ''}`;

    if (pins.length === 0) {
      list.innerHTML = '<p class="muted-text" style="padding:12px">No pinned messages</p>';
    } else {
      list.innerHTML = pins.map(p => `
        <div class="pinned-item" data-msg-id="${p.id}">
          <div class="pinned-item-header">
            <span class="pinned-item-author" style="color:${this._getUserColor(p.username)}">${this._escapeHtml(p.username)}</span>
            <span class="pinned-item-time">${this._formatTime(p.created_at)}</span>
          </div>
          <div class="pinned-item-content">${this._formatContent(p.content)}</div>
          <div class="pinned-item-footer">Pinned by ${this._escapeHtml(p.pinned_by)}</div>
        </div>
      `).join('');
    }
    panel.style.display = 'block';

    // Click to scroll to pinned message
    list.querySelectorAll('.pinned-item').forEach(item => {
      item.addEventListener('click', () => {
        const msgId = item.dataset.msgId;
        const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgEl) {
          msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          msgEl.classList.add('highlight-flash');
          setTimeout(() => msgEl.classList.remove('highlight-flash'), 2000);
        }
        panel.style.display = 'none';
      });
    });
  }

  // ── Link Previews ─────────────────────────────────────

  _fetchLinkPreviews(containerEl) {
    const links = containerEl.querySelectorAll('.message-content a[href]');
    const seen = new Set();
    links.forEach(link => {
      const url = link.href;
      if (seen.has(url)) return;
      seen.add(url);
      // Skip image URLs (already rendered inline) and internal URLs
      if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) return;
      if (/^https:\/\/media\d*\.giphy\.com\//i.test(url)) return;
      if (url.startsWith(window.location.origin)) return;

      fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      })
        .then(r => r.json())
        .then(data => {
          if (!data.title && !data.description) return;
          const msgContent = link.closest('.message-content');
          if (!msgContent) return;

          // Don't add duplicate previews
          if (msgContent.querySelector(`.link-preview[data-url="${CSS.escape(url)}"]`)) return;

          const card = document.createElement('a');
          card.className = 'link-preview';
          card.href = url;
          card.target = '_blank';
          card.rel = 'noopener noreferrer nofollow';
          card.dataset.url = url;

          let inner = '';
          if (data.image) {
            inner += `<img class="link-preview-image" src="${this._escapeHtml(data.image)}" alt="" loading="lazy">`;
          }
          inner += '<div class="link-preview-text">';
          if (data.siteName) inner += `<span class="link-preview-site">${this._escapeHtml(data.siteName)}</span>`;
          if (data.title) inner += `<span class="link-preview-title">${this._escapeHtml(data.title)}</span>`;
          if (data.description) inner += `<span class="link-preview-desc">${this._escapeHtml(data.description).slice(0, 200)}</span>`;
          inner += '</div>';
          card.innerHTML = inner;

          msgContent.appendChild(card);

          // Scroll if at bottom
          if (this._isScrolledToBottom()) this._scrollToBottom();
        })
        .catch(() => {});
    });
  }

  // ── Users ─────────────────────────────────────────────

  _renderOnlineUsers(users) {
    this._lastOnlineUsers = users;
    const el = document.getElementById('online-users');
    if (users.length === 0) {
      el.innerHTML = '<p class="muted-text">No one here</p>';
      return;
    }

    // Build a score lookup from high scores data
    const scoreLookup = {};
    if (this.highScores.flappy) {
      this.highScores.flappy.forEach(s => { scoreLookup[s.user_id] = s.score; });
    }
    // Also use highScore from server-sent user data
    users.forEach(u => {
      if (u.highScore && u.highScore > (scoreLookup[u.id] || 0)) {
        scoreLookup[u.id] = u.highScore;
      }
    });

    // Sort: online first, then alphabetical
    const sorted = [...users].sort((a, b) => {
      const aOn = a.online !== false;
      const bOn = b.online !== false;
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
    });

    // Separate into online/offline groups
    const onlineUsers = sorted.filter(u => u.online !== false);
    const offlineUsers = sorted.filter(u => u.online === false);

    let html = '';
    if (onlineUsers.length > 0) {
      html += `<div class="user-group-label">Online — ${onlineUsers.length}</div>`;
      html += onlineUsers.map(u => this._renderUserItem(u, scoreLookup)).join('');
    }
    if (offlineUsers.length > 0) {
      html += `<div class="user-group-label offline-label">Offline — ${offlineUsers.length}</div>`;
      html += offlineUsers.map(u => this._renderUserItem(u, scoreLookup)).join('');
    }
    if (!onlineUsers.length && !offlineUsers.length) {
      html = '<p class="muted-text">No one here</p>';
    }

    el.innerHTML = html;

    // Bind admin action buttons
    if (this.user.isAdmin) {
      el.querySelectorAll('.user-action-btn[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const userId = parseInt(btn.dataset.uid);
          const username = btn.dataset.uname;
          this._showAdminActionModal(action, userId, username);
        });
      });
    }

    // Bind DM buttons
    el.querySelectorAll('.user-dm-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = parseInt(btn.dataset.dmUid);
        if (isNaN(targetId)) return;
        const targetName = btn.closest('.user-item')?.querySelector('.user-item-name')?.textContent || 'user';
        this._showToast(`Opening DM with ${targetName}…`, 'info');
        btn.disabled = true;
        btn.style.opacity = '0.5';
        this.socket.emit('start-dm', { targetUserId: targetId });
        // Re-enable after a timeout in case no response
        setTimeout(() => { btn.disabled = false; btn.style.opacity = ''; }, 5000);
      });
    });
  }

  _renderUserItem(u, scoreLookup) {
    const onlineClass = u.online === false ? ' offline' : '';
    const score = scoreLookup[u.id] || 0;
    const scoreBadge = score > 0
      ? `<span class="user-score-badge" title="Flappy Container: ${score}">🚢${score}</span>`
      : '';

    // Status dot color
    const statusClass = u.status === 'dnd' ? 'dnd' : u.status === 'away' ? 'away'
      : u.status === 'invisible' ? 'invisible' : (u.online === false ? 'away' : '');

    const statusTextHtml = u.statusText
      ? `<span class="user-status-text" title="${this._escapeHtml(u.statusText)}">${this._escapeHtml(u.statusText)}</span>`
      : '';

    const dmBtn = u.id !== this.user.id
      ? `<button class="user-action-btn user-dm-btn" data-dm-uid="${u.id}" title="Direct Message">💬</button>`
      : '';

    const adminBtns = this.user.isAdmin && u.id !== this.user.id
      ? `<div class="user-admin-actions">
           ${dmBtn}
           <button class="user-action-btn" data-action="kick" data-uid="${u.id}" data-uname="${this._escapeHtml(u.username)}" title="Kick">👢</button>
           <button class="user-action-btn" data-action="mute" data-uid="${u.id}" data-uname="${this._escapeHtml(u.username)}" title="Mute">🔇</button>
           <button class="user-action-btn" data-action="ban" data-uid="${u.id}" data-uname="${this._escapeHtml(u.username)}" title="Ban">⛔</button>
         </div>`
      : (dmBtn ? `<div class="user-admin-actions">${dmBtn}</div>` : '');
    return `
      <div class="user-item${onlineClass}">
        <span class="user-dot${statusClass ? ' ' + statusClass : ''}"></span>
        <span class="user-item-name">${this._escapeHtml(u.username)}</span>
        ${statusTextHtml}
        ${scoreBadge}
        ${adminBtns}
      </div>
    `;
  }

  _renderVoiceUsers(users) {
    const el = document.getElementById('voice-users');
    if (users.length === 0) {
      el.innerHTML = '<p class="muted-text">No one in voice</p>';
      return;
    }
    el.innerHTML = users.map(u => {
      const savedVol = this._getVoiceVolume(u.id);
      const isSelf = u.id === this.user.id;
      const talking = this.voice && ((isSelf && this.voice.talkingState.get('self')) || this.voice.talkingState.get(u.id));
      return `
        <div class="user-item voice-user-item${talking ? ' talking' : ''}" data-user-id="${u.id}">
          <span class="user-dot voice"></span>
          <span class="user-item-name">${this._escapeHtml(u.username)}</span>
          ${!isSelf ? `<input type="range" class="volume-slider" min="0" max="200" value="${savedVol}" data-user-id="${u.id}" title="Volume: ${savedVol}%">` : '<span class="you-tag">you</span>'}
        </div>
      `;
    }).join('');

    // Bind volume sliders
    el.querySelectorAll('.volume-slider').forEach(slider => {
      slider.addEventListener('input', () => {
        const userId = parseInt(slider.dataset.userId);
        const vol = parseInt(slider.value);
        slider.title = `Volume: ${vol}%`;
        this._setVoiceVolume(userId, vol);
        if (this.voice) this.voice.setVolume(userId, vol / 100);
      });
    });
  }

  _getVoiceVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem('haven_voice_volumes') || '{}');
      return vols[userId] ?? 100;
    } catch { return 100; }
  }

  _setVoiceVolume(userId, vol) {
    try {
      const vols = JSON.parse(localStorage.getItem('haven_voice_volumes') || '{}');
      vols[userId] = vol;
      localStorage.setItem('haven_voice_volumes', JSON.stringify(vols));
    } catch { /* ignore */ }
  }

  _showTyping(username) {
    const el = document.getElementById('typing-indicator');
    el.textContent = `${username} is typing...`;
    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => { el.textContent = ''; }, 3000);
  }

  // ── Voice ─────────────────────────────────────────────

  async _joinVoice() {
    if (!this.currentChannel) return;
    // voice.join() auto-leaves old channel if connected
    const success = await this.voice.join(this.currentChannel);
    if (success) {
      this._updateVoiceButtons(true);
      this._updateVoiceStatus(true);
      this._updateVoiceBar();
      this._showToast('Joined voice chat', 'success');
    } else {
      this._showToast('Could not access microphone. Check permissions or use HTTPS.', 'error');
    }
  }

  _leaveVoice() {
    this.voice.leave();
    this.notifications.playDirect('voice_leave');
    this._updateVoiceButtons(false);
    this._updateVoiceStatus(false);
    this._updateVoiceBar();
    this._showToast('Left voice chat', 'info');
  }

  _toggleMute() {
    const muted = this.voice.toggleMute();
    const btn = document.getElementById('voice-mute-btn');
    btn.textContent = muted ? '🔊 Unmute' : '🔇 Mute';
    btn.classList.toggle('muted', muted);

    // Audible cue
    this.notifications.playDirect(muted ? 'mute_on' : 'mute_off');

    if (muted) {
      this._setLed('status-voice-led', 'warn');
      document.getElementById('status-voice-text').textContent = 'Muted';
    } else if (!this.voice.isDeafened) {
      this._setLed('status-voice-led', 'on');
      document.getElementById('status-voice-text').textContent = 'Active';
    }
  }

  _toggleDeafen() {
    const deafened = this.voice.toggleDeafen();
    const btn = document.getElementById('voice-deafen-btn');
    btn.textContent = deafened ? '🔈 Undeafen' : '🔇 Deafen';
    btn.classList.toggle('muted', deafened);

    // Audible cue
    this.notifications.playDirect(deafened ? 'deafen_on' : 'deafen_off');

    if (deafened) {
      this._setLed('status-voice-led', 'danger');
      document.getElementById('status-voice-text').textContent = 'Deafened';
    } else if (this.voice.isMuted) {
      this._setLed('status-voice-led', 'warn');
      document.getElementById('status-voice-text').textContent = 'Muted';
    } else {
      this._setLed('status-voice-led', 'on');
      document.getElementById('status-voice-text').textContent = 'Active';
    }
  }

  _updateVoiceButtons(inVoice) {
    document.getElementById('voice-join-btn').style.display = inVoice ? 'none' : 'inline-flex';
    document.getElementById('voice-dropdown-toggle').style.display = inVoice ? 'inline-flex' : 'none';
    document.getElementById('voice-leave-btn').style.display = inVoice ? 'inline-flex' : 'none';

    // Mobile voice join in right sidebar
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) mobileJoin.style.display = inVoice ? 'none' : '';

    if (!inVoice) {
      document.getElementById('voice-dropdown-panel').style.display = 'none';
      document.getElementById('voice-mute-btn').textContent = '🔇 Mute';
      document.getElementById('voice-mute-btn').classList.remove('muted');
      document.getElementById('voice-deafen-btn').textContent = '🔇 Deafen';
      document.getElementById('voice-deafen-btn').classList.remove('muted');
      document.getElementById('screen-share-btn').textContent = '🖥️ Share';
      document.getElementById('screen-share-btn').classList.remove('sharing');
      document.getElementById('voice-ns-slider').value = 10;
      // Clear all stream tiles so no ghost tiles persist after leaving voice
      const grid = document.getElementById('screen-share-grid');
      grid.querySelectorAll('video').forEach(v => { v.srcObject = null; });
      grid.innerHTML = '';
      document.getElementById('screen-share-container').style.display = 'none';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
    }
  }

  _updateVoiceStatus(inVoice) {
    if (inVoice) {
      this._setLed('status-voice-led', 'on');
      document.getElementById('status-voice-text').textContent = 'Active';
    } else {
      this._setLed('status-voice-led', 'off');
      document.getElementById('status-voice-text').textContent = 'Off';
    }
  }

  _updateVoiceBar() {
    const bar = document.getElementById('voice-bar');
    if (!bar) return;
    if (this.voice && this.voice.inVoice && this.voice.currentChannel) {
      const ch = this.channels.find(c => c.code === this.voice.currentChannel);
      const name = ch ? (ch.is_dm && ch.dm_target ? `@ ${ch.dm_target.username}` : `# ${ch.name}`) : this.voice.currentChannel;
      bar.innerHTML = `<span class="voice-bar-icon">🔊</span><span class="voice-bar-channel">${name}</span><button class="voice-bar-leave" id="voice-bar-leave-btn" title="Disconnect">✕</button>`;
      bar.style.display = 'flex';
      document.getElementById('voice-bar-leave-btn').addEventListener('click', () => this._leaveVoice());
    } else {
      bar.innerHTML = '';
      bar.style.display = 'none';
    }
  }

  // NS slider is handled directly via the input event listener in _setupUI

  // ── Screen Share ──────────────────────────────────────

  async _toggleScreenShare() {
    if (!this.voice.inVoice) return;

    if (this.voice.isScreenSharing) {
      this.voice.stopScreenShare();
      document.getElementById('screen-share-btn').textContent = '🖥️ Share';
      document.getElementById('screen-share-btn').classList.remove('sharing');
      this._showToast('Stopped screen sharing', 'info');
    } else {
      const ok = await this.voice.shareScreen();
      if (ok) {
        document.getElementById('screen-share-btn').textContent = '🛑 Stop';
        document.getElementById('screen-share-btn').classList.add('sharing');
        this._showToast('Screen sharing started', 'success');
        // Show our own screen in the viewer via the multi-stream handler
        this._handleScreenStream(this.user.id, this.voice.screenStream);
      } else {
        this._showToast('Screen share cancelled or not supported', 'error');
      }
    }
  }

  _handleScreenStream(userId, stream) {
    const container = document.getElementById('screen-share-container');
    const grid = document.getElementById('screen-share-grid');
    const label = document.getElementById('screen-share-label');

    if (stream) {
      // Create a tile for this user's stream
      const tileId = `screen-tile-${userId || 'self'}`;
      let tile = document.getElementById(tileId);
      if (!tile) {
        tile = document.createElement('div');
        tile.id = tileId;
        tile.className = 'screen-share-tile';

        const vid = document.createElement('video');
        vid.autoplay = true;
        vid.playsInline = true;
        vid.muted = true; // Always mute — screen audio routes through WebRTC audio track
        tile.appendChild(vid);

        const lbl = document.createElement('div');
        lbl.className = 'screen-share-tile-label';
        const peer = this.voice.peers.get(userId);
        const who = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Someone');
        lbl.textContent = who;
        tile.appendChild(lbl);

        grid.appendChild(tile);
      }
      const videoEl = tile.querySelector('video');
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {}); // ensure autoplay isn't blocked
      // Auto-show container (even if minimized) when new stream arrives
      container.style.display = 'flex';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
      const count = grid.children.length;
      label.textContent = `🖥️ ${count} stream${count > 1 ? 's' : ''}`;
    } else {
      // Stream ended — remove this tile
      const tileId = `screen-tile-${userId || 'self'}`;
      const tile = document.getElementById(tileId);
      if (tile) {
        const vid = tile.querySelector('video');
        if (vid) vid.srcObject = null;
        tile.remove();
      }
      this._updateScreenShareVisibility();
    }
  }

  _updateScreenShareVisibility() {
    const container = document.getElementById('screen-share-container');
    const grid = document.getElementById('screen-share-grid');
    const label = document.getElementById('screen-share-label');
    const count = grid.children.length;
    if (count === 0) {
      container.style.display = 'none';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
    } else if (this._screenShareMinimized) {
      this._showScreenShareIndicator(count);
    } else {
      label.textContent = `🖥️ ${count} stream${count > 1 ? 's' : ''}`;
    }
  }

  _hideScreenShare() {
    const container = document.getElementById('screen-share-container');
    const grid = document.getElementById('screen-share-grid');
    // Just minimize — don't destroy streams or stop sharing
    container.style.display = 'none';
    this._screenShareMinimized = true;
    // Show a "streams hidden" indicator if there are still tiles
    if (grid.children.length > 0) {
      this._showScreenShareIndicator(grid.children.length);
    }
  }

  _showScreenShareIndicator(count) {
    let ind = document.getElementById('screen-share-indicator');
    if (!ind) {
      ind = document.createElement('button');
      ind.id = 'screen-share-indicator';
      ind.className = 'screen-share-indicator';
      ind.addEventListener('click', () => {
        const container = document.getElementById('screen-share-container');
        container.style.display = 'flex';
        this._screenShareMinimized = false;
        ind.remove();
      });
      document.querySelector('.channel-header')?.appendChild(ind);
    }
    ind.textContent = `🖥️ ${count} stream${count > 1 ? 's' : ''} hidden`;
  }

  _removeScreenShareIndicator() {
    document.getElementById('screen-share-indicator')?.remove();
  }

  // ── Utilities ─────────────────────────────────────────

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  _isImageUrl(str) {
    if (!str) return false;
    const trimmed = str.trim();
    if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(trimmed)) return true;
    if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i.test(trimmed)) return true;
    // GIPHY GIF URLs (may not have file extensions)
    if (/^https:\/\/media\d*\.giphy\.com\/.+/i.test(trimmed)) return true;
    return false;
  }

  _highlightSearch(escapedHtml, query) {
    if (!query) return escapedHtml;
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escapedHtml.replace(new RegExp(`(${safeQuery})`, 'gi'), '<mark>$1</mark>');
  }

  _formatContent(str) {
    // Render file attachments [file:name](url|size)
    const fileMatch = str.match(/^\[file:(.+?)\]\((.+?)\|(.+?)\)$/);
    if (fileMatch) {
      const fileName = this._escapeHtml(fileMatch[1]);
      const fileUrl = this._escapeHtml(fileMatch[2]);
      const fileSize = this._escapeHtml(fileMatch[3]);
      const ext = fileName.split('.').pop().toLowerCase();
      const icon = { pdf: '📄', zip: '📦', '7z': '📦', rar: '📦',
        mp3: '🎵', ogg: '🎵', wav: '🎵', mp4: '🎬', webm: '🎬',
        doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📊', pptx: '📊',
        txt: '📄', csv: '📄', json: '📄', md: '📄' }[ext] || '📎';
      // Audio/video get inline players
      if (['mp3', 'ogg', 'wav', 'webm'].includes(ext) && /^audio\//.test('audio/')) {
        return `<div class="file-attachment">
          <div class="file-info">${icon} <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
          <audio controls preload="none" src="${fileUrl}"></audio>
        </div>`;
      }
      if (['mp4', 'webm'].includes(ext)) {
        return `<div class="file-attachment">
          <div class="file-info">${icon} <span class="file-name">${fileName}</span> <span class="file-size">(${fileSize})</span></div>
          <video controls preload="none" src="${fileUrl}" class="file-video"></video>
        </div>`;
      }
      return `<div class="file-attachment">
        <a href="${fileUrl}" target="_blank" rel="noopener noreferrer" class="file-download-link" download="${fileName}">
          <span class="file-icon">${icon}</span>
          <span class="file-name">${fileName}</span>
          <span class="file-size">(${fileSize})</span>
          <span class="file-download-arrow">⬇</span>
        </a>
      </div>`;
    }

    // Render server-hosted images inline (early return)
    if (/^\/uploads\/[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(str.trim())) {
      return `<img src="${this._escapeHtml(str.trim())}" class="chat-image" alt="image" loading="lazy">`;
    }

    // ── Extract fenced code blocks before escaping ──
    const codeBlocks = [];
    const withPlaceholders = str.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', code });
      return `\x00CODEBLOCK_${idx}\x00`;
    });

    let html = this._escapeHtml(withPlaceholders);

    // Auto-link URLs (and render image URLs as inline images)
    html = html.replace(
      /\bhttps?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/g,
      (url) => {
        try { new URL(url); } catch { return url; }
        const safeUrl = url.replace(/['"<>]/g, '');
        if (/\.(jpg|jpeg|png|gif|webp)(\?[^"'<>]*)?$/i.test(safeUrl) ||
            /^https:\/\/media\d*\.giphy\.com\//i.test(safeUrl)) {
          return `<img src="${safeUrl}" class="chat-image" alt="image" loading="lazy">`;
        }
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${safeUrl}</a>`;
      }
    );

    // Render @mentions with highlight
    html = html.replace(/@(\w{1,30})/g, (match, username) => {
      const isSelf = username.toLowerCase() === this.user.username.toLowerCase();
      return `<span class="mention${isSelf ? ' mention-self' : ''}">${match}</span>`;
    });

    // Render spoilers (||text||) — CSP-safe, uses delegated click handler
    html = html.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');

    // Render /me action text (italic)
    if (html.startsWith('_') && html.endsWith('_') && html.length > 2) {
      html = `<em class="action-text">${html.slice(1, -1)}</em>`;
    }

    // Render **bold**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Render *italic*
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    // Render ~~strikethrough~~
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Render `inline code`
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Render > blockquotes (lines starting with >)
    html = html.replace(/(?:^|\n)&gt;\s?(.+)/g, (_, text) => {
      return `\n<blockquote class="chat-blockquote">${text}</blockquote>`;
    });

    html = html.replace(/\n/g, '<br>');

    // ── Restore fenced code blocks ──
    codeBlocks.forEach((block, idx) => {
      const escaped = this._escapeHtml(block.code).replace(/\n$/, '');
      const langAttr = block.lang ? ` data-lang="${this._escapeHtml(block.lang)}"` : '';
      const langLabel = block.lang ? `<span class="code-block-lang">${this._escapeHtml(block.lang)}</span>` : '';
      const rendered = `<div class="code-block"${langAttr}>${langLabel}<pre><code>${escaped}</code></pre></div>`;
      html = html.replace(`\x00CODEBLOCK_${idx}\x00`, rendered);
    });

    return html;
  }

  _formatTime(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    if (isToday) return `Today at ${time}`;
    if (isYesterday) return `Yesterday at ${time}`;
    return `${date.toLocaleDateString()} ${time}`;
  }

  _getUserColor(username) {
    const colors = [
      '#e94560', '#7c5cfc', '#43b581', '#faa61a',
      '#f47fff', '#00b8d4', '#ff6b6b', '#a8e6cf',
      '#82aaff', '#c792ea', '#ffcb6b', '#89ddff'
    ];
    let hash = 0;
    for (const ch of username) {
      hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  _isScrolledToBottom() {
    const el = document.getElementById('messages');
    return el.scrollHeight - el.clientHeight - el.scrollTop < 150;
  }

  _scrollToBottom(force) {
    const el = document.getElementById('messages');
    if (force || this._isScrolledToBottom()) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }

  _showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ═══════════════════════════════════════════════════════
  // EMOJI PICKER (categorized + searchable)
  // ═══════════════════════════════════════════════════════

  _toggleEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    if (picker.style.display === 'flex') {
      picker.style.display = 'none';
      return;
    }
    picker.innerHTML = '';
    this._emojiActiveCategory = this._emojiActiveCategory || Object.keys(this.emojiCategories)[0];

    // Search bar
    const searchRow = document.createElement('div');
    searchRow.className = 'emoji-search-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'emoji-search-input';
    searchInput.placeholder = 'Search emoji\u2026';
    searchInput.maxLength = 30;
    searchRow.appendChild(searchInput);
    picker.appendChild(searchRow);

    // Category tabs
    const tabRow = document.createElement('div');
    tabRow.className = 'emoji-tab-row';
    const catIcons = { 'Smileys':'😀', 'People':'👋', 'Animals':'🐶', 'Food':'🍕', 'Activities':'🎮', 'Travel':'🚀', 'Objects':'💡', 'Symbols':'❤️' };
    for (const cat of Object.keys(this.emojiCategories)) {
      const tab = document.createElement('button');
      tab.className = 'emoji-tab' + (cat === this._emojiActiveCategory ? ' active' : '');
      tab.textContent = catIcons[cat] || cat.charAt(0);
      tab.title = cat;
      tab.addEventListener('click', () => {
        this._emojiActiveCategory = cat;
        searchInput.value = '';
        renderGrid();
        tabRow.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      });
      tabRow.appendChild(tab);
    }
    picker.appendChild(tabRow);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    picker.appendChild(grid);

    const self = this;
    function renderGrid(filter) {
      grid.innerHTML = '';
      let emojis;
      if (filter) {
        // Simple search: match emoji by checking if any category name contains the query,
        // or just show all matches from every category
        emojis = self.emojis.filter(() => true); // show all, we filter visually below
        // Actually let's just filter all emojis - since we can't search by name,
        // show emojis from categories whose name matches the query
        emojis = [];
        for (const [cat, list] of Object.entries(self.emojiCategories)) {
          if (cat.toLowerCase().includes(filter.toLowerCase())) {
            emojis.push(...list);
          }
        }
        // If no category matched, show all (user might be looking visually)
        if (emojis.length === 0) emojis = self.emojis;
      } else {
        emojis = self.emojiCategories[self._emojiActiveCategory] || self.emojis;
      }
      emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'emoji-item';
        btn.textContent = emoji;
        btn.addEventListener('click', () => {
          const input = document.getElementById('message-input');
          const start = input.selectionStart;
          const end = input.selectionEnd;
          input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
          input.selectionStart = input.selectionEnd = start + emoji.length;
          input.focus();
          picker.style.display = 'none';
        });
        grid.appendChild(btn);
      });
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      renderGrid(q || null);
    });

    renderGrid();
    picker.style.display = 'flex';
    searchInput.focus();
  }

  // ═══════════════════════════════════════════════════════
  // GIF PICKER (GIPHY)
  // ═══════════════════════════════════════════════════════

  _setupGifPicker() {
    const btn = document.getElementById('gif-btn');
    const picker = document.getElementById('gif-picker');
    const searchInput = document.getElementById('gif-search-input');
    const grid = document.getElementById('gif-grid');
    if (!btn || !picker) return;

    this._gifDebounce = null;

    btn.addEventListener('click', () => {
      if (picker.style.display === 'flex') {
        picker.style.display = 'none';
        return;
      }
      // Close emoji picker if open
      document.getElementById('emoji-picker').style.display = 'none';
      picker.style.display = 'flex';
      searchInput.value = '';
      searchInput.focus();
      this._loadTrendingGifs();
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (picker.style.display !== 'none' &&
          !picker.contains(e.target) && !btn.contains(e.target)) {
        picker.style.display = 'none';
      }
    });

    // Search on typing with debounce
    searchInput.addEventListener('input', () => {
      clearTimeout(this._gifDebounce);
      const q = searchInput.value.trim();
      if (!q) {
        this._loadTrendingGifs();
        return;
      }
      this._gifDebounce = setTimeout(() => this._searchGifs(q), 350);
    });

    // Click on a GIF to send it
    grid.addEventListener('click', (e) => {
      const img = e.target.closest('img');
      if (!img || !img.dataset.full) return;
      this._sendGifMessage(img.dataset.full);
      picker.style.display = 'none';
    });
  }

  _loadTrendingGifs() {
    const grid = document.getElementById('gif-grid');
    grid.innerHTML = '<div class="gif-picker-empty">Loading...</div>';
    fetch('/api/gif/trending?limit=20', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.error === 'gif_not_configured') {
          this._showGifSetupGuide(grid);
          return;
        }
        if (data.error) {
          grid.innerHTML = `<div class="gif-picker-empty">${data.error}</div>`;
          return;
        }
        this._renderGifGrid(data.results || []);
      })
      .catch(() => {
        grid.innerHTML = '<div class="gif-picker-empty">Failed to load GIFs</div>';
      });
  }

  _searchGifs(query) {
    const grid = document.getElementById('gif-grid');
    grid.innerHTML = '<div class="gif-picker-empty">Searching...</div>';
    fetch(`/api/gif/search?q=${encodeURIComponent(query)}&limit=20`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.error === 'gif_not_configured') {
          this._showGifSetupGuide(grid);
          return;
        }
        if (data.error) {
          grid.innerHTML = `<div class="gif-picker-empty">${data.error}</div>`;
          return;
        }
        const results = data.results || [];
        if (results.length === 0) {
          grid.innerHTML = '<div class="gif-picker-empty">No GIFs found</div>';
          return;
        }
        this._renderGifGrid(results);
      })
      .catch(() => {
        grid.innerHTML = '<div class="gif-picker-empty">Search failed</div>';
      });
  }

  _showGifSetupGuide(grid) {
    const isAdmin = this.user && this.user.isAdmin;
    if (isAdmin) {
      grid.innerHTML = `
        <div class="gif-setup-guide">
          <h3>🎞️ Set Up GIF Search</h3>
          <p>GIF search is powered by <strong>GIPHY</strong> and needs a free API key.</p>
          <ol>
            <li>Go to <a href="https://developers.giphy.com/" target="_blank" rel="noopener">developers.giphy.com</a></li>
            <li>Create an account (or sign in)</li>
            <li>Click <b>Create an App</b> → choose <b>API</b></li>
            <li>Name it anything (e.g. "Haven Chat")</li>
            <li>Copy the API key and paste it below</li>
          </ol>
          <div class="gif-setup-input-row">
            <input type="text" id="gif-giphy-key-input" placeholder="Paste your GIPHY API key…" spellcheck="false" autocomplete="off" />
            <button id="gif-giphy-key-save">Save</button>
          </div>
          <p class="gif-setup-note">💡 No payment required — GIPHY's free tier is generous enough for a private server.</p>
        </div>`;
      const saveBtn = document.getElementById('gif-giphy-key-save');
      const input = document.getElementById('gif-giphy-key-input');
      saveBtn.addEventListener('click', () => {
        const key = input.value.trim();
        if (!key) return;
        this.socket.emit('update-server-setting', { key: 'giphy_api_key', value: key });
        grid.innerHTML = '<div class="gif-picker-empty">Saved! Loading GIFs…</div>';
        setTimeout(() => this._loadTrendingGifs(), 500);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveBtn.click();
      });
    } else {
      grid.innerHTML = `
        <div class="gif-setup-guide">
          <h3>🎞️ GIF Search Not Available</h3>
          <p>An admin needs to set up the GIPHY API key before GIF search can work.</p>
        </div>`;
    }
  }

  _renderGifGrid(results) {
    const grid = document.getElementById('gif-grid');
    grid.innerHTML = '';
    results.forEach(gif => {
      if (!gif.tiny) return;
      const img = document.createElement('img');
      img.src = gif.tiny;
      img.alt = gif.title || 'GIF';
      img.loading = 'lazy';
      img.dataset.full = gif.full || gif.tiny;
      grid.appendChild(img);
    });
  }

  _sendGifMessage(url) {
    if (!this.currentChannel || !url) return;
    const payload = {
      code: this.currentChannel,
      content: url,
    };
    if (this.replyingTo) {
      payload.replyTo = this.replyingTo.id;
      this._clearReply();
    }
    this.socket.emit('send-message', payload);
  }

  // ═══════════════════════════════════════════════════════
  // REACTIONS
  // ═══════════════════════════════════════════════════════

  _renderReactions(msgId, reactions) {
    if (!reactions || reactions.length === 0) return '';
    // Group by emoji
    const grouped = {};
    reactions.forEach(r => {
      if (!grouped[r.emoji]) grouped[r.emoji] = { emoji: r.emoji, users: [] };
      grouped[r.emoji].users.push({ id: r.user_id, username: r.username });
    });

    const badges = Object.values(grouped).map(g => {
      const isOwn = g.users.some(u => u.id === this.user.id);
      const names = g.users.map(u => u.username).join(', ');
      return `<button class="reaction-badge${isOwn ? ' own' : ''}" data-emoji="${g.emoji}" title="${names}">${g.emoji} ${g.users.length}</button>`;
    }).join('');

    return `<div class="reactions-row">${badges}</div>`;
  }

  _updateMessageReactions(messageId, reactions) {
    const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!msgEl) return;

    const wasAtBottom = this._isScrolledToBottom();

    // Remove old reactions row
    const oldRow = msgEl.querySelector('.reactions-row');
    if (oldRow) oldRow.remove();

    // Add new reactions
    const html = this._renderReactions(messageId, reactions);
    if (!html) { if (wasAtBottom) this._scrollToBottom(); return; }

    // Find where to insert — after .message-content
    const content = msgEl.querySelector('.message-content');
    if (content) {
      content.insertAdjacentHTML('afterend', html);
    }

    if (wasAtBottom) this._scrollToBottom();
  }

  _showReactionPicker(msgEl, msgId) {
    // Remove any existing reaction picker
    document.querySelectorAll('.reaction-picker').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    const quickEmojis = ['👍','👎','😂','❤️','🔥','💯','😮','😢'];
    quickEmojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'reaction-pick-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        this.socket.emit('add-reaction', { messageId: msgId, emoji });
        picker.remove();
      });
      picker.appendChild(btn);
    });

    msgEl.appendChild(picker);

    // Close on click outside
    const close = (e) => {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // ═══════════════════════════════════════════════════════
  // REPLY
  // ═══════════════════════════════════════════════════════

  _renderReplyBanner(replyCtx) {
    const previewText = replyCtx.content.length > 80
      ? replyCtx.content.substring(0, 80) + '…'
      : replyCtx.content;
    const color = this._getUserColor(replyCtx.username);
    return `
      <div class="reply-banner" data-reply-msg-id="${replyCtx.id}">
        <span class="reply-line" style="background:${color}"></span>
        <span class="reply-author" style="color:${color}">${this._escapeHtml(replyCtx.username)}</span>
        <span class="reply-preview">${this._escapeHtml(previewText)}</span>
      </div>
    `;
  }

  _setReply(msgEl, msgId) {
    // Get message info — works for both full messages and compact messages
    let author = msgEl.querySelector('.message-author')?.textContent;
    if (!author) {
      // Compact message — look up the previous full message's author
      let prev = msgEl.previousElementSibling;
      while (prev) {
        const authorEl = prev.querySelector('.message-author');
        if (authorEl) { author = authorEl.textContent; break; }
        prev = prev.previousElementSibling;
      }
    }
    author = author || 'someone';
    const content = msgEl.querySelector('.message-content')?.textContent || '';
    const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;

    this.replyingTo = { id: msgId, username: author, content };

    const bar = document.getElementById('reply-bar');
    bar.style.display = 'flex';
    document.getElementById('reply-preview-text').innerHTML =
      `Replying to <strong>${this._escapeHtml(author)}</strong>: ${this._escapeHtml(preview)}`;
    document.getElementById('message-input').focus();
  }

  _clearReply() {
    this.replyingTo = null;
    const bar = document.getElementById('reply-bar');
    if (bar) bar.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════
  // EDIT MESSAGE
  // ═══════════════════════════════════════════════════════

  _startEditMessage(msgEl, msgId) {
    const contentEl = msgEl.querySelector('.message-content');
    if (!contentEl) return;

    // Get raw text (strip HTML)
    const rawText = contentEl.textContent;

    // Replace content with an editable textarea
    const originalHtml = contentEl.innerHTML;
    contentEl.innerHTML = '';

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = rawText;
    textarea.rows = 1;
    textarea.maxLength = 2000;
    contentEl.appendChild(textarea);

    const btnRow = document.createElement('div');
    btnRow.className = 'edit-actions';
    btnRow.innerHTML = '<button class="edit-save-btn">Save</button><button class="edit-cancel-btn">Cancel</button>';
    contentEl.appendChild(btnRow);

    textarea.focus();
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';

    const cancel = () => {
      contentEl.innerHTML = originalHtml;
    };

    btnRow.querySelector('.edit-cancel-btn').addEventListener('click', cancel);
    btnRow.querySelector('.edit-save-btn').addEventListener('click', () => {
      const newContent = textarea.value.trim();
      if (!newContent) return cancel();
      if (newContent === rawText) return cancel();
      this.socket.emit('edit-message', { messageId: msgId, content: newContent });
      cancel(); // will be updated by the server event
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        btnRow.querySelector('.edit-save-btn').click();
      }
      if (e.key === 'Escape') cancel();
    });
  }

  // ═══════════════════════════════════════════════════════
  // ADMIN MODERATION UI
  // ═══════════════════════════════════════════════════════

  _showAdminActionModal(action, userId, username) {
    this.adminActionTarget = { action, userId, username };
    const modal = document.getElementById('admin-action-modal');
    const title = document.getElementById('admin-action-title');
    const desc = document.getElementById('admin-action-desc');
    const durationGroup = document.getElementById('admin-duration-group');
    const confirmBtn = document.getElementById('confirm-admin-action-btn');

    const labels = { kick: 'Kick', ban: 'Ban', mute: 'Mute' };
    title.textContent = `${labels[action]} — ${username}`;
    desc.textContent = action === 'ban'
      ? 'This user will be permanently banned until unbanned.'
      : action === 'mute'
        ? 'This user won\'t be able to send messages for the specified duration.'
        : 'This user will be removed from the current channel.';

    durationGroup.style.display = action === 'mute' ? 'block' : 'none';
    confirmBtn.textContent = labels[action];

    document.getElementById('admin-action-reason').value = '';
    document.getElementById('admin-action-duration').value = '10';
    modal.style.display = 'flex';
  }

  _applyServerSettings() {
    const vis = document.getElementById('member-visibility-select');
    if (vis && this.serverSettings.member_visibility) {
      vis.value = this.serverSettings.member_visibility;
    }
    // Cleanup settings
    const cleanupEnabled = document.getElementById('cleanup-enabled');
    if (cleanupEnabled) {
      cleanupEnabled.checked = this.serverSettings.cleanup_enabled === 'true';
    }
    const cleanupAge = document.getElementById('cleanup-max-age');
    if (cleanupAge && this.serverSettings.cleanup_max_age_days) {
      cleanupAge.value = this.serverSettings.cleanup_max_age_days;
    }
    const cleanupSize = document.getElementById('cleanup-max-size');
    if (cleanupSize && this.serverSettings.cleanup_max_size_mb) {
      cleanupSize.value = this.serverSettings.cleanup_max_size_mb;
    }
    // Whitelist setting
    const whitelistToggle = document.getElementById('whitelist-enabled');
    if (whitelistToggle) {
      whitelistToggle.checked = this.serverSettings.whitelist_enabled === 'true';
    }
    // Fetch whitelist entries when admin opens settings
    if (this.user && this.user.isAdmin) {
      this.socket.emit('get-whitelist');
    }
  }

  _renderWhitelist(list) {
    const el = document.getElementById('whitelist-list');
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="muted-text">No whitelisted users</p>';
      return;
    }
    el.innerHTML = list.map(w => `
      <div class="whitelist-item">
        <span class="whitelist-username">${this._escapeHtml(w.username)}</span>
        <button class="btn-sm btn-danger-sm whitelist-remove-btn" data-username="${this._escapeHtml(w.username)}">✕</button>
      </div>
    `).join('');
    el.querySelectorAll('.whitelist-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.socket.emit('whitelist-remove', { username: btn.dataset.username });
      });
    });
  }

  _renderBanList(bans) {
    const list = document.getElementById('bans-list');
    if (bans.length === 0) {
      list.innerHTML = '<p class="muted-text">No banned users</p>';
      return;
    }
    list.innerHTML = bans.map(b => `
      <div class="ban-item">
        <div class="ban-info">
          <strong>${this._escapeHtml(b.username)}</strong>
          <span class="ban-reason">${b.reason ? this._escapeHtml(b.reason) : 'No reason'}</span>
          <span class="ban-date">${new Date(b.created_at).toLocaleDateString()}</span>
        </div>
        <div class="ban-actions">
          <button class="btn-sm btn-unban" data-uid="${b.user_id}">Unban</button>
          <button class="btn-sm btn-delete-user" data-uid="${b.user_id}" data-uname="${this._escapeHtml(b.username)}" title="Delete user permanently (frees username)">🗑️</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.btn-unban').forEach(btn => {
      btn.addEventListener('click', () => {
        this.socket.emit('unban-user', { userId: parseInt(btn.dataset.uid) });
      });
    });

    list.querySelectorAll('.btn-delete-user').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.uname;
        if (confirm(`Permanently delete user "${name}"? This frees their username but cannot be undone.`)) {
          this.socket.emit('delete-user', { userId: parseInt(btn.dataset.uid) });
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // @MENTION AUTOCOMPLETE
  // ═══════════════════════════════════════════════════════

  _checkMentionTrigger() {
    const input = document.getElementById('message-input');
    const cursor = input.selectionStart;
    const text = input.value.substring(0, cursor);

    // Look backwards from cursor for an '@' that starts a word
    const match = text.match(/@(\w{0,30})$/);
    if (match) {
      this.mentionStart = cursor - match[0].length;
      this.mentionQuery = match[1].toLowerCase();
      this._showMentionDropdown();
    } else {
      this._hideMentionDropdown();
    }
  }

  _showMentionDropdown() {
    const dropdown = document.getElementById('mention-dropdown');
    const query = this.mentionQuery;
    const filtered = this.channelMembers.filter(m =>
      m.username.toLowerCase().startsWith(query)
    ).slice(0, 8);

    if (filtered.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    dropdown.innerHTML = filtered.map((m, i) =>
      `<div class="mention-item${i === 0 ? ' active' : ''}" data-username="${this._escapeHtml(m.username)}">${this._escapeHtml(m.username)}</div>`
    ).join('');

    dropdown.style.display = 'block';

    dropdown.querySelectorAll('.mention-item').forEach(item => {
      item.addEventListener('click', () => {
        this._insertMention(item.dataset.username);
      });
    });
  }

  _hideMentionDropdown() {
    const dropdown = document.getElementById('mention-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    this.mentionStart = -1;
    this.mentionQuery = '';
  }

  _navigateMentionDropdown(direction) {
    const dropdown = document.getElementById('mention-dropdown');
    const items = dropdown.querySelectorAll('.mention-item');
    if (items.length === 0) return;

    let activeIdx = -1;
    items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

    items.forEach(item => item.classList.remove('active'));
    let next = activeIdx + direction;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next].classList.add('active');
  }

  _insertMention(username) {
    const input = document.getElementById('message-input');
    const before = input.value.substring(0, this.mentionStart);
    const after = input.value.substring(input.selectionStart);
    input.value = before + '@' + username + ' ' + after;
    input.selectionStart = input.selectionEnd = this.mentionStart + username.length + 2;
    input.focus();
    this._hideMentionDropdown();
  }

  // ═══════════════════════════════════════════════════════
  // SLASH COMMAND AUTOCOMPLETE
  // ═══════════════════════════════════════════════════════

  _checkSlashTrigger() {
    const input = document.getElementById('message-input');
    const text = input.value;

    // Only activate if text starts with / and cursor is in the first word
    if (text.startsWith('/') && !text.includes(' ') && text.length < 25) {
      const query = text.substring(1).toLowerCase();
      this._showSlashDropdown(query);
    } else {
      this._hideSlashDropdown();
    }
  }

  _showSlashDropdown(query) {
    const dropdown = document.getElementById('slash-dropdown');
    const filtered = this.slashCommands.filter(c =>
      c.cmd.startsWith(query)
    ).slice(0, 10);

    if (filtered.length === 0 || (query === '' && filtered.length === this.slashCommands.length)) {
      // Show all on empty query
      if (query === '') {
        // show all
      } else {
        dropdown.style.display = 'none';
        return;
      }
    }

    const shown = query === '' ? this.slashCommands.slice(0, 12) : filtered;

    dropdown.innerHTML = shown.map((c, i) =>
      `<div class="slash-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
        <span class="slash-cmd">/${c.cmd}</span>
        ${c.args ? `<span class="slash-args">${this._escapeHtml(c.args)}</span>` : ''}
        <span class="slash-desc">${this._escapeHtml(c.desc)}</span>
      </div>`
    ).join('');

    dropdown.style.display = 'block';

    dropdown.querySelectorAll('.slash-item').forEach(item => {
      item.addEventListener('click', () => {
        this._insertSlashCommand(item.dataset.cmd);
      });
    });
  }

  _hideSlashDropdown() {
    const dropdown = document.getElementById('slash-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  _navigateSlashDropdown(direction) {
    const dropdown = document.getElementById('slash-dropdown');
    const items = dropdown.querySelectorAll('.slash-item');
    if (items.length === 0) return;

    let activeIdx = -1;
    items.forEach((item, i) => { if (item.classList.contains('active')) activeIdx = i; });

    items.forEach(item => item.classList.remove('active'));
    let next = activeIdx + direction;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next].classList.add('active');
    items[next].scrollIntoView({ block: 'nearest' });
  }

  _insertSlashCommand(cmd) {
    const input = document.getElementById('message-input');
    const cmdDef = this.slashCommands.find(c => c.cmd === cmd);
    const needsArg = cmdDef && cmdDef.args && cmdDef.args.startsWith('<');
    input.value = '/' + cmd + (needsArg ? ' ' : '');
    input.selectionStart = input.selectionEnd = input.value.length;
    input.focus();
    this._hideSlashDropdown();
    // If no args needed and not a "needs space" command, could auto-send
    // but user might want to add optional args, so just fill it in
  }

  // ═══════════════════════════════════════════════════════
  // ── User Status Picker ────────────────────────────────
  // ═══════════════════════════════════════════════════════

  _setupStatusPicker() {
    const userBar = document.querySelector('.user-bar');
    if (!userBar) return;

    // Insert status dot before username
    const statusDot = document.createElement('span');
    statusDot.id = 'user-status-dot';
    statusDot.className = 'user-dot status-picker-dot';
    statusDot.title = 'Set status';
    statusDot.addEventListener('click', () => this._toggleStatusPicker());
    const currentUser = document.getElementById('current-user');
    userBar.insertBefore(statusDot, currentUser);

    // Build dropdown
    const picker = document.createElement('div');
    picker.id = 'status-picker';
    picker.className = 'status-picker';
    picker.style.display = 'none';
    picker.innerHTML = `
      <div class="status-option" data-status="online"><span class="user-dot"></span> Online</div>
      <div class="status-option" data-status="away"><span class="user-dot away"></span> Away</div>
      <div class="status-option" data-status="dnd"><span class="user-dot dnd"></span> Do Not Disturb</div>
      <div class="status-option" data-status="invisible"><span class="user-dot invisible"></span> Invisible</div>
      <div class="status-text-row">
        <input type="text" id="status-text-input" placeholder="Custom status..." maxlength="128">
      </div>
    `;
    userBar.appendChild(picker);

    picker.querySelectorAll('.status-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const status = opt.dataset.status;
        const statusText = document.getElementById('status-text-input').value.trim();
        this.socket.emit('set-status', { status, statusText });
        picker.style.display = 'none';
      });
    });

    document.getElementById('status-text-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const statusText = e.target.value.trim();
        this.socket.emit('set-status', { status: this.userStatus, statusText });
        picker.style.display = 'none';
      }
    });

    // Close picker on outside click
    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target) && e.target !== statusDot) {
        picker.style.display = 'none';
      }
    });
  }

  _toggleStatusPicker() {
    const picker = document.getElementById('status-picker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  }

  _updateStatusPickerUI() {
    const dot = document.getElementById('user-status-dot');
    if (dot) {
      dot.className = 'user-dot status-picker-dot';
      if (this.userStatus === 'away') dot.classList.add('away');
      else if (this.userStatus === 'dnd') dot.classList.add('dnd');
      else if (this.userStatus === 'invisible') dot.classList.add('invisible');
    }
  }

  // ═══════════════════════════════════════════════════════
  // ── Idle Detection (auto-away after 5 min) ────────────
  // ═══════════════════════════════════════════════════════

  _setupIdleDetection() {
    const resetIdle = () => {
      if (this.userStatus === 'away' && this._wasAutoAway) {
        this._wasAutoAway = false;
        this.socket.emit('set-status', { status: 'online', statusText: this.userStatusText });
      }
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.userStatus === 'online') {
          this._wasAutoAway = true;
          this.socket.emit('set-status', { status: 'away', statusText: this.userStatusText });
        }
      }, 5 * 60 * 1000);
    };

    ['mousemove', 'keydown', 'click', 'scroll'].forEach(evt => {
      document.addEventListener(evt, resetIdle, { passive: true });
    });
    resetIdle();
  }

  // ═══════════════════════════════════════════════════════
  // ── General File Upload ───────────────────────────────
  // ═══════════════════════════════════════════════════════

  _setupFileUpload() {
    // Expand the existing file input to accept all file types
    // Add a separate file upload button next to the image upload
    const inputArea = document.querySelector('.message-input-area');
    const uploadBtn = document.getElementById('upload-btn');

    const fileBtn = document.createElement('button');
    fileBtn.id = 'file-upload-btn';
    fileBtn.className = 'btn-upload';
    fileBtn.title = 'Upload File';
    fileBtn.innerHTML = '📎';
    inputArea.insertBefore(fileBtn, uploadBtn.nextSibling);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'general-file-input';
    fileInput.style.display = 'none';
    inputArea.appendChild(fileInput);

    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => this._handleFileUpload(fileInput));
  }

  _handleFileUpload(input) {
    if (!input.files.length || !this.currentChannel) return;
    const file = input.files[0];
    if (file.size > 25 * 1024 * 1024) {
      this._showToast('File too large (max 25 MB)', 'error');
      input.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    this._showToast('Uploading file...', 'info');

    fetch('/api/upload-file', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: formData
    })
    .then(r => {
      if (!r.ok) return r.text().then(t => { throw new Error(t || `HTTP ${r.status}`); });
      return r.json();
    })
    .then(data => {
      if (data.error) {
        this._showToast(data.error, 'error');
        return;
      }
      // Send as a message with file attachment format
      const sizeStr = this._formatFileSize(data.fileSize);
      let content;
      if (data.isImage) {
        content = data.url; // images render inline already
      } else {
        // Use a special file attachment format: [file:name](url|size)
        content = `[file:${data.originalName}](${data.url}|${sizeStr})`;
      }
      this.socket.emit('send-message', {
        code: this.currentChannel,
        content,
        replyTo: this.replyingTo ? this.replyingTo.id : null
      });
      this._clearReply();
    })
    .catch(() => this._showToast('Upload failed', 'error'));

    input.value = '';
  }

  _formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ═══════════════════════════════════════════════════════
  // ── Mark-Read Helper ──────────────────────────────────
  // ═══════════════════════════════════════════════════════

  _markRead(messageId) {
    if (!this.currentChannel || !messageId) return;
    // Debounce: don't spam the server
    clearTimeout(this._markReadTimer);
    this._markReadTimer = setTimeout(() => {
      this.socket.emit('mark-read', { code: this.currentChannel, messageId });
    }, 500);
  }

  // ═══════════════════════════════════════════════════════
  // ── Slider Fill Helper ────────────────────────────────
  // ═══════════════════════════════════════════════════════

  _initSliderFills() {
    const update = (slider) => {
      const min = parseFloat(slider.min) || 0;
      const max = parseFloat(slider.max) || 100;
      const val = parseFloat(slider.value) || 0;
      const pct = ((val - min) / (max - min)) * 100;
      slider.style.setProperty('--fill', pct + '%');
    };
    document.querySelectorAll('input[type="range"]').forEach(s => {
      update(s);
      s.addEventListener('input', () => update(s));
    });
    // Observe future sliders (e.g. settings modal)
    this._sliderFillUpdate = update;
  }
}

// ── Boot ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => new HavenApp());
