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
    this._imageQueue = [];         // queued images awaiting send
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
    this.e2e = null;               // HavenE2E instance for DM encryption
    this._dmPublicKeys = {};       // { userId → jwk } cache for DM partner public keys
    this._e2eListenersAttached = false;
    this._e2eInitDone = false;
    this._oldestMsgId = null;      // oldest message ID in current view (for pagination)
    this._noMoreHistory = false;   // true when all history has been loaded
    this._loadingHistory = false;  // prevent concurrent history requests
    this._historyBefore = null;    // set when requesting older messages

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
      { cmd: 'play',       args: '<name or url>',    desc: 'Search & play music (e.g. /play Cut Your Teeth Kygo)' },
      { cmd: 'gif',        args: '<query>',  desc: 'Search & send a GIF inline (e.g. /gif thumbs up)' },
    ];

    // Emoji palette organized by category
    this.emojiCategories = {
      'Smileys':  ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🙂','🤗','🤩','🤔','😐','🙄','😏','😣','😥','😮','😯','😴','😛','😜','😝','😒','😔','🙃','😲','😤','😭','😢','😱','🥺','😠','😡','🤬','😈','💀','💩','🤡','👻','😺','😸','🫠','🫣','🫢','🫥','🫤','🥹','🥲','😶‍🌫️','🤭','🫡','🤫','🤥','😬','🫨','😵','😵‍💫','🥴','😮‍💨','😤','🥱','😇','🤠','🤑','🤓','😈','👿','🫶','🤧','😷','🤒','🤕','💅'],
      'People':   ['👋','🤚','✋','🖖','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🤝','🙏','💪','🫡','🫶','💅','💃','🕺','🤳','🖕','🫰','🫳','🫴','👐','🤲','🫱','🫲','🤷','🤦','🙇','💁','🙆','🙅','🤷‍♂️','🤷‍♀️','🙋','🙋‍♂️','🙋‍♀️','🧏','🧑‍🤝‍🧑','👫','👬','👭'],
      'Monkeys':  ['🙈','🙉','🙊','🐵','🐒','🦍','🦧'],
      'Animals':  ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐔','🐧','🐦','🦆','🦅','🦉','🐺','🐴','🦄','🐝','🦋','🐌','🐞','🐢','🐍','🐙','🐬','🐳','🦈','🐊','🦖','🦕','🐋','🦭','🦦','🦫','🦥','🐿️','🦔','🦇','🐓','🦃','🦚','🦜','🦢','🦩','🐕','🐈','🐈‍⬛'],
      'Faces':    ['👀','👁️','👁️‍🗨️','👅','👄','🫦','💋','🧠','🦷','🦴','👃','👂','🦻','🦶','🦵','💀','☠️','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'],
      'Food':     ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🌶️','🫑','🥦','🧄','🧅','🥕','🍕','🍔','🍟','🌭','🍿','🧁','🍩','🍪','🍰','🎂','🧀','🥚','🥓','🥩','🍗','🌮','🌯','🫔','🥙','🍜','🍝','🍣','🍱','☕','🍺','🍷','🥤','🧊','🧋','🍵','🥂','🍾'],
      'Activities':['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🎮','🕹️','🎲','🧩','🎯','🎳','🎭','🎨','🎼','🎵','🎸','🥁','🎹','🏆','🥇','🏅','🎪','🎬','🎤','🎧','🎺','🪘','🎻','🪗'],
      'Travel':   ['🚗','🚕','🚀','✈️','🚁','🛸','🚢','🏠','🏢','🏰','🗼','🗽','⛩️','🌋','🏔️','🌊','🌅','🌄','🌉','🎡','🎢','🗺️','🧭','🏖️','🏕️','🌍','🌎','🌏','🛳️','⛵','🚂','🚇','🏎️','🏍️','🛵','🛶'],
      'Objects':  ['⌚','📱','💻','⌨️','🖥️','💾','📷','🔭','🔬','💡','🔦','📚','📝','✏️','📎','📌','🔑','🔒','🔓','🛡️','⚔️','🔧','💰','💎','📦','🎁','✉️','🔔','🪙','💸','🏷️','🔨','🪛','🧲','🧪','🧫','💊','🩺','🩹','🧬'],
      'Symbols':  ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💝','✨','⭐','🌟','💫','🔥','💯','✅','❌','‼️','⁉️','❓','💤','🚫','⚠️','♻️','🏳️','🏴','🎵','➕','➖','➗','💲','♾️','🏳️‍🌈','🏴‍☠️','⚡','☀️','🌙','🌈','☁️','❄️','💨','🌪️']
    };

    // Flat list for quick access (used by search)
    this.emojis = Object.values(this.emojiCategories).flat();

    // Emoji name map for search (emoji → keywords)
    this.emojiNames = {
      '😀':'grinning happy','😁':'beaming grin','😂':'joy tears laughing lol','🤣':'rofl rolling laughing','😃':'smiley happy','😄':'smile happy','😅':'sweat nervous','😆':'laughing satisfied','😉':'wink','😊':'blush happy shy','😋':'yummy delicious','😎':'cool sunglasses','😍':'heart eyes love','🥰':'loving smiling hearts','😘':'kiss blowing','🙂':'slight smile','🤗':'hug hugging open hands','🤩':'starstruck star eyes','🤔':'thinking hmm','😐':'neutral expressionless','🙄':'eye roll','😏':'smirk','😣':'persevere','😥':'sad relieved disappointed','😮':'open mouth wow surprised','😯':'hushed surprised','😴':'sleeping zzz','😛':'tongue playful','😜':'wink tongue crazy','😝':'squinting tongue','😒':'unamused','😔':'pensive sad','🙃':'upside down','😲':'astonished shocked','😤':'triumph huff angry steam','😭':'crying sob loudly','😢':'cry sad tear','😱':'scream fear horrified','🥺':'pleading puppy eyes please','😠':'angry mad','😡':'rage pouting furious','🤬':'cursing swearing angry','😈':'devil smiling imp','💀':'skull dead','💩':'poop poo','🤡':'clown','👻':'ghost boo','😺':'cat smile','😸':'cat grin','🫠':'melting face','🫣':'peeking eye','🫢':'hand over mouth','🫥':'dotted line face','🫤':'diagonal mouth','🥹':'holding back tears','🥲':'smile tear','😶‍🌫️':'face in clouds','🤭':'giggling hand over mouth','🫡':'salute','🤫':'shush quiet secret','🤥':'lying pinocchio','😬':'grimace awkward','🫨':'shaking face','😵':'dizzy','😵‍💫':'face spiral eyes','🥴':'woozy drunk','😮‍💨':'exhale sigh relief','🥱':'yawn tired boring','😇':'angel innocent halo','🤠':'cowboy yeehaw','🤑':'money face rich','🤓':'nerd glasses','👿':'devil angry imp','🫶':'heart hands','🤧':'sneeze sick','😷':'mask sick','🤒':'thermometer sick','🤕':'bandage hurt','💅':'nail polish sassy',
      '👋':'wave hello hi bye','🤚':'raised back hand','✋':'hand stop high five','🖖':'vulcan spock','👌':'ok okay perfect','🤌':'pinched italian','✌️':'peace victory','🤞':'crossed fingers luck','🤟':'love you hand','🤘':'rock on metal','🤙':'call me shaka hang loose','👈':'point left','👉':'point right','👆':'point up','👇':'point down','☝️':'index up','👍':'thumbs up like good yes','👎':'thumbs down dislike bad no','✊':'fist bump','👊':'punch fist bump','🤛':'left fist bump','🤜':'right fist bump','👏':'clap applause','🙌':'raising hands celebrate','🤝':'handshake deal','🙏':'pray please thank you namaste','💪':'strong muscle flex bicep','💃':'dancer dancing woman','🕺':'man dancing','🤳':'selfie','🖕':'middle finger','🫰':'pinch','🫳':'palm down','🫴':'palm up','👐':'open hands','🤲':'palms up','🫱':'right hand','🫲':'left hand','🤷':'shrug idk','🤦':'facepalm','🙇':'bow','💁':'info','🙆':'ok gesture','🙅':'no gesture','🙋':'raising hand hi','🧏':'deaf',
      '🐶':'dog puppy','🐱':'cat kitty','🐭':'mouse','🐹':'hamster','🐰':'rabbit bunny','🦊':'fox','🐻':'bear','🐼':'panda','🐨':'koala','🐯':'tiger','🦁':'lion','🐮':'cow','🐷':'pig','🐸':'frog','🐔':'chicken','🐧':'penguin','🐦':'bird','🦆':'duck','🦅':'eagle','🦉':'owl','🐺':'wolf','🐴':'horse','🦄':'unicorn','🐝':'bee','🦋':'butterfly','🐌':'snail','🐞':'ladybug','🐢':'turtle','🐍':'snake','🐙':'octopus','🐬':'dolphin','🐳':'whale','🦈':'shark','🐊':'crocodile alligator','🦖':'trex dinosaur','🦕':'dinosaur brontosaurus',
      '🍎':'apple red','🍐':'pear','🍊':'orange tangerine','🍋':'lemon','🍌':'banana','🍉':'watermelon','🍇':'grapes','🍓':'strawberry','🍒':'cherry','🍑':'peach','🍍':'pineapple','🍕':'pizza','🍔':'burger hamburger','🍟':'fries french','🌭':'hotdog','🍿':'popcorn','🧁':'cupcake','🍩':'donut','🍪':'cookie','🍰':'cake','🎂':'birthday cake','🧀':'cheese','🥚':'egg','🥓':'bacon','🌮':'taco','🍜':'noodles ramen','🍝':'spaghetti pasta','🍣':'sushi','☕':'coffee','🍺':'beer','🍷':'wine','🍾':'champagne',
      '⚽':'soccer football','🏀':'basketball','🏈':'football american','🎮':'gaming controller video game','🕹️':'joystick arcade','🎲':'dice','🧩':'puzzle jigsaw','🎯':'bullseye target dart','🎨':'art palette paint','🎵':'music note','🎸':'guitar','🏆':'trophy winner','🎧':'headphones music','🎤':'microphone karaoke sing',
      '🚗':'car automobile','🚀':'rocket space launch','✈️':'airplane plane travel','🏠':'house home','🏰':'castle','🌊':'wave ocean water','🌅':'sunrise','🌍':'globe earth world','🌈':'rainbow',
      '❤️':'red heart love','🧡':'orange heart','💛':'yellow heart','💚':'green heart','💙':'blue heart','💜':'purple heart','🖤':'black heart','🤍':'white heart','💔':'broken heart','✨':'sparkles stars','⭐':'star','🔥':'fire hot lit','💯':'hundred perfect','✅':'check mark yes','❌':'cross mark no wrong','💤':'sleep zzz','⚠️':'warning caution','⚡':'lightning bolt zap','☀️':'sun sunny','🌙':'moon crescent night','❄️':'snowflake cold winter','🌪️':'tornado',
      '🙈':'see no evil monkey','🙉':'hear no evil monkey','🙊':'speak no evil monkey',
      '👀':'eyes looking','👅':'tongue','👄':'mouth lips','💋':'kiss lips','🧠':'brain smart','🦷':'tooth','🦴':'bone','💀':'skull dead','☠️':'skull crossbones','👽':'alien','🤖':'robot','🎃':'jack o lantern pumpkin halloween',
      '📱':'phone mobile','💻':'laptop computer','📷':'camera photo','📚':'books reading','📝':'memo note write','🔑':'key','🔒':'lock locked','💎':'gem diamond jewel','🎁':'gift present','🔔':'bell notification','💰':'money bag rich','🔨':'hammer tool'
    };

    if (!this.token || !this.user) {
      window.location.href = '/';
      return;
    }

    // Permission helper — true if user is admin or has mod role
    this._canModerate = () => this.user.isAdmin || (this.user.effectiveLevel || 0) >= 25;
    this._isServerMod = () => this.user.isAdmin || (this.user.effectiveLevel || 0) >= 50;
    this._hasPerm = (p) => this.user.isAdmin || (this.user.permissions || []).includes('*') || (this.user.permissions || []).includes(p);

    this.customEmojis = []; // [{name, url}] — loaded from server

    this._init();
  }

  // ── Initialization ────────────────────────────────────

  _init() {
    this.socket = io({ auth: { token: this.token } });
    this.voice = new VoiceManager(this.socket);
    if (this.user && this.user.id) this.voice.localUserId = this.user.id;
    
    // CRITICAL FIX: Run avatar setup first and use delegation to ensure listeners work
    this._setupAvatarUpload();

    this._setupSocketListeners();
    this._setupUI();
    this._setupThemes();
    this._setupServerBar();
    this._setupNotifications();
    this._setupPushNotifications();
    this._setupImageUpload();
    this._setupGifPicker();
    this._startStatusBar();
    this._setupMobile();
    this._setupMobileBridge();
    this._setupStatusPicker();
    this._setupFileUpload();
    this._setupIdleDetection();
    // this._setupAvatarUpload(); // Moved to top of _init
    this._setupSoundManagement();
    this._setupEmojiManagement();
    this._setupWebhookManagement();
    this._setupDiscordImport();
    this._initRoleManagement();
    this._initServerBranding();
    this._setupResizableSidebars();
    this.modMode = typeof ModMode === 'function' ? new ModMode() : null;
    this.modMode?.init();
    this._setupDensityPicker();
    this._setupImageModePicker();
    this._setupLightbox();
    this._setupOnlineOverlay();
    this._checkForUpdates();

    // CSP-safe image error handling (no inline onerror attributes)
    // For avatar images, hide the broken img and show the letter-initial fallback
    const avatarErrorHandler = (e) => {
      if (e.target.tagName === 'IMG') {
        e.target.style.display = 'none';
        const fallback = e.target.nextElementSibling;
        if (fallback && (fallback.classList.contains('message-avatar') || fallback.classList.contains('user-item-avatar'))) {
          fallback.style.display = 'flex';
        }
      }
    };
    document.getElementById('messages')?.addEventListener('error', avatarErrorHandler, true);
    document.getElementById('online-users')?.addEventListener('error', avatarErrorHandler, true);

    this.socket.emit('get-channels');
    this.socket.emit('get-server-settings');
    this.socket.emit('get-preferences');
    this.socket.emit('get-high-scores', { game: 'flappy' });

    // E2E init is deferred to 'session-info' handler to ensure
    // the socket is fully connected and server-side handlers are registered.

    document.getElementById('current-user').textContent = this.user.displayName || this.user.username;
    const loginEl = document.getElementById('login-name');
    if (loginEl) loginEl.textContent = `@${this.user.username}`;

    if (this.user.isAdmin || this._hasPerm('create_channel')) {
      document.getElementById('admin-controls').style.display = 'block';
    }
    if (this.user.isAdmin) {
      document.getElementById('admin-mod-panel').style.display = 'block';
      const organizeBtn = document.getElementById('organize-channels-btn');
      if (organizeBtn) organizeBtn.style.display = '';
    }

    document.getElementById('mod-mode-settings-toggle')?.addEventListener('click', () => this.modMode?.toggle());
  }

  // ── Socket Event Listeners ────────────────────────────

  _setupSocketListeners() {
    // Authoritative user info pushed by server on every connect
    this.socket.on('session-info', (data) => {
      this.user = { ...this.user, ...data };
      this.user.roles = data.roles || [];
      this.user.effectiveLevel = data.effectiveLevel || 0;
      this.user.permissions = data.permissions || [];
      if (this.voice && data.id) this.voice.localUserId = data.id;
      if (data.status) {
        this.userStatus = data.status;
        this.userStatusText = data.statusText || '';
        this._manualStatusOverride = (data.status !== 'online' && data.status !== 'away');
        this._updateStatusPickerUI();
      }
      // Sync avatar shape from server
      if (data.avatarShape) {
        this.user.avatarShape = data.avatarShape;
        this._avatarShape = data.avatarShape;
        this._pendingAvatarShape = data.avatarShape;
        localStorage.setItem('haven_avatar_shape', data.avatarShape);
        // Update shape picker UI
        const picker = document.getElementById('avatar-shape-picker');
        if (picker) {
          picker.querySelectorAll('.avatar-shape-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.shape === data.avatarShape);
          });
        }
      }
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      // Init E2E encryption AFTER socket is fully connected & server handlers registered
      if (!this._e2eInitDone) {
        this._e2eInitDone = true;
        this._initE2E();
      }
      // Show server version in status bar
      if (data.version) {
        const vEl = document.getElementById('status-version');
        if (vEl) vEl.textContent = 'v' + data.version;
      }
      // Refresh display name + admin UI with authoritative data
      document.getElementById('current-user').textContent = this.user.displayName || this.user.username;
      const loginEl = document.getElementById('login-name');
      if (loginEl) loginEl.textContent = `@${this.user.username}`;
      // Update avatar preview in settings if present
      this._updateAvatarPreview();
      // Show admin/mod controls based on role level
      const canModerate = this.user.isAdmin || this.user.effectiveLevel >= 25;
      const canCreateChannel = this.user.isAdmin || this._hasPerm('create_channel');
      document.getElementById('admin-controls').style.display = canCreateChannel ? 'block' : 'none';
      if (this.user.isAdmin) {
        document.getElementById('admin-mod-panel').style.display = 'block';
      } else {
        document.getElementById('admin-mod-panel').style.display = canModerate ? 'block' : 'none';
      }
    });

    // Roles updated (from admin assigning/revoking)
    this.socket.on('roles-updated', (data) => {
      this.user.roles = data.roles || [];
      this.user.effectiveLevel = data.effectiveLevel || 0;
      this.user.permissions = data.permissions || [];
      localStorage.setItem('haven_user', JSON.stringify(this.user));
      // Refresh UI to reflect new permissions
      const canModerate = this.user.isAdmin || this.user.effectiveLevel >= 25;
      const canCreateChannel = this.user.isAdmin || this._hasPerm('create_channel');
      document.getElementById('admin-controls').style.display = canCreateChannel ? 'block' : 'none';
      document.getElementById('admin-mod-panel').style.display = canModerate ? 'block' : 'none';
      this._showToast('Your roles have been updated', 'info');
    });

    // Avatar updated confirmation (from socket broadcast by other tabs/reconnect)
    this.socket.on('avatar-updated', (data) => {
      if (data && data.url !== undefined) {
        this.user.avatar = data.url;
        localStorage.setItem('haven_user', JSON.stringify(this.user));
        this._updateAvatarPreview();
      }
    });

    this.socket.on('connect', () => {
      this._setLed('connection-led', 'on');
      this._setLed('status-server-led', 'on');
      document.getElementById('status-server-text').textContent = 'Connected';
      this._startPingMonitor();
      // Re-join channel after reconnect (server lost our room membership)
      this.socket.emit('visibility-change', { visible: !document.hidden });
      this.socket.emit('get-channels');
      this.socket.emit('get-server-settings');
      if (this.currentChannel) {
        this.socket.emit('enter-channel', { code: this.currentChannel });
        // Reset pagination — reconnect replaces message list
        this._oldestMsgId = null;
        this._noMoreHistory = false;
        this._loadingHistory = false;
        this._historyBefore = null;
        this.socket.emit('get-messages', { code: this.currentChannel });
        this.socket.emit('get-channel-members', { code: this.currentChannel });
        // Request fresh voice list for this channel
        this.socket.emit('request-voice-users', { code: this.currentChannel });
      }
      // Re-join voice if we were in voice before reconnect
      if (this.voice && this.voice.inVoice && this.voice.currentChannel) {
        this.socket.emit('voice-rejoin', { code: this.voice.currentChannel });
      }
    });
    document.addEventListener('visibilitychange', () => {
      this.socket?.emit('visibility-change', { visible: !document.hidden });
      // Mobile fix: when returning to foreground, ensure socket is connected and refresh data
      if (!document.hidden) {
        if (this.socket && !this.socket.connected) {
          this.socket.connect();
        }
        // Re-fetch current channel messages + member list to catch anything missed
        if (this.currentChannel && this.socket?.connected) {
          this._oldestMsgId = null;
          this._noMoreHistory = false;
          this._loadingHistory = false;
          this._historyBefore = null;
          this.socket.emit('get-messages', { code: this.currentChannel });
          this.socket.emit('get-channel-members', { code: this.currentChannel });
        }
        // Re-fetch channels in case list changed while backgrounded
        this.socket?.emit('get-channels');
      }
    });

    this.socket.on('disconnect', () => {
      this._setLed('connection-led', 'danger pulse');
      this._setLed('status-server-led', 'danger pulse');
      document.getElementById('status-server-text').textContent = 'Disconnected';
      document.getElementById('status-ping').textContent = '--';
    });

    this.socket.on('connect_error', (err) => {
      if (err.message === 'Invalid token' || err.message === 'Authentication required' || err.message === 'Session expired') {
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
      // Request fresh voice counts so sidebar indicators are always correct
      // (covers cases where initial push arrived before DOM was ready)
      this.socket.emit('get-voice-counts');
    });

    // Channel renamed — update header if we're in that channel
    this.socket.on('channel-renamed', (data) => {
      if (data.code === this.currentChannel) {
        const el = document.getElementById('channel-header-name');
        el.textContent = '# ' + data.name;
        // Clear scramble cache so the effect picks up the renamed channel
        delete el.dataset.originalText;
        el._scrambling = false;
      }
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

    this.socket.on('message-history', async (data) => {
      if (data.channelCode !== this.currentChannel) return;
      // E2E: decrypt DM messages before rendering
      await this._decryptMessages(data.messages);

      if (this._historyBefore) {
        // Pagination request — prepend older messages
        this._loadingHistory = false;
        this._historyBefore = null;
        if (data.messages.length === 0) {
          this._noMoreHistory = true;
          return;
        }
        if (data.messages.length < 80) this._noMoreHistory = true;
        this._oldestMsgId = data.messages[0].id;
        this._prependMessages(data.messages);
      } else {
        // Initial load — replace everything
        if (data.messages.length > 0) {
          this._oldestMsgId = data.messages[0].id;
          if (data.messages.length < 80) this._noMoreHistory = true;
        } else {
          this._noMoreHistory = true;
        }
        this._renderMessages(data.messages);
      }
    });

    // ── Infinite scroll: load older messages on scroll-to-top ──
    const msgContainer = document.getElementById('messages');
    if (msgContainer) {
      msgContainer.addEventListener('scroll', () => {
        if (msgContainer.scrollTop < 200 && !this._noMoreHistory && !this._loadingHistory && this._oldestMsgId && this.currentChannel) {
          this._loadingHistory = true;
          this._historyBefore = this._oldestMsgId;
          this.socket.emit('get-messages', {
            code: this.currentChannel,
            before: this._oldestMsgId
          });
        }
      });
    }

    this.socket.on('new-message', async (data) => {
      // E2E: ensure partner key is available before decrypting
      const msgCh = this.channels.find(c => c.code === data.channelCode);
      if (msgCh && msgCh.is_dm && msgCh.dm_target && !this._dmPublicKeys[msgCh.dm_target.id]) {
        this._fetchDMPartnerKey(msgCh);
      }
      // E2E: decrypt single message if encrypted
      await this._decryptMessages([data.message]);

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
        // Refresh online overlay if open
        const overlay = document.getElementById('online-overlay');
        if (overlay && overlay.style.display !== 'none') {
          this._renderOnlineOverlay();
        }
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

    // ── Music sharing ────────────────────────────────
    this.socket.on('music-shared', (data) => {
      this._handleMusicShared(data);
    });
    this.socket.on('music-stopped', (data) => {
      this._handleMusicStopped(data);
    });
    this.socket.on('music-control', (data) => {
      this._handleMusicControl(data);
    });
    this.socket.on('music-seek', (data) => {
      if (data && typeof data.position === 'number') this._seekMusic(data.position);
    });
    this.socket.on('music-search-results', (data) => {
      this._showMusicSearchResults(data);
    });

    // ── Voice kicked ────────────────────────────────
    this.socket.on('voice-kicked', (data) => {
      // Server forcibly removed us from voice — tear down locally
      if (this.voice && this.voice.inVoice) {
        this.voice.leave();
        this._updateVoiceButtons(false);
        this._updateVoiceStatus(false);
        this._updateVoiceBar();
        this._showToast(`Kicked from voice by ${data.kickedBy || 'a moderator'}`, 'error');
      }
    });

    // ── Stream viewer tracking ───────────────────────
    this._streamInfo = []; // Array of { sharerId, sharerName, viewers: [{ id, username }] }
    this.socket.on('stream-viewers-update', (data) => {
      this._streamInfo = data.streams || [];
      this._updateStreamViewerBadges();
      // Always re-render voice users so the LIVE viewer count updates
      // regardless of which text channel the user is viewing
      if (this._lastVoiceUsers) {
        this._renderVoiceUsers(this._lastVoiceUsers);
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
      // E2E: pre-fetch partner's public key for new DMs
      if (data.is_dm && data.dm_target) {
        this._fetchDMPartnerKey(data);
      }
      // Auto-expand DM section when a DM opens
      const dmList = document.getElementById('dm-list');
      if (dmList && dmList.style.display === 'none') {
        dmList.style.display = '';
        const arrow = document.querySelector('.dm-toggle-arrow');
        if (arrow) arrow.classList.remove('collapsed');
        localStorage.setItem('haven_dm_collapsed', false);
      }
      this.switchChannel(data.code);
      // Scroll the DM channel into view in the sidebar
      const dmEl = document.querySelector(`.channel-item[data-code="${data.code}"]`);
      if (dmEl) dmEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Re-enable any disabled DM buttons
      document.querySelectorAll('.user-dm-btn[disabled]').forEach(b => { b.disabled = false; b.style.opacity = ''; });
    });

    // ── Channel code rotated (dynamic codes) ────────
    this.socket.on('channel-code-rotated', (data) => {
      const ch = this.channels.find(c => c.id === data.channelId);
      if (ch) {
        ch.code = data.newCode;
        this._renderChannels();
        // If currently viewing this channel, update the header code display
        if (this.currentChannel === data.oldCode) {
          this.currentChannel = data.newCode;
          const codeDisplay = document.getElementById('channel-code-display');
          if (codeDisplay) codeDisplay.textContent = data.newCode;
          // Update the active class on the new code
          document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
          const activeEl = document.querySelector(`.channel-item[data-code="${data.newCode}"]`);
          if (activeEl) activeEl.classList.add('active');
        }
        if (this.user.isAdmin) {
          this._showToast(`Channel code rotated for #${ch.name}`, 'info');
        }
      }
    });

    // ── Channel code settings updated ───────────────
    this.socket.on('channel-code-settings-updated', (data) => {
      const ch = this.channels.find(c => c.id === data.channelId);
      if (ch && data.settings) {
        ch.code_visibility = data.settings.code_visibility;
        ch.code_mode = data.settings.code_mode;
        ch.code_rotation_type = data.settings.code_rotation_type;
        ch.code_rotation_interval = data.settings.code_rotation_interval;
      }
    });

    // ── Webhook events ──────────────────────────────
    this.socket.on('webhook-created', (wh) => {
      // Show token once
      const reveal = document.getElementById('webhook-token-reveal');
      const urlDisplay = document.getElementById('webhook-url-display');
      const baseUrl = window.location.origin;
      urlDisplay.value = `${baseUrl}/api/webhooks/${wh.token}`;
      reveal.style.display = 'block';
      // Refresh the list
      const code = document.getElementById('webhook-modal')._channelCode;
      if (code) this.socket.emit('get-webhooks', { channelCode: code });
    });
    this.socket.on('webhooks-list', (data) => {
      this._renderWebhookList(data.webhooks, data.channelCode);
    });
    this.socket.on('webhook-deleted', (data) => {
      const code = document.getElementById('webhook-modal')._channelCode;
      if (code) this.socket.emit('get-webhooks', { channelCode: code });
    });
    this.socket.on('webhook-toggled', (data) => {
      const code = document.getElementById('webhook-modal')._channelCode;
      if (code) this.socket.emit('get-webhooks', { channelCode: code });
    });
    this.socket.on('bot-updated', (msg) => {
      this._showToast(msg, 'success');
    });

    // ── Status updated ──────────────────────────────
    this.socket.on('status-updated', (data) => {
      this.userStatus = data.status;
      this.userStatusText = data.statusText;
      this._updateStatusPickerUI();
    });

    // ── User profile popup data ─────────────────────
    this.socket.on('user-profile', (profile) => {
      this._showProfilePopup(profile);
    });

    this.socket.on('bio-updated', (data) => {
      this.user.bio = data.bio || '';
      this._showToast('Bio updated', 'success');
    });

    // ── Username rename ──────────────────────────────
    this.socket.on('renamed', (data) => {
      this.token = data.token;
      this.user = data.user;
      if (this.voice && data.user.id) this.voice.localUserId = data.user.id;
      localStorage.setItem('haven_token', data.token);
      localStorage.setItem('haven_user', JSON.stringify(data.user));
      document.getElementById('current-user').textContent = data.user.displayName || data.user.username;
      const loginEl = document.getElementById('login-name');
      if (loginEl) loginEl.textContent = `@${data.user.username}`;
      this._showToast(`Display name changed to "${data.user.displayName || data.user.username}"`, 'success');
      // Refresh admin UI in case admin status changed
      this.user.permissions = data.user.permissions || this.user.permissions || [];
      const canCreate = data.user.isAdmin || this._hasPerm('create_channel');
      document.getElementById('admin-controls').style.display = canCreate ? 'block' : 'none';
      if (data.user.isAdmin) {
        document.getElementById('admin-mod-panel').style.display = 'block';
      } else {
        document.getElementById('admin-mod-panel').style.display = 'none';
      }
    });

    this.socket.on('user-renamed', (data) => {
      if (data.channelCode === this.currentChannel) {
        this._appendSystemMessage(`${data.oldName} is now known as ${data.newName}`);
      }
    });

    // ── Message edit / delete ──────────────────────────
    this.socket.on('message-edited', async (data) => {
      if (data.channelCode === this.currentChannel) {
        const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
        if (!msgEl) return;
        const contentEl = msgEl.querySelector('.message-content');
        if (contentEl) {
          // E2E: decrypt if needed
          let displayContent = data.content;
          if (HavenE2E.isEncrypted(data.content)) {
            const partner = this._getE2EPartner();
            if (partner) {
              try {
                const plain = await this.e2e.decrypt(data.content, partner.userId, partner.publicKeyJwk);
                if (plain !== null) displayContent = plain;
                else displayContent = '[Encrypted message — unable to decrypt]';
              } catch { displayContent = '[Encrypted message — unable to decrypt]'; }
            } else {
              displayContent = '[Encrypted message — unable to decrypt]';
            }
          }
          contentEl.innerHTML = this._formatContent(displayContent);
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
        if (msgEl) {
          // If the next sibling is a compact message (grouped), promote it to a full message
          const next = msgEl.nextElementSibling;
          if (next && next.classList.contains('message-compact')) {
            this._promoteCompactToFull(next);
          }
          msgEl.remove();
        }
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
      this._maybeShowSetupWizard();
    });

    this.socket.on('server-setting-changed', (data) => {
      this.serverSettings[data.key] = data.value;
      this._applyServerSettings();
    });

    // ── Webhooks list ──────────────────────────────────
    this.socket.on('webhooks-list', (data) => {
      this._renderWebhooksList(data.webhooks || []);
      // Also update bot modal sidebar if open
      if (document.getElementById('bot-modal')?.style.display === 'flex') {
        this._renderBotSidebar(data.webhooks || []);
        // Re-show detail panel if a bot was selected
        if (this._selectedBotId) {
          const stillExists = (data.webhooks || []).find(w => w.id === this._selectedBotId);
          if (stillExists) this._showBotDetail(this._selectedBotId);
          else {
            this._selectedBotId = null;
            document.getElementById('bot-detail-panel').innerHTML = '<p class="muted-text" style="padding:20px;text-align:center">Select a bot to edit, or create a new one</p>';
          }
        }
      }
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
      // Relay to game window or iframe if open
      try { if (this._gameWindow && !this._gameWindow.closed) this._gameWindow.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch {}
      try { if (this._gameIframe) this._gameIframe.contentWindow?.postMessage({ type: 'leaderboard-data', leaderboard: data.leaderboard }, window.location.origin); } catch {}
    });

    this.socket.on('new-high-score', (data) => {
      const gameName = this._gamesRegistry?.find(g => g.id === data.game)?.name || data.game;
      this._showToast(`🏆 ${data.username} set a new ${gameName} record: ${data.score}!`, 'success');
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
      // If emoji dropdown is visible, hijack arrow keys, enter, tab, escape
      const emojiDd = document.getElementById('emoji-dropdown');
      if (emojiDd && emojiDd.style.display !== 'none') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._navigateEmojiDropdown(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const active = emojiDd.querySelector('.emoji-ac-item.active');
          if (active) { e.preventDefault(); active.click(); return; }
        }
        if (e.key === 'Escape') { this._hideEmojiDropdown(); return; }
      }

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
      // Check for :emoji autocomplete trigger
      this._checkEmojiTrigger();
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
      if (this.currentChannel && this.currentChannel !== '••••••••') {
        navigator.clipboard.writeText(this.currentChannel).then(() => {
          this._showToast('Channel code copied!', 'success');
        });
      }
    });

    // Delete channel
    // ── Channel context menu ("..." on hover) ──────────
    this._initChannelContextMenu();
    this._initDmContextMenu();
    // Delete channel with TWO confirmations (from ctx menu)
    document.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      if (!confirm('⚠️ Delete this channel?\nAll messages will be permanently lost.')) return;
      if (!confirm('⚠️ Are you ABSOLUTELY sure?\nThis action cannot be undone!')) return;
      this.socket.emit('delete-channel', { code });
    });
    // Mute channel toggle
    document.querySelector('[data-action="mute"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
      const idx = muted.indexOf(code);
      if (idx >= 0) { muted.splice(idx, 1); this._showToast('Channel unmuted', 'success'); }
      else { muted.push(code); this._showToast('Channel muted', 'success'); }
      localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    });
    // Join voice from context menu
    document.querySelector('[data-action="join-voice"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      // Switch to the channel first, then join voice
      this.switchChannel(code);
      setTimeout(() => this._joinVoice(), 300);
    });
    // Disconnect from voice via context menu
    document.querySelector('[data-action="leave-voice"]')?.addEventListener('click', () => {
      this._closeChannelCtxMenu();
      this._leaveVoice();
    });
    // Toggle streams permission
    document.querySelector('[data-action="toggle-streams"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      this.socket.emit('toggle-channel-permission', { code, permission: 'streams' });
    });
    // Toggle music permission
    document.querySelector('[data-action="toggle-music"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      this.socket.emit('toggle-channel-permission', { code, permission: 'music' });
    });
    // Move channel up/down
    document.querySelector('[data-action="organize"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      this._openOrganizeModal(code);
    });
    // Organize modal controls
    document.getElementById('organize-global-sort')?.addEventListener('change', (e) => {
      if (!this._organizeParentCode) return;
      const sortMode = e.target.value; // 'manual', 'alpha', 'created', 'oldest'
      if (this._organizeServerLevel) {
        // Server-level sort: store in localStorage (no parent channel to hold it)
        localStorage.setItem('haven_server_sort_mode', sortMode);
      } else {
        // Sub-channel sort: store on the parent channel (server-side)
        this.socket.emit('set-sort-alphabetical', { code: this._organizeParentCode, enabled: sortMode === 'alpha', mode: sortMode });
        const parent = this.channels.find(c => c.code === this._organizeParentCode);
        if (parent) parent.sort_alphabetical = sortMode === 'alpha' ? 1 : sortMode === 'created' ? 2 : sortMode === 'oldest' ? 3 : 0;
      }
      this._renderOrganizeList();
    });
    document.getElementById('organize-move-up')?.addEventListener('click', () => {
      if (!this._organizeSelected) return;
      const idx = this._organizeList.findIndex(c => c.code === this._organizeSelected);
      if (idx <= 0) return;
      [this._organizeList[idx], this._organizeList[idx - 1]] = [this._organizeList[idx - 1], this._organizeList[idx]];
      this._organizeList.forEach((c, i) => c.position = i);
      this._renderOrganizeList();
      this.socket.emit('reorder-channels', { order: this._organizeList.map((c, i) => ({ code: c.code, position: i })) });
    });
    document.getElementById('organize-move-down')?.addEventListener('click', () => {
      if (!this._organizeSelected) return;
      const idx = this._organizeList.findIndex(c => c.code === this._organizeSelected);
      if (idx < 0 || idx >= this._organizeList.length - 1) return;
      [this._organizeList[idx], this._organizeList[idx + 1]] = [this._organizeList[idx + 1], this._organizeList[idx]];
      this._organizeList.forEach((c, i) => c.position = i);
      this._renderOrganizeList();
      this.socket.emit('reorder-channels', { order: this._organizeList.map((c, i) => ({ code: c.code, position: i })) });
    });
    document.getElementById('organize-set-tag')?.addEventListener('click', () => {
      if (!this._organizeSelected) return;
      const tag = document.getElementById('organize-tag-input').value.trim();
      if (!tag) return;
      this.socket.emit('set-channel-category', { code: this._organizeSelected, category: tag });
      const ch = this._organizeList.find(c => c.code === this._organizeSelected);
      if (ch) ch.category = tag;
      // Also update main channels array
      const mainCh = this.channels.find(c => c.code === this._organizeSelected);
      if (mainCh) mainCh.category = tag;
      this._renderOrganizeList();
    });
    document.getElementById('organize-remove-tag')?.addEventListener('click', () => {
      if (!this._organizeSelected) return;
      this.socket.emit('set-channel-category', { code: this._organizeSelected, category: '' });
      const ch = this._organizeList.find(c => c.code === this._organizeSelected);
      if (ch) ch.category = null;
      const mainCh = this.channels.find(c => c.code === this._organizeSelected);
      if (mainCh) mainCh.category = null;
      document.getElementById('organize-tag-input').value = '';
      this._renderOrganizeList();
    });
    document.getElementById('organize-done-btn')?.addEventListener('click', () => {
      document.getElementById('organize-modal').style.display = 'none';
      if (this._organizeServerLevel) this._renderChannels();
      this._organizeParentCode = null;
      this._organizeList = null;
      this._organizeSelected = null;
      this._organizeServerLevel = false;
    });
    document.getElementById('organize-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'organize-modal') {
        document.getElementById('organize-modal').style.display = 'none';
        if (this._organizeServerLevel) this._renderChannels();
        this._organizeParentCode = null;
        this._organizeList = null;
        this._organizeSelected = null;
        this._organizeServerLevel = false;
      }
    });
    // ── DM Organize Modal ──
    document.getElementById('organize-dms-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); // don't toggle DM collapse
      this._openDmOrganizeModal();
    });
    document.getElementById('dm-organize-sort')?.addEventListener('change', () => {
      const mode = document.getElementById('dm-organize-sort').value;
      localStorage.setItem('haven_dm_sort_mode', mode);
      this._renderDmOrganizeList();
    });
    document.getElementById('dm-organize-move-up')?.addEventListener('click', () => {
      if (!this._dmOrganizeSelected) return;
      const idx = this._dmOrganizeList.findIndex(c => c.code === this._dmOrganizeSelected);
      if (idx <= 0) return;
      [this._dmOrganizeList[idx], this._dmOrganizeList[idx - 1]] = [this._dmOrganizeList[idx - 1], this._dmOrganizeList[idx]];
      this._saveDmOrder();
      this._renderDmOrganizeList();
    });
    document.getElementById('dm-organize-move-down')?.addEventListener('click', () => {
      if (!this._dmOrganizeSelected) return;
      const idx = this._dmOrganizeList.findIndex(c => c.code === this._dmOrganizeSelected);
      if (idx < 0 || idx >= this._dmOrganizeList.length - 1) return;
      [this._dmOrganizeList[idx], this._dmOrganizeList[idx + 1]] = [this._dmOrganizeList[idx + 1], this._dmOrganizeList[idx]];
      this._saveDmOrder();
      this._renderDmOrganizeList();
    });
    document.getElementById('dm-organize-set-tag')?.addEventListener('click', () => {
      if (!this._dmOrganizeSelected) return;
      const tag = document.getElementById('dm-organize-tag-input').value.trim();
      if (!tag) return;
      const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');
      assignments[this._dmOrganizeSelected] = tag;
      localStorage.setItem('haven_dm_assignments', JSON.stringify(assignments));
      // Ensure category entry exists
      const cats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
      if (!cats[tag]) cats[tag] = { collapsed: false };
      localStorage.setItem('haven_dm_categories', JSON.stringify(cats));
      this._renderDmOrganizeList();
    });
    document.getElementById('dm-organize-remove-tag')?.addEventListener('click', () => {
      if (!this._dmOrganizeSelected) return;
      const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');
      delete assignments[this._dmOrganizeSelected];
      localStorage.setItem('haven_dm_assignments', JSON.stringify(assignments));
      document.getElementById('dm-organize-tag-input').value = '';
      this._renderDmOrganizeList();
    });
    document.getElementById('dm-organize-done-btn')?.addEventListener('click', () => {
      document.getElementById('dm-organize-modal').style.display = 'none';
      this._dmOrganizeList = null;
      this._dmOrganizeSelected = null;
      this._renderChannels();
    });
    document.getElementById('dm-organize-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'dm-organize-modal') {
        document.getElementById('dm-organize-modal').style.display = 'none';
        this._dmOrganizeList = null;
        this._dmOrganizeSelected = null;
        this._renderChannels();
      }
    });
    // Slow mode
    document.querySelector('[data-action="slow-mode"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      const ch = this.channels.find(c => c.code === code);
      const current = (ch && ch.slow_mode_interval) || 0;
      const input = prompt('Slow mode interval in seconds (0 = off, max 3600):', current);
      if (input !== null) {
        const interval = parseInt(input);
        if (!isNaN(interval)) {
          this.socket.emit('set-slow-mode', { code, interval });
        }
      }
    });
    // Webhooks management
    document.querySelector('[data-action="webhooks"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      this._openWebhookModal(code);
    });
    // Channel Roles management
    document.querySelector('[data-action="channel-roles"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      this._openChannelRolesModal(code);
    });
    document.getElementById('channel-roles-done-btn')?.addEventListener('click', () => {
      document.getElementById('channel-roles-modal').style.display = 'none';
    });
    document.getElementById('channel-roles-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'channel-roles-modal') {
        document.getElementById('channel-roles-modal').style.display = 'none';
      }
    });
    document.getElementById('channel-roles-assign-btn')?.addEventListener('click', () => {
      this._assignChannelRole();
    });
    document.getElementById('channel-roles-create-btn')?.addEventListener('click', () => {
      this._createChannelRole();
    });
    document.getElementById('webhook-create-btn')?.addEventListener('click', () => {
      const name = document.getElementById('webhook-name-input').value.trim();
      if (!name) return;
      const code = document.getElementById('webhook-modal')._channelCode;
      if (!code) return;
      this.socket.emit('create-webhook', { channelCode: code, name });
      document.getElementById('webhook-name-input').value = '';
    });
    document.getElementById('webhook-copy-url-btn')?.addEventListener('click', () => {
      const urlEl = document.getElementById('webhook-url-display');
      navigator.clipboard.writeText(urlEl.value).then(() => {
        document.getElementById('webhook-copy-url-btn').textContent = '✅ Copied';
        setTimeout(() => { document.getElementById('webhook-copy-url-btn').textContent = '📋 Copy'; }, 2000);
      });
    });
    document.getElementById('webhook-close-btn')?.addEventListener('click', () => {
      document.getElementById('webhook-modal').style.display = 'none';
    });
    document.getElementById('webhook-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    // Create sub-channel
    document.querySelector('[data-action="create-sub-channel"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      const parentCh = this.channels.find(c => c.code === code);
      if (!parentCh) return;
      // Show the create-sub-channel modal
      document.getElementById('create-sub-name').value = '';
      document.getElementById('create-sub-private').checked = false;
      document.getElementById('create-sub-parent-name').textContent = `# ${parentCh.name}`;
      document.getElementById('create-sub-modal').style.display = 'flex';
      document.getElementById('create-sub-modal')._parentCode = code;
      document.getElementById('create-sub-name').focus();
    });
    // Create sub-channel modal confirm/cancel
    document.getElementById('create-sub-confirm-btn')?.addEventListener('click', () => {
      const modal = document.getElementById('create-sub-modal');
      const name = document.getElementById('create-sub-name').value.trim();
      const isPrivate = document.getElementById('create-sub-private').checked;
      if (!name) return;
      this.socket.emit('create-sub-channel', {
        parentCode: modal._parentCode,
        name,
        isPrivate
      });
      modal.style.display = 'none';
    });
    document.getElementById('create-sub-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('create-sub-modal').style.display = 'none';
    });
    document.getElementById('create-sub-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    // Rename channel / sub-channel
    document.querySelector('[data-action="rename-channel"]')?.addEventListener('click', () => {
      const code = this._ctxMenuChannel;
      if (!code) return;
      this._closeChannelCtxMenu();
      const ch = this.channels.find(c => c.code === code);
      if (!ch) return;
      const name = prompt(`Rename #${ch.name}:\nEnter new name:`, ch.name);
      if (name && name.trim() && name.trim() !== ch.name) {
        this.socket.emit('rename-channel', { code, name: name.trim() });
      }
    });
    // Close context menu on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.channel-ctx-menu') && !e.target.closest('.channel-more-btn')) {
        this._closeChannelCtxMenu();
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
    document.getElementById('voice-leave-sidebar-btn').addEventListener('click', () => this._leaveVoice());
    document.getElementById('screen-share-btn').addEventListener('click', () => this._toggleScreenShare());
    document.getElementById('screen-share-minimize').addEventListener('click', () => this._hideScreenShare());
    document.getElementById('screen-share-close').addEventListener('click', () => this._closeScreenShare());

    // Music controls
    document.getElementById('music-share-btn').addEventListener('click', () => this._openMusicModal());
    document.getElementById('share-music-btn').addEventListener('click', () => this._shareMusic());
    document.getElementById('cancel-music-btn').addEventListener('click', () => this._closeMusicModal());
    document.getElementById('music-modal').addEventListener('click', (e) => {
      if (e.target.id === 'music-modal') this._closeMusicModal();
    });
    document.getElementById('music-stop-btn').addEventListener('click', () => this._stopMusic());
    document.getElementById('music-close-btn').addEventListener('click', () => {
      this._minimizeMusicPanel();
    });
    document.getElementById('music-popout-btn').addEventListener('click', () => this._popOutMusicPlayer());
    document.getElementById('music-play-pause-btn').addEventListener('click', () => this._toggleMusicPlayPause());
    document.getElementById('music-prev-btn').addEventListener('click', () => this._musicTrackControl('prev'));
    document.getElementById('music-next-btn').addEventListener('click', () => this._musicTrackControl('next'));
    document.getElementById('music-shuffle-btn').addEventListener('click', () => this._musicTrackControl('shuffle'));
    document.getElementById('music-mute-btn').addEventListener('click', () => this._toggleMusicMute());
    document.getElementById('music-volume-slider').addEventListener('input', (e) => {
      this._setMusicVolume(parseInt(e.target.value));
    });
    // Seek slider — user drags to scrub position
    const seekSlider = document.getElementById('music-seek-slider');
    seekSlider.addEventListener('input', () => { this._musicSeeking = true; });
    seekSlider.addEventListener('change', (e) => {
      this._musicSeeking = false;
      const pct = parseFloat(e.target.value);
      this._seekMusic(pct);
      // Broadcast seek to others in voice
      if (this.voice && this.voice.inVoice) {
        this.socket.emit('music-seek', {
          code: this.voice.currentChannel,
          position: pct
        });
      }
    });
    document.getElementById('music-link-input').addEventListener('input', (e) => {
      this._previewMusicLink(e.target.value.trim());
    });
    document.getElementById('music-link-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._shareMusic(); }
    });

    // Voice controls — now pinned at bottom of right sidebar
    // The header voice-active-indicator opens the RIGHT sidebar on mobile
    document.getElementById('voice-active-indicator')?.addEventListener('click', (e) => {
      e.stopPropagation();
      // On mobile, open the RIGHT sidebar so the user can access voice controls
      const appBody = document.getElementById('app-body');
      if (window.innerWidth <= 900 && appBody) {
        appBody.classList.add('mobile-right-open');
      }
    });

    // Voice settings slide-up toggle
    document.getElementById('voice-settings-toggle')?.addEventListener('click', () => {
      const panel = document.getElementById('voice-settings-panel');
      if (!panel) return;
      const btn = document.getElementById('voice-settings-toggle');
      if (panel.style.display === 'none') {
        panel.style.display = '';
        if (btn) btn.classList.add('active');
      } else {
        panel.style.display = 'none';
        if (btn) btn.classList.remove('active');
      }
    });
    // Stream size slider
    const streamSizeSlider = document.getElementById('stream-size-slider');
    if (streamSizeSlider) {
      const savedSize = localStorage.getItem('haven_stream_size');
      if (savedSize) streamSizeSlider.value = savedSize;
      let _resizeRAF = null;
      const applySize = () => {
        if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
        _resizeRAF = requestAnimationFrame(() => {
          // Auto-exit fullscreen (focus mode) when user adjusts the size slider
          const container = document.getElementById('screen-share-container');
          const grid = document.getElementById('screen-share-grid');
          if (container.classList.contains('stream-focus-mode')) {
            grid.querySelectorAll('.screen-share-tile').forEach(t => t.classList.remove('stream-focused'));
            container.classList.remove('stream-focus-mode');
          }
          const vh = parseInt(streamSizeSlider.value, 10);
          container.style.maxHeight = vh + 'vh';
          grid.style.maxHeight = (vh - 2) + 'vh';
          document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
          localStorage.setItem('haven_stream_size', vh);
          _resizeRAF = null;
        });
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
    // Wire up screen share audio callback
    this.voice.onScreenAudio = (userId) => this._handleScreenAudio(userId);
    // Wire up no-audio indicator for streams without audio
    this.voice.onScreenNoAudio = (userId) => this._handleScreenNoAudio(userId);

    // Wire up voice join/leave audio cues
    this.voice.onVoiceJoin = (userId, username) => {
      this.notifications.playDirect('voice_join');
    };
    this.voice.onVoiceLeave = (userId, username) => {
      this.notifications.playDirect('voice_leave');
    };
    // Wire up screen share start audio cue
    this.voice.onScreenShareStarted = (userId, username) => {
      this.notifications.playDirect('stream_start');
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

    // E2E verification code button
    document.getElementById('e2e-verify-btn')?.addEventListener('click', () => this._showE2EVerification());

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

    // ── Games / Activities system ─────────────────────────────
    // Registry of available games — add new games here
    this._gamesRegistry = [
      { id: 'flappy', name: 'Shippy Container', icon: '🚢', path: '/games/flappy.html', description: 'Dodge containers, chase high scores!' },
      { id: 'flight', name: 'Flight', icon: '✈️', path: '/games/flash.html?swf=/games/roms/flight-759879f9.swf&title=Flight', description: 'Throw a paper plane as far as you can!', type: 'flash' },
      { id: 'learn-to-fly-3', name: 'Learn to Fly 3', icon: '🐧', path: '/games/flash.html?swf=/games/roms/learn-to-fly-3.swf&title=Learn%20to%20Fly%203', description: 'Help a penguin learn to fly!', type: 'flash' },
      { id: 'bubble-tanks-3', name: 'Bubble Tanks 3', icon: '🫧', path: '/games/flash.html?swf=/games/roms/Bubble%20Tanks%203.swf&title=Bubble%20Tanks%203', description: 'Bubble-based arena shooter', type: 'flash' },
      { id: 'tanks', name: 'Tanks', icon: '🪖', path: '/games/flash.html?swf=/games/roms/tanks.swf&title=Tanks', description: 'Classic Armor Games tank combat', type: 'flash' },
      { id: 'super-smash-flash-2', name: 'Super Smash Flash 2', icon: '⚔️', path: '/games/flash.html?swf=/games/roms/SuperSmash.swf&title=Super%20Smash%20Flash%202', description: 'Fan-made Smash Bros platformer fighter', type: 'flash' },
      { id: 'io-games', name: '.io Games', icon: '🌐', path: '/games/io-games.html', description: 'Browse popular .io multiplayer games', type: 'browser' },
    ];

    // Generic postMessage bridge for any game (scores + leaderboard)
    if (!this._gameScoreListenerAdded) {
      window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return;
        // Handle score submissions: { type: '<gameId>-score', score: N } or { type: 'game-score', game: '<id>', score: N }
        if (e.data && typeof e.data.score === 'number') {
          let gameId = null;
          if (e.data.type === 'game-score' && e.data.game) {
            gameId = e.data.game;
          } else if (typeof e.data.type === 'string' && e.data.type.endsWith('-score')) {
            gameId = e.data.type.replace(/-score$/, '');
          }
          if (gameId && /^[a-z0-9_-]{1,32}$/.test(gameId)) {
            this.socket.emit('submit-high-score', { game: gameId, score: e.data.score });
          }
        }
        // Handle leaderboard requests from game iframes/windows
        if (e.data && e.data.type === 'get-leaderboard') {
          const gid = e.data.game || 'flappy';
          const scores = this.highScores?.[gid] || [];
          const target = e.source || (this._gameIframe?.contentWindow);
          try { target?.postMessage({ type: 'leaderboard-data', leaderboard: scores }, e.origin); } catch {}
        }
      });
      this._gameScoreListenerAdded = true;
    }

    // Activities button → open launcher modal
    document.getElementById('activities-btn')?.addEventListener('click', () => this._openActivitiesModal());

    // Close activities modal
    document.getElementById('close-activities-btn')?.addEventListener('click', () => this._closeActivitiesModal());
    document.getElementById('activities-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'activities-modal') this._closeActivitiesModal();
    });

    // Game iframe controls
    document.getElementById('game-iframe-close')?.addEventListener('click', () => this._closeGameIframe());
    document.getElementById('game-iframe-popout')?.addEventListener('click', () => this._popoutGame());

    // Game volume slider — forward volume changes into the game iframe
    const gameVolSlider = document.getElementById('game-volume-slider');
    const gameVolPct = document.getElementById('game-volume-pct');
    if (gameVolSlider) {
      gameVolSlider.addEventListener('input', () => {
        const val = parseInt(gameVolSlider.value);
        if (gameVolPct) gameVolPct.textContent = val + '%';
        // Post volume message into the game iframe
        try {
          const iframe = document.getElementById('game-iframe');
          if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'set-volume', volume: val / 100 }, window.location.origin);
          }
        } catch {}
      });
    }

    // Image click — open lightbox overlay (CSP-safe — no inline handlers)
    document.getElementById('messages').addEventListener('click', (e) => {
      if (e.target.classList.contains('chat-image')) {
        this._openLightbox(e.target.src);
      }
      // Spoiler reveal toggle
      if (e.target.closest('.spoiler')) {
        e.target.closest('.spoiler').classList.toggle('revealed');
      }
    });

    // Reply banner click — scroll to the original message
    document.getElementById('messages').addEventListener('click', (e) => {
      const banner = e.target.closest('.reply-banner');
      if (!banner) return;
      const replyMsgId = banner.dataset.replyMsgId;
      if (!replyMsgId) return;
      const targetMsg = document.querySelector(`[data-msg-id="${replyMsgId}"]`);
      if (targetMsg) {
        targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetMsg.classList.add('highlight-flash');
        setTimeout(() => targetMsg.classList.remove('highlight-flash'), 2000);
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
      // Populate bio
      const bioInput = document.getElementById('edit-profile-bio');
      if (bioInput) bioInput.value = this.user.bio || '';
      this._updateAvatarPreview();
      // Sync shape picker buttons
      const picker = document.getElementById('avatar-shape-picker');
      if (picker) {
        const currentShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
        picker.querySelectorAll('.avatar-shape-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.shape === currentShape);
        });
        this._pendingAvatarShape = currentShape;
      }
    });

    // ── Profile popup: click on message author name or avatar ──
    document.getElementById('messages').addEventListener('click', (e) => {
      const author = e.target.closest('.message-author');
      const avatar = e.target.closest('.message-avatar, .message-avatar-img');
      if (!author && !avatar) return;
      // Don't trigger if clicking toolbar buttons
      if (e.target.closest('.msg-toolbar')) return;
      const msgEl = e.target.closest('.message, .message-compact');
      if (!msgEl) return;
      const userId = parseInt(msgEl.dataset.userId);
      if (!isNaN(userId)) {
        this._profilePopupAnchor = e.target;
        this.socket.emit('get-user-profile', { userId });
      }
    });

    // ── Profile popup: click on user item in sidebar ──
    document.getElementById('online-users').addEventListener('click', (e) => {
      // Don't trigger for action buttons (DM, kick, etc.)
      if (e.target.closest('.user-action-btn') || e.target.closest('.user-admin-actions')) return;
      const userItem = e.target.closest('.user-item');
      if (!userItem) return;
      const userId = parseInt(userItem.dataset.userId);
      if (!isNaN(userId)) {
        this._profilePopupAnchor = userItem;
        this.socket.emit('get-user-profile', { userId });
      }
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
      this._snapshotAdminSettings();
      document.getElementById('settings-modal').style.display = 'flex';
      this._syncSettingsNav();
    });
    document.getElementById('mobile-settings-btn')?.addEventListener('click', () => {
      this._snapshotAdminSettings();
      document.getElementById('settings-modal').style.display = 'flex';
      this._syncSettingsNav();
      document.getElementById('app-body')?.classList.remove('mobile-sidebar-open');
      document.getElementById('mobile-overlay')?.classList.remove('active');
    });
    document.getElementById('close-settings-btn').addEventListener('click', () => {
      this._cancelAdminSettings();
    });
    document.getElementById('settings-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._cancelAdminSettings();
    });
    document.getElementById('admin-save-btn')?.addEventListener('click', () => {
      this._saveAdminSettings();
    });

    // ── Settings nav click-to-scroll ─────────────────────
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const targetId = item.dataset.target;
        const target = document.getElementById(targetId);
        if (!target) return;
        // Scroll into view within the settings body
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Update active state
        document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
      });
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

        // Re-wrap E2E private key with the account secret to ensure
        // the server backup stays fresh (also migrates any old password-wrapped keys)
        if (this.e2e && this.e2e.ready && this.user.e2eSecret) {
          try {
            await this.e2e.reWrapKey(this.socket, this.user.e2eSecret);
          } catch (err) {
            console.warn('[E2E] Failed to re-wrap key:', err);
          }
        }

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

    // Member visibility select (admin) — saved via admin Save button

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

    // ── Cleanup controls (admin) — saved via admin Save button ──
    const cleanupAge = document.getElementById('cleanup-max-age');
    if (cleanupAge) {
      cleanupAge.addEventListener('change', () => {
        const val = Math.max(0, Math.min(3650, parseInt(cleanupAge.value) || 0));
        cleanupAge.value = val;
      });
    }
    const cleanupSize = document.getElementById('cleanup-max-size');
    if (cleanupSize) {
      cleanupSize.addEventListener('change', () => {
        const val = Math.max(0, Math.min(100000, parseInt(cleanupSize.value) || 0));
        cleanupSize.value = val;
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
    // Whitelist toggle — saved via admin Save button

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

    // ── Tunnel settings (immediate — not part of Save flow) ──
    const tunnelToggleBtn = document.getElementById('tunnel-toggle-btn');
    if (tunnelToggleBtn) {
      tunnelToggleBtn.addEventListener('click', () => {
        // Determine desired state from button text
        const wantStart = tunnelToggleBtn.textContent.trim().startsWith('Start');
        this.socket.emit('update-server-setting', {
          key: 'tunnel_enabled',
          value: wantStart ? 'true' : 'false'
        });
        this._syncTunnelState(wantStart);
      });
    }

    const tunnelProvEl = document.getElementById('tunnel-provider-select');
    if (tunnelProvEl) {
      tunnelProvEl.addEventListener('change', () => {
        this.socket.emit('update-server-setting', {
          key: 'tunnel_provider',
          value: tunnelProvEl.value
        });
      });
    }

    // ── Server invite code (immediate — not part of Save flow) ──
    document.getElementById('generate-server-code-btn')?.addEventListener('click', () => {
      this.socket.emit('generate-server-code');
    });
    document.getElementById('clear-server-code-btn')?.addEventListener('click', () => {
      if (!confirm('Clear the server invite code? Anyone with the old code won\'t be able to use it.')) return;
      this.socket.emit('clear-server-code');
    });
    document.getElementById('copy-server-code-btn')?.addEventListener('click', () => {
      const code = document.getElementById('server-code-value')?.textContent;
      if (code && code !== '—') {
        navigator.clipboard.writeText(code).then(() => this._showToast('Server code copied!', 'success'));
      }
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
      this._editingServerUrl = null;
      document.getElementById('add-server-modal-title').textContent = 'Add a Server';
      document.getElementById('add-server-modal').style.display = 'flex';
      document.getElementById('add-server-name-input').value = '';
      document.getElementById('server-url-input').value = '';
      document.getElementById('server-url-input').disabled = false;
      document.getElementById('add-server-icon-input').value = '';
      document.getElementById('save-server-btn').textContent = 'Add Server';
      document.getElementById('add-server-name-input').focus();
    });

    document.getElementById('cancel-server-btn').addEventListener('click', () => {
      document.getElementById('add-server-modal').style.display = 'none';
      document.getElementById('server-url-input').disabled = false;
      this._editingServerUrl = null;
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

    // ── Manage Servers gear button & modal ──────────────
    document.getElementById('manage-servers-btn')?.addEventListener('click', () => {
      this._openManageServersModal();
    });
    document.getElementById('manage-servers-close-btn')?.addEventListener('click', () => {
      document.getElementById('manage-servers-modal').style.display = 'none';
    });
    document.getElementById('manage-servers-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    document.getElementById('manage-servers-add-btn')?.addEventListener('click', () => {
      document.getElementById('manage-servers-modal').style.display = 'none';
      document.getElementById('add-server-btn').click();
    });

    // ── Channel Code Settings Modal ─────────────────────
    document.getElementById('channel-code-settings-btn')?.addEventListener('click', () => {
      if (!this.currentChannel || !this.user.isAdmin) return;
      const channel = this.channels.find(c => c.code === this.currentChannel);
      if (!channel || channel.is_dm) return;

      document.getElementById('code-settings-channel-name').textContent = `# ${channel.name}`;
      document.getElementById('code-visibility-select').value = channel.code_visibility || 'public';
      document.getElementById('code-mode-select').value = channel.code_mode || 'static';
      document.getElementById('code-rotation-type-select').value = channel.code_rotation_type || 'time';
      document.getElementById('code-rotation-interval').value = channel.code_rotation_interval || 60;

      this._toggleCodeRotationFields();
      document.getElementById('code-settings-modal').style.display = 'flex';
    });

    document.getElementById('code-mode-select')?.addEventListener('change', () => this._toggleCodeRotationFields());
    document.getElementById('code-rotation-type-select')?.addEventListener('change', () => {
      const type = document.getElementById('code-rotation-type-select').value;
      const label = document.getElementById('rotation-interval-label');
      if (label) label.textContent = type === 'time' ? 'Rotation Interval (minutes)' : 'Rotate After X Joins';
    });

    document.getElementById('code-settings-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('code-settings-modal').style.display = 'none';
    });

    document.getElementById('code-settings-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    document.getElementById('code-settings-save-btn')?.addEventListener('click', () => {
      const channel = this.channels.find(c => c.code === this.currentChannel);
      if (!channel) return;

      this.socket.emit('update-channel-code-settings', {
        channelId: channel.id,
        code_visibility: document.getElementById('code-visibility-select').value,
        code_mode: document.getElementById('code-mode-select').value,
        code_rotation_type: document.getElementById('code-rotation-type-select').value,
        code_rotation_interval: parseInt(document.getElementById('code-rotation-interval').value) || 60
      });

      document.getElementById('code-settings-modal').style.display = 'none';
    });

    document.getElementById('code-rotate-now-btn')?.addEventListener('click', () => {
      const channel = this.channels.find(c => c.code === this.currentChannel);
      if (!channel) return;

      if (!confirm('Rotate the channel code now? Current code will become invalid.')) return;
      this.socket.emit('rotate-channel-code', { channelId: channel.id });
      document.getElementById('code-settings-modal').style.display = 'none';
    });
  }

  _toggleCodeRotationFields() {
    const isDynamic = document.getElementById('code-mode-select').value === 'dynamic';
    document.getElementById('rotation-type-group').style.display = isDynamic ? '' : 'none';
    document.getElementById('rotation-interval-group').style.display = isDynamic ? '' : 'none';
    // Update interval label based on rotation type
    const type = document.getElementById('code-rotation-type-select').value;
    const label = document.getElementById('rotation-interval-label');
    if (label) label.textContent = type === 'time' ? 'Rotation Interval (minutes)' : 'Rotate After X Joins';
  }

  _addServer() {
    const name = document.getElementById('add-server-name-input').value.trim();
    const url = document.getElementById('server-url-input').value.trim();
    const iconInput = document.getElementById('add-server-icon-input').value.trim();
    const autoPull = document.getElementById('server-auto-icon').checked;
    if (!name || !url) return this._showToast('Name and address are both required', 'error');

    const editUrl = this._editingServerUrl;
    if (editUrl) {
      // Editing existing server
      this.serverManager.update(editUrl, { name, icon: iconInput || null });
      this._editingServerUrl = null;
      document.getElementById('add-server-modal').style.display = 'none';
      this._renderServerBar();
      this._showToast(`Updated "${name}"`, 'success');
      // Auto-pull icon if checked
      if (autoPull) this._autoPullServerIcon(editUrl);
    } else {
      // Adding new server
      const icon = iconInput || null;
      if (this.serverManager.add(name, url, icon)) {
        document.getElementById('add-server-modal').style.display = 'none';
        this._renderServerBar();
        this._showToast(`Added "${name}"`, 'success');
        // Auto-pull icon after health check completes
        if (autoPull) {
          const cleanUrl = url.replace(/\/+$/, '');
          const finalUrl = /^https?:\/\//.test(cleanUrl) ? cleanUrl : 'https://' + cleanUrl;
          setTimeout(() => this._autoPullServerIcon(finalUrl), 2000);
        }
      } else {
        this._showToast('Server already in your list', 'error');
      }
    }
  }

  _autoPullServerIcon(url) {
    const status = this.serverManager.statusCache.get(url);
    if (status && status.icon) {
      this.serverManager.update(url, { icon: status.icon });
      this._renderServerBar();
    }
  }

  _editServer(url) {
    const server = this.serverManager.servers.find(s => s.url === url);
    if (!server) return;
    this._editingServerUrl = url;
    document.getElementById('add-server-modal-title').textContent = 'Edit Server';
    document.getElementById('add-server-name-input').value = server.name;
    document.getElementById('server-url-input').value = server.url;
    document.getElementById('server-url-input').disabled = true;
    document.getElementById('add-server-icon-input').value = server.icon || '';
    document.getElementById('save-server-btn').textContent = 'Save';
    document.getElementById('add-server-modal').style.display = 'flex';
    document.getElementById('add-server-name-input').focus();
  }

  _openManageServersModal() {
    this._renderManageServersList();
    document.getElementById('manage-servers-modal').style.display = 'flex';
  }

  _renderManageServersList() {
    const container = document.getElementById('manage-servers-list');
    const servers = this.serverManager.getAll();
    container.innerHTML = '';
    if (servers.length === 0) return;  // CSS :empty handles empty state

    servers.forEach(s => {
      const row = document.createElement('div');
      row.className = 'manage-server-row';

      const online = s.status.online;
      const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
      const statusText = online === true ? 'Online' : online === false ? 'Offline' : 'Checking...';
      const initial = s.name.charAt(0).toUpperCase();
      const iconUrl = s.icon || (s.status.icon || null);
      const iconContent = iconUrl
        ? `<img src="${this._escapeHtml(iconUrl)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
        : initial;

      row.innerHTML = `
        <div class="manage-server-icon">${iconContent}</div>
        <div class="manage-server-info">
          <div class="manage-server-name">${this._escapeHtml(s.name)}</div>
          <div class="manage-server-url">${this._escapeHtml(s.url)}</div>
        </div>
        <span class="manage-server-status ${statusClass}">${statusText}</span>
        <div class="manage-server-actions">
          <button class="manage-server-visit" title="Open in new tab">🔗</button>
          <button class="manage-server-edit" title="Edit server">✏️</button>
          <button class="manage-server-delete danger-action" title="Remove server">🗑️</button>
        </div>
      `;

      row.querySelector('.manage-server-visit').addEventListener('click', () => {
        window.open(s.url, '_blank', 'noopener');
      });
      row.querySelector('.manage-server-edit').addEventListener('click', () => {
        document.getElementById('manage-servers-modal').style.display = 'none';
        this._editServer(s.url);
      });
      row.querySelector('.manage-server-delete').addEventListener('click', () => {
        if (!confirm(`Remove "${s.name}" from your server list?`)) return;
        this.serverManager.remove(s.url);
        this._renderServerBar();
        this._renderManageServersList();
        this._showToast(`Removed "${s.name}"`, 'success');
      });

      container.appendChild(row);
    });
  }

  _renderServerBar() {
    const list = document.getElementById('server-list');
    const servers = this.serverManager.getAll();

    list.innerHTML = servers.map(s => {
      const initial = s.name.charAt(0).toUpperCase();
      const online = s.status.online;
      const statusClass = online === true ? 'online' : online === false ? 'offline' : 'unknown';
      const statusText = online === true ? '● Online' : online === false ? '○ Offline' : '◌ Checking...';
      // Use custom icon, auto-pulled icon from health check, or letter initial
      const iconUrl = s.icon || (s.status.icon || null);
      const iconContent = iconUrl
        ? `<img src="${this._escapeHtml(iconUrl)}" class="server-icon-img" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="server-icon-text" style="display:none">${initial}</span>`
        : `<span class="server-icon-text">${initial}</span>`;
      return `
        <div class="server-icon remote" data-url="${this._escapeHtml(s.url)}"
             title="${this._escapeHtml(s.name)} — ${statusText}">
          ${iconContent}
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
      // Right-click to edit
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._editServer(el.dataset.url);
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
      if (!fileInput.files[0]) return;
      const file = fileInput.files[0];
      if (file.type.startsWith('image/')) {
        this._queueImage(file);
      } else {
        this._uploadGeneralFile(file);
      }
      fileInput.value = '';
    });

    // Paste from clipboard — images get queued, other files go to general upload
    document.getElementById('message-input').addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          this._queueImage(item.getAsFile());
          return;
        }
        if (item.kind === 'file') {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) this._uploadGeneralFile(file);
          return;
        }
      }
    });

    // Drag & drop — QUEUE instead of uploading immediately
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
      if (!file) return;
      if (file.type.startsWith('image/')) {
        this._queueImage(file);
      } else {
        this._uploadGeneralFile(file);
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

    // Close buttons inside panels
    document.getElementById('mobile-sidebar-close')?.addEventListener('click', () => this._closeMobilePanels());
    document.getElementById('mobile-right-close')?.addEventListener('click', () => this._closeMobilePanels());

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

    // ── Long-press to show message toolbar on mobile ──
    const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (isTouchDevice) {
      const messagesEl = document.getElementById('messages');
      let longPressTimer = null;
      let longPressTriggered = false;

      messagesEl.addEventListener('touchstart', (e) => {
        // Don't interfere with toolbar buttons, links, images, reactions, spoilers
        if (e.target.closest('.msg-toolbar') || e.target.closest('a') ||
            e.target.closest('img') || e.target.closest('.reaction-badge') ||
            e.target.closest('.spoiler') || e.target.closest('.reply-banner')) return;

        longPressTriggered = false;
        const msgEl = e.target.closest('.message, .message-compact');

        longPressTimer = setTimeout(() => {
          longPressTriggered = true;
          // Deselect any previously selected message
          messagesEl.querySelectorAll('.msg-selected').forEach(el => el.classList.remove('msg-selected'));
          if (msgEl) {
            msgEl.classList.add('msg-selected');
            // Haptic feedback if available
            if (navigator.vibrate) navigator.vibrate(30);
          }
        }, 500);
      }, { passive: true });

      // Cancel long-press if finger moves (scrolling)
      messagesEl.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }, { passive: true });

      messagesEl.addEventListener('touchend', (e) => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        if (longPressTriggered) {
          // Prevent the synthesised click from firing after a long-press
          e.preventDefault();
          longPressTriggered = false;
        }
      }, { passive: false });

      // Normal tap anywhere in messages: dismiss any open toolbar
      messagesEl.addEventListener('click', (e) => {
        // Let toolbar button taps through — handled by data-action handler
        if (e.target.closest('.msg-toolbar')) return;
        // Let interactive elements through
        if (e.target.closest('a') || e.target.closest('img') ||
            e.target.closest('.reaction-badge') || e.target.closest('.spoiler') ||
            e.target.closest('.reply-banner')) return;
        // Dismiss any open toolbar on normal tap
        messagesEl.querySelectorAll('.msg-selected').forEach(el => el.classList.remove('msg-selected'));
      });

      // Deselect when tapping input area
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

  /* ── Mobile App Bridge (Capacitor shell ↔ Haven) ───── */

  _setupMobileBridge() {
    // Only activate when running inside the mobile app's iframe
    this._isMobileApp = (window !== window.top);
    if (!this._isMobileApp) return;

    // Add a body class so CSS can adapt for mobile-app context
    document.body.classList.add('haven-mobile-app');

    // Listen for messages from the Capacitor shell
    window.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || typeof data.type !== 'string') return;

      switch (data.type) {
        case 'haven:back':
          this._handleMobileBack();
          break;

        case 'haven:fcm-token':
          // Receive FCM token from native layer → send to server
          if (data.token && this.socket?.connected) {
            this.socket.emit('register-fcm-token', { token: data.token });
          }
          this._fcmToken = data.token;
          break;

        case 'haven:mobile-init':
          // Shell confirms we're in mobile app
          this._mobilePlatform = data.platform || 'unknown';
          break;

        case 'haven:push-received':
          // In-app push notification received while app is open
          if (data.notification) {
            const n = data.notification;
            const title = n.title || 'Haven';
            const body = n.body || '';
            this._showToast(`${title}: ${body}`, 'info');
          }
          break;

        case 'haven:push-action':
          // User tapped a push notification → switch to that channel
          if (data.data?.channelCode) {
            this.switchChannel(data.data.channelCode);
          }
          break;

        case 'haven:resume':
          // App returned to foreground — reconnect socket if needed
          if (this.socket && !this.socket.connected) {
            this.socket.connect();
          }
          break;

        case 'haven:keyboard':
          // Keyboard visibility changed
          if (data.visible) {
            document.body.classList.add('native-keyboard-open');
          } else {
            document.body.classList.remove('native-keyboard-open');
          }
          break;
      }
    });

    // Notify the shell that Haven is loaded and ready
    this._postToShell({ type: 'haven:ready' });

    // If user logs out, tell the shell
    const origLogout = this._logout?.bind(this);
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        this._postToShell({ type: 'haven:disconnect' });
      }, { capture: true });
    }

    // Send theme color to shell so status bar can match
    this._reportThemeColor();

    // Watch for theme changes and re-report
    const themeObs = new MutationObserver(() => {
      setTimeout(() => this._reportThemeColor(), 100);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  _postToShell(msg) {
    if (!this._isMobileApp) return;
    try { window.parent.postMessage(msg, '*'); } catch (_) {}
  }

  _handleMobileBack() {
    // Priority order: close the most "on-top" UI element first

    // 1. Any open modal overlays
    const openModals = document.querySelectorAll('.modal-overlay');
    for (const m of openModals) {
      if (m.style.display && m.style.display !== 'none') {
        m.style.display = 'none';
        return;
      }
    }

    // 2. Search container / results
    const search = document.getElementById('search-container');
    if (search && search.style.display !== 'none' && search.style.display !== '') {
      search.style.display = 'none';
      document.getElementById('search-results-panel').style.display = 'none';
      return;
    }

    // 3. Theme popup
    const themePopup = document.getElementById('theme-popup');
    if (themePopup && themePopup.style.display !== 'none' && themePopup.style.display !== '') {
      themePopup.style.display = 'none';
      return;
    }

    // 4. Voice settings panel
    const voicePanel = document.getElementById('voice-settings-panel');
    if (voicePanel && voicePanel.classList.contains('open')) {
      voicePanel.classList.remove('open');
      return;
    }

    // 5. Mobile sidebars (left or right)
    const appBody = document.getElementById('app-body');
    if (appBody.classList.contains('mobile-sidebar-open') || appBody.classList.contains('mobile-right-open')) {
      this._closeMobilePanels();
      return;
    }

    // 6. GIF picker
    const gifPanel = document.getElementById('gif-panel');
    if (gifPanel && gifPanel.style.display !== 'none' && gifPanel.style.display !== '') {
      gifPanel.style.display = 'none';
      return;
    }

    // 7. Emoji picker
    const emojiPicker = document.querySelector('emoji-picker');
    if (emojiPicker && emojiPicker.style.display !== 'none' && emojiPicker.style.display !== '') {
      emojiPicker.style.display = 'none';
      return;
    }

    // Nothing to close — tell shell
    this._postToShell({ type: 'haven:back-exhausted' });
  }

  _reportThemeColor() {
    if (!this._isMobileApp) return;
    // Read the computed background of the top bar or body
    const topBar = document.querySelector('.top-bar') || document.querySelector('.sidebar');
    if (topBar) {
      const bg = getComputedStyle(topBar).backgroundColor;
      // Convert rgb(r,g,b) → hex
      const match = bg.match(/(\d+)/g);
      if (match && match.length >= 3) {
        const hex = '#' + match.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
        this._postToShell({ type: 'haven:theme-color', color: hex });
      }
    }
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
    // Save bio
    const bioInput = document.getElementById('edit-profile-bio');
    if (bioInput) {
      this.socket.emit('set-bio', { bio: bioInput.value });
    }
    // Also commit any pending avatar changes
    this._commitAvatarSettings();
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

  // ── Image Queue (paste/drop → preview → send on Enter) ──

  _queueImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) {
      return this._showToast('Image too large (max 5 MB)', 'error');
    }
    if (!this._imageQueue) this._imageQueue = [];
    if (this._imageQueue.length >= 5) {
      return this._showToast('Max 5 images at once', 'error');
    }
    this._imageQueue.push(file);
    this._renderImageQueue();
    document.getElementById('message-input').focus();
  }

  _renderImageQueue() {
    const bar = document.getElementById('image-queue-bar');
    if (!bar) return;
    if (!this._imageQueue || this._imageQueue.length === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = '';
    this._imageQueue.forEach((file, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'image-queue-thumb';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-queue-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        this._imageQueue.splice(idx, 1);
        this._renderImageQueue();
      });
      thumb.appendChild(img);
      thumb.appendChild(removeBtn);
      bar.appendChild(thumb);
    });
    // Add a "clear all" button if multiple
    if (this._imageQueue.length > 1) {
      const clearAll = document.createElement('button');
      clearAll.className = 'image-queue-clear-all';
      clearAll.textContent = 'Clear All';
      clearAll.addEventListener('click', () => this._clearImageQueue());
      bar.appendChild(clearAll);
    }
  }

  _clearImageQueue() {
    this._imageQueue = [];
    this._renderImageQueue();
  }

  async _flushImageQueue() {
    if (!this._imageQueue || this._imageQueue.length === 0) return;
    const files = [...this._imageQueue];
    this._clearImageQueue();
    for (const file of files) {
      await this._uploadImage(file);
    }
  }

  // ═══════════════════════════════════════════════════════
  // AVATAR / PFP CUSTOMIZER
  // ═══════════════════════════════════════════════════════

  _updateAvatarPreview() {
    const preview = document.getElementById('avatar-upload-preview');
    if (!preview) return;
    if (this.user.avatar) {
      preview.innerHTML = `<img src="${this._escapeHtml(this.user.avatar)}" alt="avatar">`;
    } else {
      const color = this._getUserColor(this.user.username);
      const initial = this.user.username.charAt(0).toUpperCase();
      preview.innerHTML = `<div style="background-color:${color};width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:white">${initial}</div>`;
    }
  }

  _setupAvatarUpload() {
    console.log('[Avatar Setup v6] Initializing with HTTP upload model...');
    if (this._avatarDelegationActive) return;
    this._avatarDelegationActive = true;

    // Pending state — nothing is saved until the user clicks Save
    this._pendingAvatarFile = null;       // raw File object from <input>
    this._pendingAvatarPreviewUrl = null; // local preview data URL (display only)
    this._pendingAvatarRemoved = false;   // user clicked Clear
    this._pendingAvatarShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
    this._avatarShape = this._pendingAvatarShape;

    // Initialize preview + shape buttons
    this._updateAvatarPreview();
    const picker = document.getElementById('avatar-shape-picker');
    if (picker) {
      picker.querySelectorAll('.avatar-shape-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.shape === this._pendingAvatarShape);
      });
    }

    // ── Delegated click handler ──
    document.addEventListener('click', (e) => {
      // Shape buttons
      const shapeBtn = e.target.closest('.avatar-shape-btn');
      if (shapeBtn) {
        e.preventDefault();
        const container = document.getElementById('avatar-shape-picker');
        if (container) container.querySelectorAll('.avatar-shape-btn').forEach(b => b.classList.remove('active'));
        shapeBtn.classList.add('active');
        this._pendingAvatarShape = shapeBtn.dataset.shape;
        this._markAvatarUnsaved();
        return;
      }

      // Upload button → trigger file picker
      if (e.target.closest('#avatar-upload-btn')) {
        e.preventDefault();
        e.stopPropagation();
        const fileInput = document.getElementById('avatar-file-input');
        if (fileInput) { fileInput.value = ''; fileInput.click(); }
        return;
      }

      // Clear/Remove button
      if (e.target.closest('#avatar-remove-btn')) {
        e.preventDefault();
        this._pendingAvatarFile = null;
        this._pendingAvatarPreviewUrl = null;
        this._pendingAvatarRemoved = true;
        const preview = document.getElementById('avatar-upload-preview');
        if (preview) {
          const color = this._getUserColor(this.user.username);
          const initial = this.user.username.charAt(0).toUpperCase();
          preview.innerHTML = `<div style="background-color:${color};width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:white">${initial}</div>`;
        }
        this._markAvatarUnsaved();
        return;
      }

      // Save button
      if (e.target.closest('#avatar-save-btn')) {
        e.preventDefault();
        this._commitAvatarSettings();
        return;
      }
    });

    // File input change → stage the file, show local preview
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'avatar-file-input') {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return this._showToast('Image too large (max 5 MB)', 'error');
        if (!file.type.startsWith('image/')) return this._showToast('Not an image file', 'error');

        this._pendingAvatarFile = file;
        this._pendingAvatarRemoved = false;

        // Show local preview immediately (not sent to server yet)
        const reader = new FileReader();
        reader.onload = (ev) => {
          this._pendingAvatarPreviewUrl = ev.target.result;
          const preview = document.getElementById('avatar-upload-preview');
          if (preview) preview.innerHTML = `<img src="${ev.target.result}" alt="avatar preview">`;
          this._markAvatarUnsaved();
        };
        reader.readAsDataURL(file);
      }
    });

    console.log('[Avatar Setup v6] Ready.');
  }

  _markAvatarUnsaved() {
    const status = document.getElementById('avatar-save-status');
    if (status) { status.textContent = 'Unsaved changes'; status.style.color = 'var(--warning, orange)'; }
  }

  // Commit pending avatar + shape to the server via HTTP (not socket!)
  async _commitAvatarSettings() {
    const status = document.getElementById('avatar-save-status');
    if (status) { status.textContent = 'Saving...'; status.style.color = 'var(--text-secondary)'; }

    try {
      // 1. Upload avatar image via HTTP if a new file was chosen
      if (this._pendingAvatarFile) {
        const formData = new FormData();
        formData.append('avatar', this._pendingAvatarFile);
        const resp = await fetch('/api/upload-avatar', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Upload failed');

        // Server stored the file and returned the URL path
        this.user.avatar = data.url;
        localStorage.setItem('haven_user', JSON.stringify(this.user));
        this._pendingAvatarFile = null;
        this._pendingAvatarPreviewUrl = null;
        
        // Update preview to use the server URL
        const preview = document.getElementById('avatar-upload-preview');
        if (preview) preview.innerHTML = `<img src="${data.url}" alt="avatar">`;
        
        // Notify connected sockets about the avatar change (small URL, not data URL)
        if (this.socket) this.socket.emit('set-avatar', { url: data.url });
      }

      // 2. Remove avatar if Clear was clicked
      if (this._pendingAvatarRemoved) {
        const resp = await fetch('/api/remove-avatar', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        });
        if (!resp.ok) throw new Error('Failed to remove avatar');

        this.user.avatar = null;
        localStorage.setItem('haven_user', JSON.stringify(this.user));
        this._pendingAvatarRemoved = false;
        
        if (this.socket) this.socket.emit('set-avatar', { url: '' });
      }

      // 3. Save shape via HTTP
      if (this._pendingAvatarShape !== this._avatarShape) {
        const resp = await fetch('/api/set-avatar-shape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ shape: this._pendingAvatarShape })
        });
        if (!resp.ok) throw new Error('Failed to save shape');

        this._avatarShape = this._pendingAvatarShape;
        this.user.avatarShape = this._pendingAvatarShape;
        localStorage.setItem('haven_avatar_shape', this._pendingAvatarShape);
        localStorage.setItem('haven_user', JSON.stringify(this.user));
        
        if (this.socket) this.socket.emit('set-avatar-shape', { shape: this._pendingAvatarShape });
      }

      if (status) { status.textContent = '✅ Saved!'; status.style.color = 'var(--success, #6f6)'; }
      this._showToast('Avatar settings saved!', 'success');
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);

    } catch (err) {
      console.error('[Avatar] Save failed:', err);
      if (status) { status.textContent = '❌ ' + err.message; status.style.color = 'var(--danger, red)'; }
      this._showToast('Failed to save: ' + err.message, 'error');
    }
  }

  _applyAvatarShape() {
    // No-op: shapes are now per-user and rendered from server data per message.
    // This function is kept as a safe stub in case it's called elsewhere.
  }

  // ═══════════════════════════════════════════════════════
  // CUSTOM SOUND MANAGEMENT (Admin)
  // ═══════════════════════════════════════════════════════

  _setupSoundManagement() {
    // Open sound management modal
    const openBtn = document.getElementById('open-sound-manager-btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        document.getElementById('sound-modal').style.display = 'flex';
      });
    }
    // Close sound modal
    document.getElementById('close-sound-modal-btn')?.addEventListener('click', () => {
      document.getElementById('sound-modal').style.display = 'none';
    });
    document.getElementById('sound-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    const uploadBtn = document.getElementById('sound-upload-btn');
    const fileInput = document.getElementById('sound-file-input');
    const nameInput = document.getElementById('sound-name-input');
    if (!uploadBtn || !fileInput) return;

    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      const name = nameInput ? nameInput.value.trim() : '';
      if (!file) return this._showToast('Select an audio file', 'error');
      if (!name) return this._showToast('Enter a sound name', 'error');
      if (file.size > 1024 * 1024) return this._showToast('Sound file too large (max 1 MB)', 'error');

      const formData = new FormData();
      formData.append('sound', file);
      formData.append('name', name);

      try {
        this._showToast('Uploading sound...', 'info');
        const res = await fetch('/api/upload-sound', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        this._showToast(`Sound "${name}" uploaded!`, 'success');
        fileInput.value = '';
        nameInput.value = '';
        this._loadCustomSounds();
      } catch {
        this._showToast('Upload failed', 'error');
      }
    });

    // Load custom sounds on init
    this._loadCustomSounds();
  }

  async _loadCustomSounds() {
    try {
      const res = await fetch('/api/sounds', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      const sounds = data.sounds || [];
      this.customSounds = sounds; // [{name, url}]

      // Update all sound select dropdowns with custom sounds
      this._updateSoundSelects(sounds);

      // Render admin sound list
      this._renderSoundList(sounds);
    } catch { /* ignore */ }
  }

  _updateSoundSelects(sounds) {
    const selects = ['notif-msg-sound', 'notif-mention-sound'];
    selects.forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;

      // Remove old custom options
      sel.querySelectorAll('option[data-custom]').forEach(o => o.remove());
      sel.querySelectorAll('optgroup[data-custom-group]').forEach(o => o.remove());

      const noneOpt = sel.querySelector('option[value="none"]');

      // Add custom sounds optgroup
      if (sounds.length > 0) {
        const customGroup = document.createElement('optgroup');
        customGroup.label = '🎵 Custom';
        customGroup.dataset.customGroup = '1';
        sounds.forEach(s => {
          const opt = document.createElement('option');
          opt.value = `custom:${s.name}`;
          opt.textContent = s.name;
          opt.dataset.custom = '1';
          opt.dataset.url = s.url;
          customGroup.appendChild(opt);
        });
        sel.insertBefore(customGroup, noneOpt);
      }

      // Restore value
      const currentVal = sel.value;
      if (currentVal) sel.value = currentVal;
    });
  }

  _renderSoundList(sounds) {
    const list = document.getElementById('custom-sounds-list');
    if (!list) return;

    if (sounds.length === 0) {
      list.innerHTML = '<p class="muted-text">No custom sounds uploaded</p>';
      return;
    }

    list.innerHTML = sounds.map(s => `
      <div class="custom-sound-item">
        <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>
        <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="Preview">▶</button>
        <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="Delete">🗑️</button>
      </div>
    `).join('');

    // Preview buttons
    list.querySelectorAll('.sound-preview-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const audio = new Audio(btn.dataset.url);
        audio.volume = this.notifications.volume;
        audio.play().catch(() => {});
      });
    });

    // Delete buttons
    list.querySelectorAll('.sound-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        try {
          const res = await fetch(`/api/sounds/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${this.token}` }
          });
          if (res.ok) {
            this._showToast(`Sound "${name}" deleted`, 'success');
            this._loadCustomSounds();
          } else {
            this._showToast('Delete failed', 'error');
          }
        } catch {
          this._showToast('Delete failed', 'error');
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // CUSTOM EMOJI MANAGEMENT
  // ═══════════════════════════════════════════════════════

  _setupEmojiManagement() {
    // Open emoji management modal
    const openEmojiBtn = document.getElementById('open-emoji-manager-btn');
    if (openEmojiBtn) {
      openEmojiBtn.addEventListener('click', () => {
        document.getElementById('emoji-modal').style.display = 'flex';
      });
    }
    // Close emoji modal
    document.getElementById('close-emoji-modal-btn')?.addEventListener('click', () => {
      document.getElementById('emoji-modal').style.display = 'none';
    });
    document.getElementById('emoji-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    const uploadBtn = document.getElementById('emoji-upload-btn');
    const fileInput = document.getElementById('emoji-file-input');
    const nameInput = document.getElementById('emoji-name-input');
    if (!uploadBtn || !fileInput) return;

    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      const name = nameInput ? nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() : '';
      if (!file) return this._showToast('Select an image file', 'error');
      if (!name) return this._showToast('Enter an emoji name (lowercase, no spaces)', 'error');
      if (file.size > 256 * 1024) return this._showToast('Emoji file too large (max 256 KB)', 'error');

      const formData = new FormData();
      formData.append('emoji', file);
      formData.append('name', name);

      try {
        this._showToast('Uploading emoji...', 'info');
        const res = await fetch('/api/upload-emoji', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: formData
        });
        if (!res.ok) {
          let errMsg = `Upload failed (${res.status})`;
          try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
          return this._showToast(errMsg, 'error');
        }
        this._showToast(`Emoji :${name}: uploaded!`, 'success');
        fileInput.value = '';
        nameInput.value = '';
        this._loadCustomEmojis();
      } catch {
        this._showToast('Upload failed', 'error');
      }
    });

    this._loadCustomEmojis();
  }

  async _loadCustomEmojis() {
    try {
      const res = await fetch('/api/emojis', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      this.customEmojis = data.emojis || []; // [{name, url}]
      this._renderEmojiList(this.customEmojis);
    } catch { /* ignore */ }
  }

  _renderEmojiList(emojis) {
    const list = document.getElementById('custom-emojis-list');
    if (!list) return;

    if (emojis.length === 0) {
      list.innerHTML = '<p class="muted-text">No custom emojis uploaded</p>';
      return;
    }

    list.innerHTML = emojis.map(e => `
      <div class="custom-sound-item">
        <img src="${this._escapeHtml(e.url)}" alt=":${this._escapeHtml(e.name)}:" class="custom-emoji-preview" style="width:24px;height:24px;vertical-align:middle;margin-right:6px;">
        <span class="custom-sound-name">:${this._escapeHtml(e.name)}:</span>
        <button class="btn-xs emoji-delete-btn" data-name="${this._escapeHtml(e.name)}" title="Delete">🗑️</button>
      </div>
    `).join('');

    list.querySelectorAll('.emoji-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        try {
          const res = await fetch(`/api/emojis/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${this.token}` }
          });
          if (res.ok) {
            this._showToast(`Emoji :${name}: deleted`, 'success');
            this._loadCustomEmojis();
          } else {
            this._showToast('Delete failed', 'error');
          }
        } catch {
          this._showToast('Delete failed', 'error');
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // WEBHOOKS / BOT MANAGEMENT
  // ═══════════════════════════════════════════════════════

  _setupWebhookManagement() {
    // Open bot management modal
    const openBtn = document.getElementById('open-bot-editor-btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => this._openBotModal());
    }
    // Close bot modal
    document.getElementById('close-bot-modal-btn')?.addEventListener('click', () => {
      document.getElementById('bot-modal').style.display = 'none';
    });
    document.getElementById('bot-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    // Create new bot
    document.getElementById('create-bot-btn')?.addEventListener('click', () => {
      this._createNewBot();
    });
  }

  _openBotModal() {
    document.getElementById('bot-modal').style.display = 'flex';
    document.getElementById('bot-detail-panel').innerHTML = '<p class="muted-text" style="padding:20px;text-align:center">Select a bot to edit, or create a new one</p>';
    // Request all webhooks for the sidebar
    this.socket.emit('get-webhooks');
  }

  _createNewBot() {
    const name = prompt('Enter bot name:');
    if (!name || !name.trim()) return;
    // Pick first non-DM channel as default
    const firstChannel = this.channels.find(c => !c.is_dm);
    if (!firstChannel) return this._showToast('No channels available', 'error');
    this.socket.emit('create-webhook', { name: name.trim(), channel_id: firstChannel.id, avatar_url: null });
  }

  _renderBotSidebar(webhooks) {
    const sidebar = document.getElementById('bot-list-sidebar');
    if (!sidebar) return;
    this._botWebhooks = webhooks; // cache for detail panel
    sidebar.innerHTML = webhooks.map(wh => {
      const avatarHtml = wh.avatar_url
        ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<span style="width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;color:#fff">🤖</span>`;
      const activeClass = this._selectedBotId === wh.id ? ' active' : '';
      return `<div class="role-sidebar-item${activeClass}" data-bot-id="${wh.id}">${avatarHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(wh.name)}</span></div>`;
    }).join('');

    sidebar.querySelectorAll('.role-sidebar-item').forEach(item => {
      item.addEventListener('click', () => {
        const botId = parseInt(item.dataset.botId);
        this._selectedBotId = botId;
        // Highlight active
        sidebar.querySelectorAll('.role-sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        this._showBotDetail(botId);
      });
    });
  }

  _showBotDetail(botId) {
    const wh = (this._botWebhooks || []).find(w => w.id === botId);
    if (!wh) return;
    const panel = document.getElementById('bot-detail-panel');
    const baseUrl = window.location.origin;
    const webhookUrl = `${baseUrl}/api/webhooks/${wh.token}`;
    const maskedToken = wh.token.slice(0, 12) + '••••••••••••';
    const channelOptions = this._getBotChannelOptions(wh.channel_id);

    panel.innerHTML = `
      <div class="role-detail-form">
        <label class="settings-label">Avatar</label>
        <div class="bot-avatar-row" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div class="bot-avatar-preview" style="width:48px;height:48px;border-radius:50%;overflow:hidden;border:2px solid var(--border);background:var(--bg-tertiary);flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${wh.avatar_url ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:24px">🤖</span>'}
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <button class="btn-xs btn-accent" id="bot-upload-avatar-btn">📷 Upload</button>
            <button class="btn-xs" id="bot-remove-avatar-btn" ${wh.avatar_url ? '' : 'disabled'}>Remove</button>
          </div>
          <input type="file" id="bot-avatar-file-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
        </div>

        <label class="settings-label">Name</label>
        <input type="text" id="bot-detail-name" value="${this._escapeHtml(wh.name)}" maxlength="32" class="settings-text-input" style="width:100%;margin-bottom:8px">

        <label class="settings-label">Channel</label>
        <select id="bot-detail-channel" class="settings-select" style="width:100%;margin-bottom:8px">${channelOptions}</select>

        <label class="settings-label">Status</label>
        <label class="toggle-row" style="margin-bottom:8px">
          <span>${wh.is_active ? '🟢 Active' : '🔴 Disabled'}</span>
          <button class="btn-xs" id="bot-detail-toggle">${wh.is_active ? 'Disable' : 'Enable'}</button>
        </label>

        <label class="settings-label">Webhook URL</label>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:8px">
          <code style="flex:1;font-size:11px;padding:6px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(webhookUrl)}</code>
          <button class="btn-xs" id="bot-detail-copy-url" title="Copy URL">📋</button>
        </div>

        <label class="settings-label">Token</label>
        <div style="font-size:11px;font-family:monospace;padding:4px 8px;background:var(--bg-input);border-radius:4px;color:var(--text-muted);margin-bottom:12px">${maskedToken}</div>

        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn-sm btn-accent" id="bot-detail-save" style="flex:1">💾 Save Changes</button>
          <button class="btn-sm btn-danger" id="bot-detail-delete">🗑️ Delete</button>
        </div>
      </div>
    `;

    // Wire up handlers
    panel.querySelector('#bot-upload-avatar-btn').addEventListener('click', () => {
      panel.querySelector('#bot-avatar-file-input').click();
    });
    panel.querySelector('#bot-avatar-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      this._uploadBotAvatar(botId, file);
    });
    panel.querySelector('#bot-remove-avatar-btn').addEventListener('click', () => {
      this.socket.emit('update-webhook', { id: botId, avatar_url: '' });
    });
    panel.querySelector('#bot-detail-save').addEventListener('click', () => {
      const name = panel.querySelector('#bot-detail-name').value.trim();
      const channelId = parseInt(panel.querySelector('#bot-detail-channel').value);
      if (!name) return this._showToast('Name is required', 'error');
      this.socket.emit('update-webhook', { id: botId, name, channel_id: channelId });
    });
    panel.querySelector('#bot-detail-toggle').addEventListener('click', () => {
      this.socket.emit('toggle-webhook', { id: botId });
    });
    panel.querySelector('#bot-detail-copy-url').addEventListener('click', () => {
      navigator.clipboard.writeText(webhookUrl).then(() => {
        panel.querySelector('#bot-detail-copy-url').textContent = '✅';
        setTimeout(() => {
          const btn = panel.querySelector('#bot-detail-copy-url');
          if (btn) btn.textContent = '📋';
        }, 1500);
      });
    });
    panel.querySelector('#bot-detail-delete').addEventListener('click', () => {
      if (confirm(`Delete bot "${wh.name}"? This cannot be undone.`)) {
        this._selectedBotId = null;
        this.socket.emit('delete-webhook', { id: botId });
      }
    });
  }

  /** Build channel <option> list ordered like the sidebar (parents first, sub-channels indented) */
  _getBotChannelOptions(selectedId) {
    const regular = this.channels.filter(c => !c.is_dm);
    const parents = regular.filter(c => !c.parent_channel_id);
    const subMap = {};
    regular.filter(c => c.parent_channel_id).forEach(c => {
      if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
      subMap[c.parent_channel_id].push(c);
    });
    let html = '';
    for (const p of parents) {
      const sel = p.id === selectedId ? ' selected' : '';
      html += `<option value="${p.id}"${sel}># ${this._escapeHtml(p.name)}</option>`;
      const subs = subMap[p.id] || [];
      for (const s of subs) {
        const sSel = s.id === selectedId ? ' selected' : '';
        html += `<option value="${s.id}"${sSel}>&nbsp;&nbsp;&nbsp;&nbsp;↳ ${this._escapeHtml(s.name)}</option>`;
      }
    }
    return html;
  }

  async _uploadBotAvatar(botId, file) {
    const form = new FormData();
    form.append('avatar', file);
    form.append('webhookId', botId);
    try {
      const resp = await fetch('/api/upload-webhook-avatar', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: form
      });
      const json = await resp.json();
      if (json.url) {
        this.socket.emit('update-webhook', { id: botId, avatar_url: json.url });
        this._showToast('Bot avatar updated', 'success');
      } else {
        this._showToast(json.error || 'Upload failed', 'error');
      }
    } catch (err) {
      this._showToast('Upload failed', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════
  // LAYOUT DENSITY
  // ═══════════════════════════════════════════════════════

  _setupDensityPicker() {
    const picker = document.getElementById('density-picker');
    if (!picker) return;

    // Restore saved density
    const saved = localStorage.getItem('haven-density') || 'cozy';
    document.documentElement.dataset.density = saved;
    picker.querySelectorAll('.density-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.density === saved);
    });

    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('.density-btn');
      if (!btn) return;
      const density = btn.dataset.density;
      document.documentElement.dataset.density = density;
      localStorage.setItem('haven-density', density);
      picker.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  }

  // ── Image Display Mode Picker ──

  _setupImageModePicker() {
    const picker = document.getElementById('image-mode-picker');
    if (!picker) return;

    // Restore saved image mode (default: thumbnail)
    const saved = localStorage.getItem('haven-image-mode') || 'thumbnail';
    this._applyImageMode(saved);
    picker.querySelectorAll('[data-image-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.imageMode === saved);
    });

    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-image-mode]');
      if (!btn) return;
      const mode = btn.dataset.imageMode;
      this._applyImageMode(mode);
      localStorage.setItem('haven-image-mode', mode);
      picker.querySelectorAll('[data-image-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  }

  _applyImageMode(mode) {
    document.body.classList.toggle('image-mode-full', mode === 'full');
  }

  // ── Image Lightbox ──

  _setupLightbox() {
    const lb = document.getElementById('image-lightbox');
    if (!lb) return;
    lb.addEventListener('click', () => this._closeLightbox());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lb.style.display !== 'none') this._closeLightbox();
    });
  }

  _openLightbox(src) {
    const lb = document.getElementById('image-lightbox');
    const img = document.getElementById('lightbox-img');
    if (!lb || !img) return;
    img.src = src;
    lb.style.display = 'flex';
  }

  _closeLightbox() {
    const lb = document.getElementById('image-lightbox');
    if (lb) { lb.style.display = 'none'; }
    const img = document.getElementById('lightbox-img');
    if (img) { img.src = ''; }
  }

  // ═══════════════════════════════════════════════════════
  // ONLINE OVERLAY (status bar popup)
  // ═══════════════════════════════════════════════════════

  _setupOnlineOverlay() {
    const trigger = document.getElementById('status-online-trigger');
    const overlay = document.getElementById('online-overlay');
    const closeBtn = document.getElementById('online-overlay-close');
    if (!trigger || !overlay) return;

    trigger.style.cursor = 'pointer';

    trigger.addEventListener('click', () => {
      const isOpen = overlay.style.display !== 'none';
      if (isOpen) {
        overlay.style.display = 'none';
        return;
      }
      this._renderOnlineOverlay();
      overlay.style.display = '';

      // Position above the trigger
      const rect = trigger.getBoundingClientRect();
      overlay.style.left = rect.left + 'px';
      overlay.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    }

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (overlay.style.display === 'none') return;
      if (!overlay.contains(e.target) && !trigger.contains(e.target)) {
        overlay.style.display = 'none';
      }
    });
  }

  _renderOnlineOverlay() {
    const list = document.getElementById('online-overlay-list');
    if (!list) return;

    const users = this._lastOnlineUsers || [];
    if (users.length === 0) {
      list.innerHTML = '<p class="muted-text" style="padding:8px">No users</p>';
      return;
    }

    const online = users.filter(u => u.online !== false);
    const offline = users.filter(u => u.online === false);

    let html = '';
    if (online.length > 0) {
      html += `<div class="online-overlay-group">Online — ${online.length}</div>`;
      html += online.map(u => this._renderOverlayUserItem(u)).join('');
    }
    if (offline.length > 0) {
      html += `<div class="online-overlay-group offline">Offline — ${offline.length}</div>`;
      html += offline.map(u => this._renderOverlayUserItem(u)).join('');
    }
    list.innerHTML = html;
  }

  _renderOverlayUserItem(u) {
    const initial = (u.username || '?')[0].toUpperCase();
    const color = u.roleColor || u.avatarColor || '#7c5cfc';
    const statusClass = u.online !== false ? 'online' : 'offline';
    const avatar = u.avatarUrl
      ? `<img src="${this._escapeHtml(u.avatarUrl)}" class="online-overlay-avatar-img" alt="">`
      : `<div class="online-overlay-avatar" style="background:${color}">${initial}</div>`;
    const nameColor = u.roleColor ? ` style="color:${u.roleColor}"` : '';
    return `<div class="online-overlay-user ${statusClass}">
      ${avatar}
      <span class="online-overlay-username"${nameColor}>${this._escapeHtml(u.username)}</span>
      <span class="online-overlay-status-dot ${statusClass}"></span>
    </div>`;
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
    const joinSound = document.getElementById('notif-join-sound');
    const leaveSound = document.getElementById('notif-leave-sound');

    toggle.checked = this.notifications.enabled;
    volume.value = this.notifications.volume * 100;
    msgSound.value = this.notifications.sounds.message;
    mentionVolume.value = this.notifications.mentionVolume * 100;
    mentionSound.value = this.notifications.sounds.mention;
    if (joinSound) joinSound.value = this.notifications.sounds.join;
    if (leaveSound) leaveSound.value = this.notifications.sounds.leave;

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

    if (joinSound) {
      joinSound.addEventListener('change', () => {
        this.notifications.setSound('join', joinSound.value);
        this.notifications.play('join');
      });
    }

    if (leaveSound) {
      leaveSound.addEventListener('change', () => {
        this.notifications.setSound('leave', leaveSound.value);
        this.notifications.play('leave');
      });
    }
  }

  // ── Push Notifications (Web Push API) ──────────────────

  async _setupPushNotifications() {
    const toggle = document.getElementById('push-notif-enabled');
    const statusEl = document.getElementById('push-notif-status');

    // Wire dismiss button for push error modal
    document.getElementById('push-error-dismiss-btn')?.addEventListener('click', () => {
      document.getElementById('push-error-modal').style.display = 'none';
      localStorage.setItem('haven_push_error_dismissed', 'true');
    });

    // Detect browser and platform
    const isBrave = navigator.brave && (await navigator.brave.isBrave?.()) || false;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    // Secure context required (covers HTTPS, localhost, etc.)
    if (!window.isSecureContext) {
      if (toggle) toggle.disabled = true;
      if (statusEl) statusEl.textContent = 'Requires HTTPS';
      this._pushErrorReason = 'Push notifications require a secure (HTTPS) connection. Check the Haven setup guide for SSL configuration.';
      if (!localStorage.getItem('haven_push_error_dismissed')) this._showPushError(this._pushErrorReason);
      return;
    }

    // Check browser support
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (toggle) toggle.disabled = true;
      let reason = 'Your browser does not support push notifications.';
      if (isIOS && !isStandalone) {
        reason = 'On iOS, push notifications only work when Haven is installed as an app. ' +
          'Tap the Share button → "Add to Home Screen", then open Haven from your home screen.';
      } else if (isIOS) {
        reason = 'Push notifications are not supported on this iOS browser version. Update to iOS 16.4 or later.';
      }
      if (statusEl) statusEl.textContent = 'Not supported';
      this._pushErrorReason = reason;
      if (!localStorage.getItem('haven_push_error_dismissed')) this._showPushError(reason);
      return;
    }

    // Register service worker
    try {
      this._swRegistration = await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.error('SW registration failed:', err);
      if (toggle) toggle.disabled = true;
      let reason = `Service worker registration failed: ${err.message}`;
      const host = location.hostname;
      const isSelfSigned = location.protocol === 'https:' && host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.trycloudflare.com');
      if (err.name === 'SecurityError' || (err.message && err.message.includes('SSL')) || isSelfSigned) {
        reason = 'Push notifications require a trusted SSL certificate.\n\n' +
          'Self-signed certificates (used by default) do not support push. To fix this:\n' +
          '• Use a Cloudflare Tunnel (Settings → Admin → Tunnel) which provides a trusted cert automatically\n' +
          '• Or access Haven via localhost (push works on localhost even with self-signed certs)\n' +
          '• Or install a real SSL certificate (e.g. from Let\'s Encrypt)';
      }
      if (isBrave) {
        reason = 'Brave blocks push notifications by default.\n\n' +
          'To fix this:\n' +
          '1. Open brave://settings/privacy in your address bar\n' +
          '2. Enable "Use Google Services for Push Messaging"\n' +
          '3. Restart Brave and reload Haven\n\n' +
          'If that doesn\'t work, try Chrome or Edge instead.';
      }
      if (statusEl) statusEl.textContent = isBrave ? 'Blocked by Brave' : 'Registration failed';
      this._pushErrorReason = reason;
      if (!localStorage.getItem('haven_push_error_dismissed')) this._showPushError(reason);
      return;
    }

    // Listen for notification clicks from service worker (channel switch)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'push-notification-click' && event.data.channelCode) {
        this.switchChannel(event.data.channelCode);
      }
    });

    // Check current subscription state
    let existingSub = null;
    try {
      existingSub = await this._swRegistration.pushManager.getSubscription();
    } catch (err) {
      console.warn('Push getSubscription failed (non-fatal, will retry on subscribe):', err.message || err);
      // Don't bail out — let the user attempt to subscribe via the toggle.
      // The actual subscribe() call in _subscribePush will surface the real error.
    }

    this._pushSubscription = existingSub;
    if (toggle) toggle.checked = !!existingSub;
    if (statusEl) statusEl.textContent = existingSub ? 'Enabled' : 'Disabled';

    // Re-register existing subscription with server on every load
    // (handles server DB resets, reconnects, and subscription refresh)
    if (existingSub) {
      const subJson = existingSub.toJSON();
      this.socket.emit('push-subscribe', {
        endpoint: subJson.endpoint,
        keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth }
      });
    }

    // If permission was previously denied, show early warning
    if (Notification.permission === 'denied') {
      if (toggle) toggle.disabled = true;
      if (statusEl) statusEl.textContent = 'Blocked';
      this._pushErrorReason = 'Notification permission was denied. Check your browser\'s site settings and allow notifications for this site, then reload.';
      return;
    }

    // Listen for server confirmation
    this.socket.on('push-subscribed', () => {
      if (statusEl) statusEl.textContent = 'Enabled';
    });
    this.socket.on('push-unsubscribed', () => {
      if (statusEl) statusEl.textContent = 'Disabled';
    });

    // Toggle handler
    if (toggle) {
      toggle.addEventListener('change', async () => {
        if (toggle.checked) {
          // If we have a stored error reason, show popup instead of trying
          if (toggle.disabled && this._pushErrorReason) {
            toggle.checked = false;
            this._showPushError(this._pushErrorReason);
            return;
          }
          await this._subscribePush();
        } else {
          await this._unsubscribePush();
        }
      });
    }
  }

  // ── Activities / Games system methods ────────────────────
  async _openActivitiesModal() {
    const modal = document.getElementById('activities-modal');
    const grid = document.getElementById('activities-grid');
    if (!modal || !grid) return;

    grid.innerHTML = '';

    // Check flash ROM installation status
    let flashStatus = {};
    try {
      const res = await fetch('/api/flash-rom-status');
      if (res.ok) {
        const data = await res.json();
        for (const rom of data.roms) flashStatus[rom.file] = rom.installed;
        this._flashAllInstalled = data.allInstalled;
      }
    } catch {}

    // If any flash games are not installed, show a download banner at top
    const hasFlashGames = this._gamesRegistry.some(g => g.type === 'flash');
    if (hasFlashGames && !this._flashAllInstalled) {
      const banner = document.createElement('div');
      banner.className = 'flash-install-banner';
      banner.innerHTML = `
        <span>🎮 Flash games not installed (~37 MB download)</span>
        <button class="btn-sm btn-accent" id="install-flash-btn">Download Flash Games</button>
      `;
      grid.appendChild(banner);
      banner.querySelector('#install-flash-btn').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        try {
          const res = await fetch('/api/install-flash-roms', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + this.token }
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Download failed');
          }
          const data = await res.json();
          const installed = data.results.filter(r => r.status === 'installed').length;
          const already = data.results.filter(r => r.status === 'already-installed').length;
          const errors = data.results.filter(r => r.status === 'error');
          this._showToast(`Flash games: ${installed} installed, ${already} already had, ${errors.length} failed`, installed > 0 ? 'success' : 'error');
          this._flashAllInstalled = errors.length === 0;
          // Refresh modal
          this._openActivitiesModal();
        } catch (err) {
          this._showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Download Flash Games';
        }
      });
    }

    for (const game of this._gamesRegistry) {
      // For flash games, check if ROM is installed
      const isFlash = game.type === 'flash';
      const romFile = isFlash ? game.path.match(/swf=\/games\/roms\/(.+?)&/)?.[1] : null;
      const romInstalled = !isFlash || (romFile && flashStatus[decodeURIComponent(romFile)] !== false);

      const card = document.createElement('div');
      card.className = 'activity-card' + (!romInstalled ? ' activity-card-disabled' : '');
      card.dataset.gameId = game.id;
      card.innerHTML = `
        <div class="activity-card-icon">${this._escapeHtml(game.icon)}</div>
        <div class="activity-card-name">${this._escapeHtml(game.name)}</div>
        <div class="activity-card-desc">${this._escapeHtml(game.description || '')}${!romInstalled ? '<br><em style=\"color:var(--text-muted)\">Not installed</em>' : ''}</div>
      `;
      if (romInstalled) {
        card.addEventListener('click', () => {
          this._closeActivitiesModal();
          this._launchGame(game);
        });
      }
      grid.appendChild(card);
    }
    modal.style.display = 'flex';
  }

  _closeActivitiesModal() {
    const modal = document.getElementById('activities-modal');
    if (modal) modal.style.display = 'none';
  }

  _launchGame(game) {
    this._currentGame = game;
    // Default: pop out into a new window
    const tok = localStorage.getItem('haven_token') || '';
    const url = game.path + '#token=' + encodeURIComponent(tok);
    this._gameWindow = window.open(url, '_blank', 'width=800,height=900');

    // If popup was blocked, fall back to inline iframe
    if (!this._gameWindow || this._gameWindow.closed) {
      const overlay = document.getElementById('game-iframe-overlay');
      const iframe = document.getElementById('game-iframe');
      const titleEl = document.getElementById('game-iframe-title');
      if (!overlay || !iframe) return;

      this._gameIframe = iframe;
      if (titleEl) titleEl.textContent = `${game.icon} ${game.name}`;
      iframe.src = url;
      overlay.style.display = 'flex';
    }

    // Close activities modal
    this._closeActivitiesModal();

    // Request leaderboard for this game
    this.socket.emit('get-high-scores', { game: game.id });
  }

  _closeGameIframe() {
    const overlay = document.getElementById('game-iframe-overlay');
    const iframe = document.getElementById('game-iframe');
    if (overlay) overlay.style.display = 'none';
    if (iframe) iframe.src = 'about:blank';
    this._currentGame = null;
    this._gameIframe = null;
  }

  _popoutGame() {
    if (!this._currentGame) return;
    const tok = localStorage.getItem('haven_token') || '';
    const url = this._currentGame.path + '#token=' + encodeURIComponent(tok);
    this._gameWindow = window.open(url, '_blank', 'width=740,height=860');
    this._closeGameIframe();
  }

  _showPushError(reason) {
    const modal = document.getElementById('push-error-modal');
    const reasonEl = document.getElementById('push-error-reason');
    if (!modal || !reasonEl) return;

    // Build structured content with browser-specific action buttons
    let html = this._escapeHtml(reason);

    // Detect Brave-specific advice and add a copy button for the settings URL
    if (reason.includes('brave://settings')) {
      const settingsUrl = 'brave://settings/privacy';
      html += `<div style="margin-top:12px;padding:10px;background:var(--bg-secondary);border-radius:6px;font-family:monospace;font-size:13px;display:flex;align-items:center;gap:8px;justify-content:center;">
        <span style="user-select:all;">${settingsUrl}</span>
        <button class="btn-accent" onclick="navigator.clipboard.writeText('${settingsUrl}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)"
          style="padding:4px 10px;font-size:12px;min-width:52px;">Copy</button>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin:8px 0 0;">Paste this into your Brave address bar, then enable "Use Google Services for Push Messaging" and restart Brave.</p>`;
    }

    // Detect permission denied and provide Chrome/Edge settings hints
    if (reason.includes('Permission denied') || reason.includes('permission was denied')) {
      html += `<div style="margin-top:12px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
        <strong>How to fix:</strong><br>
        \u2022 Click the lock/info icon in your address bar → Site settings → Notifications → Allow<br>
        \u2022 Or go to browser settings → Privacy → Site Settings → Notifications
      </div>`;
    }

    // iOS standalone hint
    if (reason.includes('Add to Home Screen')) {
      html += `<div style="margin-top:12px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
        <strong>Steps:</strong><br>
        1. Tap the <strong>Share</strong> button (box with arrow) in Safari<br>
        2. Scroll down and tap <strong>"Add to Home Screen"</strong><br>
        3. Open Haven from your home screen icon
      </div>`;
    }

    reasonEl.innerHTML = html;
    modal.style.display = 'flex';
  }

  /** Escape HTML entities for safe innerHTML insertion */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async _subscribePush() {
    const statusEl = document.getElementById('push-notif-status');
    const toggle = document.getElementById('push-notif-enabled');
    try {
      // Request notification permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (toggle) toggle.checked = false;
        if (statusEl) statusEl.textContent = 'Permission denied';
        this._showPushError(
          'Notification permission was denied. Check your browser\'s site settings and allow notifications for this site, then try again.'
        );
        return;
      }

      // Fetch VAPID public key from server
      const res = await fetch('/api/push/vapid-key');
      if (!res.ok) throw new Error('Server error fetching push key');
      const { publicKey } = await res.json();

      // Convert VAPID key to Uint8Array
      const urlBase64ToUint8Array = (base64String) => {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
      };

      // Subscribe to push
      const sub = await this._swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      this._pushSubscription = sub;
      const subJson = sub.toJSON();

      // Send subscription to server
      this.socket.emit('push-subscribe', {
        endpoint: subJson.endpoint,
        keys: {
          p256dh: subJson.keys.p256dh,
          auth: subJson.keys.auth
        }
      });

      if (statusEl) statusEl.textContent = 'Subscribing...';
    } catch (err) {
      console.error('Push subscribe error:', err);
      if (toggle) toggle.checked = false;

      const isBrave = navigator.brave && (await navigator.brave.isBrave?.()) || false;
      let reason = `Push subscription failed: ${err.message}`;
      if (isBrave) {
        reason = 'Brave blocked the push subscription.\n\n' +
          'Troubleshooting steps:\n' +
          '1. Open brave://settings/privacy and make sure "Use Google Services for Push Messaging" is ON\n' +
          '2. Click the Brave shields icon (lion) in the address bar for this site and disable shields, then reload\n' +
          '3. Restart Brave completely (close all windows) and reload Haven\n' +
          '4. If none of the above work, try clearing site data or using Chrome/Edge instead.\n\n' +
          'Technical detail: ' + (err.message || 'unknown error');
      } else if (err.message?.includes('push service')) {
        reason = 'The browser\'s push service returned an error. This is usually a browser-level restriction. ' +
          'Try Google Chrome or Microsoft Edge if this persists.';
      }

      if (statusEl) statusEl.textContent = 'Failed';
      this._showPushError(reason);
    }
  }

  async _unsubscribePush() {
    const statusEl = document.getElementById('push-notif-status');
    try {
      if (this._pushSubscription) {
        const endpoint = this._pushSubscription.endpoint;
        await this._pushSubscription.unsubscribe();
        this._pushSubscription = null;

        // Tell server to remove subscription
        this.socket.emit('push-unsubscribe', { endpoint });
      }
      if (statusEl) statusEl.textContent = 'Disabled';
    } catch (err) {
      console.error('Push unsubscribe error:', err);
      if (statusEl) statusEl.textContent = 'Error';
    }
  }

  // ── Tunnel Management ─────────────────────────────────

  /** Sync tunnel enabled/provider state to server */
  async _syncTunnelState(enabled) {
    const provider = document.getElementById('tunnel-provider-select')?.value || 'localtunnel';
    const statusEl = document.getElementById('tunnel-status-display');
    const btn = document.getElementById('tunnel-toggle-btn');
    if (statusEl) statusEl.textContent = enabled ? 'Starting…' : 'Stopping…';
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/tunnel/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ enabled, provider })
      });
      if (!res.ok) {
        console.error('Tunnel sync failed:', res.status);
        if (statusEl) statusEl.textContent = 'Sync failed';
        return;
      }
      // Update status from the response directly (no delay needed)
      const data = await res.json();
      this._updateTunnelStatusUI(data);
    } catch (err) {
      console.error('Tunnel sync error:', err);
      if (statusEl) statusEl.textContent = 'Error';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** Fetch current tunnel status from server and update UI.
   *  If the tunnel is still starting, poll every 2 s until it resolves. */
  async _refreshTunnelStatus() {
    try {
      const res = await fetch('/api/tunnel/status', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._updateTunnelStatusUI(data);
      // If still starting, poll again in 2 s
      if (data.starting) {
        clearTimeout(this._tunnelPollTimer);
        this._tunnelPollTimer = setTimeout(() => this._refreshTunnelStatus(), 2000);
      }
    } catch (err) {
      const statusEl = document.getElementById('tunnel-status-display');
      if (statusEl) statusEl.textContent = 'Error checking status';
      console.error('Tunnel status error:', err);
    }
  }

  /** Update the tunnel status display from a status object */
  _updateTunnelStatusUI(data) {
    const statusEl = document.getElementById('tunnel-status-display');
    const btn = document.getElementById('tunnel-toggle-btn');
    if (btn) {
      if (data.active) {
        btn.textContent = 'Stop Tunnel';
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-accent');
      } else {
        btn.textContent = 'Start Tunnel';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-accent');
      }
    }
    if (!statusEl) return;
    if (data.active && data.url) {
      statusEl.textContent = data.url;
      statusEl.title = 'Tunnel is active — click to copy';
      statusEl.style.cursor = 'pointer';
      statusEl.onclick = () => {
        navigator.clipboard.writeText(data.url);
        statusEl.textContent = 'Copied!';
        setTimeout(() => { statusEl.textContent = data.url; }, 1500);
      };
    } else if (data.starting) {
      statusEl.textContent = 'Starting…';
      statusEl.style.cursor = '';
      statusEl.onclick = null;
    } else {
      statusEl.textContent = data.error || 'Inactive';
      statusEl.style.cursor = '';
      statusEl.onclick = null;
    }
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

    // Periodic member list + voice refresh every 30s to keep sidebar in sync
    if (this._memberRefreshInterval) clearInterval(this._memberRefreshInterval);
    this._memberRefreshInterval = setInterval(() => {
      if (this.socket && this.socket.connected && this.currentChannel) {
        this.socket.emit('request-online-users', { code: this.currentChannel });
        this.socket.emit('request-voice-users', { code: this.currentChannel });
      }
    }, 30000);

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

    // Clear any pending image queue from previous channel
    this._clearImageQueue();

    // Voice persists across channel switches — no auto-disconnect

    this.currentChannel = code;
    const channel = this.channels.find(c => c.code === code);
    const isDm = channel && channel.is_dm;
    const displayName = isDm && channel.dm_target
      ? `@ ${channel.dm_target.username}`
      : channel ? `# ${channel.name}` : code;

    document.getElementById('channel-header-name').textContent = displayName;
    // Clear scramble cache so the effect picks up the new channel name
    const headerEl = document.getElementById('channel-header-name');
    if (headerEl) { delete headerEl.dataset.originalText; headerEl._scrambling = false; }
    const isMaskedCode = (code === '••••••••');
    document.getElementById('channel-code-display').textContent = isDm ? '' : code;
    document.getElementById('copy-code-btn').style.display = (isDm || isMaskedCode) ? 'none' : 'inline-flex';

    // Show channel code settings gear for admins on non-DM channels
    const codeSettingsBtn = document.getElementById('channel-code-settings-btn');
    if (codeSettingsBtn) {
      codeSettingsBtn.style.display = (!isDm && this.user.isAdmin) ? 'inline-flex' : 'none';
    }

    // Show the header actions box
    const actionsBox = document.getElementById('header-actions-box');
    if (actionsBox) actionsBox.style.display = 'flex';
    // Update voice button state — persist controls if in voice anywhere
    if (this.voice && this.voice.inVoice) {
      this._updateVoiceButtons(true);
    } else {
      // Show just the join button (not the indicator)
      document.getElementById('voice-join-btn').style.display = 'inline-flex';
      const indic = document.getElementById('voice-active-indicator');
      if (indic) indic.style.display = 'none';
      const vp = document.getElementById('voice-panel');
      if (vp) vp.style.display = 'none';
      const mobileJoin = document.getElementById('voice-join-mobile');
      if (mobileJoin) mobileJoin.style.display = '';
    }
    document.getElementById('search-toggle-btn').style.display = '';
    document.getElementById('pinned-toggle-btn').style.display = '';

    // Show/hide topic bar
    this._updateTopicBar(channel?.topic || '');

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

    // Reset pagination state for the new channel
    this._oldestMsgId = null;
    this._noMoreHistory = false;
    this._loadingHistory = false;
    this._historyBefore = null;

    this.socket.emit('enter-channel', { code });
    // E2E: fetch DM partner's public key BEFORE requesting messages
    if (isDm && channel) this._fetchDMPartnerKey(channel);
    this.socket.emit('get-messages', { code });
    this.socket.emit('get-channel-members', { code });
    this.socket.emit('request-voice-users', { code });
    this._clearReply();

    // Auto-focus the message input for quick typing
    const msgInput = document.getElementById('message-input');
    if (msgInput) setTimeout(() => msgInput.focus(), 50);

    // Show verify-encryption button only in DM channels
    const verifyBtn = document.getElementById('e2e-verify-btn');
    if (verifyBtn) verifyBtn.style.display = isDm ? '' : 'none';
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
    // Clear scramble cache when going back to welcome
    const welcomeHeader = document.getElementById('channel-header-name');
    if (welcomeHeader) { delete welcomeHeader.dataset.originalText; welcomeHeader._scrambling = false; }
    document.getElementById('channel-code-display').textContent = '';
    document.getElementById('copy-code-btn').style.display = 'none';
    document.getElementById('voice-join-btn').style.display = 'none';
    const indic2 = document.getElementById('voice-active-indicator');
    if (indic2) indic2.style.display = 'none';
    const vp2 = document.getElementById('voice-panel');
    if (vp2) vp2.style.display = 'none';
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) mobileJoin.style.display = 'none';
    const actionsBox = document.getElementById('header-actions-box');
    if (actionsBox) actionsBox.style.display = 'none';
    document.getElementById('status-channel').textContent = 'None';
    document.getElementById('status-online-count').textContent = '0';
    const topicBar = document.getElementById('channel-topic-bar');
    if (topicBar) topicBar.style.display = 'none';
  }

  /* ── Channel context menu helpers ─────────────────────── */
  _initChannelContextMenu() {
    this._ctxMenuChannel = null;
    this._ctxMenuEl = document.getElementById('channel-ctx-menu');
    // Delegate clicks on "..." buttons inside the channel list
    document.getElementById('channel-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.channel-more-btn');
      if (!btn) return;
      e.stopPropagation();
      const code = btn.closest('.channel-item')?.dataset.code;
      if (code) this._openChannelCtxMenu(code, btn);
    });
  }

  _openChannelCtxMenu(code, btnEl) {
    this._ctxMenuChannel = code;
    const menu = this._ctxMenuEl;
    if (!menu) return;
    // Show/hide admin-only items
    const isAdmin = this.user && this.user.isAdmin;
    const isMod = isAdmin || this._canModerate();
    menu.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
    menu.querySelectorAll('.mod-only').forEach(el => {
      el.style.display = isMod ? '' : 'none';
    });
    // Hide "Create Sub-channel" if this is already a sub-channel
    const ch = this.channels.find(c => c.code === code);
    const createSubBtn = menu.querySelector('[data-action="create-sub-channel"]');
    if (createSubBtn && ch && ch.parent_channel_id) {
      createSubBtn.style.display = 'none';
    }
    // Show "Organize" only for parent channels that have sub-channels
    const organizeBtn = menu.querySelector('[data-action="organize"]');
    if (organizeBtn) {
      const hasSubs = ch && !ch.parent_channel_id && this.channels.some(c => c.parent_channel_id === ch.id);
      organizeBtn.style.display = (isAdmin && hasSubs) ? '' : 'none';
    }
    // Update toggle indicators for streams/music
    const streamsBtn = menu.querySelector('[data-action="toggle-streams"]');
    const musicBtn = menu.querySelector('[data-action="toggle-music"]');
    if (streamsBtn && ch) {
      const on = ch.streams_enabled !== 0;
      streamsBtn.innerHTML = on
        ? '🖥️ Streams <span class="ctx-indicator ctx-on">✅ ON</span>'
        : '🖥️ Streams <span class="ctx-indicator ctx-off">❌ OFF</span>';
    }
    if (musicBtn && ch) {
      const on = ch.music_enabled !== 0;
      musicBtn.innerHTML = on
        ? '🎵 Music <span class="ctx-indicator ctx-on">✅ ON</span>'
        : '🎵 Music <span class="ctx-indicator ctx-off">❌ OFF</span>';
    }
    // Update slow mode indicator
    const slowBtn = menu.querySelector('[data-action="slow-mode"]');
    if (slowBtn && ch) {
      const interval = ch.slow_mode_interval || 0;
      slowBtn.innerHTML = interval > 0
        ? `🐢 Slow Mode <span class="ctx-indicator ctx-on">${interval}s</span>`
        : '🐢 Slow Mode <span class="ctx-indicator ctx-off">OFF</span>';
    }
    // Update mute label
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const muteBtn = menu.querySelector('[data-action="mute"]');
    if (muteBtn) muteBtn.textContent = muted.includes(code) ? '🔕 Unmute Channel' : '🔔 Mute Channel';
    // Show/hide voice options based on current voice state
    const joinVoiceBtn = menu.querySelector('[data-action="join-voice"]');
    const leaveVoiceBtn = menu.querySelector('[data-action="leave-voice"]');
    const inVoice = this.voice && this.voice.inVoice;
    const inThisChannel = inVoice && this.voice.currentChannel === code;
    if (joinVoiceBtn) joinVoiceBtn.style.display = inThisChannel ? 'none' : '';
    if (leaveVoiceBtn) leaveVoiceBtn.style.display = inVoice ? '' : 'none';
    // Position near the button
    const rect = btnEl.getBoundingClientRect();
    menu.style.display = 'block';
    menu.style.top  = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';
    // Keep menu inside viewport
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = (window.innerWidth - mr.width - 8) + 'px';
      if (mr.bottom > window.innerHeight) menu.style.top = (rect.top - mr.height - 4) + 'px';
    });
  }

  _closeChannelCtxMenu() {
    if (this._ctxMenuEl) this._ctxMenuEl.style.display = 'none';
    this._ctxMenuChannel = null;
  }

  /* ── DM context menu helpers ──────────────────────────── */
  _initDmContextMenu() {
    this._dmCtxMenuEl = document.getElementById('dm-ctx-menu');
    this._dmCtxMenuCode = null;

    // Mute DM
    document.querySelector('[data-action="dm-mute"]')?.addEventListener('click', () => {
      const code = this._dmCtxMenuCode;
      if (!code) return;
      this._closeDmCtxMenu();
      const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
      const idx = muted.indexOf(code);
      if (idx >= 0) { muted.splice(idx, 1); this._showToast('DM unmuted', 'success'); }
      else { muted.push(code); this._showToast('DM muted', 'success'); }
      localStorage.setItem('haven_muted_channels', JSON.stringify(muted));
    });

    // Delete DM
    document.querySelector('[data-action="dm-delete"]')?.addEventListener('click', () => {
      const code = this._dmCtxMenuCode;
      if (!code) return;
      this._closeDmCtxMenu();
      if (!confirm('⚠️ Delete this DM?\nAll messages will be permanently deleted for both users.')) return;
      this.socket.emit('delete-dm', { code });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this._dmCtxMenuEl && !this._dmCtxMenuEl.contains(e.target) && !e.target.closest('.dm-more-btn')) {
        this._closeDmCtxMenu();
      }
    });
  }

  _openDmCtxMenu(code, anchorEl, mouseEvent) {
    this._dmCtxMenuCode = code;
    const menu = this._dmCtxMenuEl;
    if (!menu) return;

    // Update mute label
    const muted = JSON.parse(localStorage.getItem('haven_muted_channels') || '[]');
    const muteBtn = menu.querySelector('[data-action="dm-mute"]');
    if (muteBtn) muteBtn.textContent = muted.includes(code) ? '🔕 Unmute DM' : '🔔 Mute DM';

    // Position
    if (mouseEvent) {
      menu.style.top = mouseEvent.clientY + 'px';
      menu.style.left = mouseEvent.clientX + 'px';
    } else {
      const rect = anchorEl.getBoundingClientRect();
      menu.style.top = rect.bottom + 4 + 'px';
      menu.style.left = rect.left + 'px';
    }
    menu.style.display = 'block';

    // Keep inside viewport
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = (window.innerWidth - mr.width - 8) + 'px';
      if (mr.bottom > window.innerHeight) menu.style.top = (mr.top - mr.height - 4) + 'px';
    });
  }

  _closeDmCtxMenu() {
    if (this._dmCtxMenuEl) this._dmCtxMenuEl.style.display = 'none';
    this._dmCtxMenuCode = null;
  }

  /* ── Organize sub-channels modal ─────────────────────── */

  _openOrganizeModal(parentCode, serverLevel) {
    if (serverLevel) {
      // Server-level mode: organize top-level channels
      const parents = this.channels.filter(c => !c.parent_channel_id && !c.is_dm);
      this._organizeParentCode = '__server__';
      this._organizeParentId = null;
      this._organizeServerLevel = true;
      this._organizeList = [...parents].sort((a, b) => (a.position || 0) - (b.position || 0));
      this._organizeSelected = null;
      this._organizeTagSorts = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || '{}');

      document.getElementById('organize-modal-title').textContent = '📋 Organize Channels';
      document.getElementById('organize-modal-parent-name').textContent = 'Reorder channels and assign category tags';
      // Server-level sort is stored in localStorage (no single parent channel to hold it)
      const sortSel = document.getElementById('organize-global-sort');
      const savedSort = localStorage.getItem('haven_server_sort_mode') || 'manual';
      sortSel.value = savedSort;
      document.getElementById('organize-tag-input').value = '';
      this._renderOrganizeList();
      document.getElementById('organize-modal').style.display = 'flex';
      return;
    }

    const parent = this.channels.find(c => c.code === parentCode);
    if (!parent) return;

    const subs = this.channels.filter(c => c.parent_channel_id === parent.id);
    this._organizeParentCode = parentCode;
    this._organizeParentId = parent.id;
    this._organizeServerLevel = false;
    this._organizeList = [...subs].sort((a, b) => (a.position || 0) - (b.position || 0));
    this._organizeSelected = null;
    // Per-tag sort overrides: tag → 'manual'|'alpha'|'created'|'oldest' (persisted in localStorage)
    this._organizeTagSorts = JSON.parse(localStorage.getItem(`haven_tag_sorts_${parentCode}`) || '{}');

    document.getElementById('organize-modal-title').textContent = '📋 Organize Sub-channels';
    document.getElementById('organize-modal-parent-name').textContent = `# ${parent.name}`;
    // Map sort_alphabetical: 0=manual, 1=alpha, 2=created
    const sortSel = document.getElementById('organize-global-sort');
    sortSel.value = parent.sort_alphabetical === 1 ? 'alpha' : parent.sort_alphabetical === 2 ? 'created' : parent.sort_alphabetical === 3 ? 'oldest' : 'manual';
    document.getElementById('organize-tag-input').value = '';
    this._renderOrganizeList();
    document.getElementById('organize-modal').style.display = 'flex';
  }

  _renderOrganizeList() {
    const listEl = document.getElementById('organize-channel-list');
    const globalSort = document.getElementById('organize-global-sort').value;

    let displayList = [...(this._organizeList || [])];

    // Collect unique tags
    const allTags = [...new Set(displayList.filter(c => c.category).map(c => c.category))].sort((a, b) => a.localeCompare(b));
    const hasTags = allTags.length > 0;

    // Sort within each tag group
    const sortGroup = (arr, mode) => {
      if (mode === 'alpha') {
        arr.sort((a, b) => a.name.localeCompare(b.name));
      } else if (mode === 'created') {
        arr.sort((a, b) => (b.id || 0) - (a.id || 0)); // Higher ID = newer
      } else if (mode === 'oldest') {
        arr.sort((a, b) => (a.id || 0) - (b.id || 0)); // Lower ID = older
      } else {
        arr.sort((a, b) => (a.position || 0) - (b.position || 0));
      }
      return arr;
    };

    // Build grouped display
    let grouped = [];
    if (hasTags) {
      // Tagged groups first, then untagged
      for (const tag of allTags) {
        const tagSort = this._organizeTagSorts[tag] || globalSort;
        const tagItems = sortGroup(displayList.filter(c => c.category === tag), tagSort);
        grouped.push({ tag, items: tagItems, sort: tagSort });
      }
      const untagged = displayList.filter(c => !c.category);
      if (untagged.length) {
        const untaggedSort = this._organizeTagSorts['__untagged__'] || globalSort;
        grouped.push({ tag: '', items: sortGroup(untagged, untaggedSort), sort: untaggedSort });
      }
    } else {
      grouped.push({ tag: '', items: sortGroup(displayList, globalSort), sort: globalSort });
    }

    let html = '';
    for (const group of grouped) {
      // Tag header
      if (hasTags) {
        const tagKey = group.tag || '__untagged__';
        const label = group.tag ? this._escapeHtml(group.tag) : 'Untagged';
        html += `<div class="organize-tag-header" data-tag-key="${this._escapeHtml(tagKey)}">
          <span>${label}</span>
          <select class="tag-sort-select" data-tag="${this._escapeHtml(tagKey)}" title="Sort this group">
            <option value="manual"${group.sort === 'manual' ? ' selected' : ''}>Manual</option>
            <option value="alpha"${group.sort === 'alpha' ? ' selected' : ''}>A→Z</option>
            <option value="created"${group.sort === 'created' ? ' selected' : ''}>Newest</option>
            <option value="oldest"${group.sort === 'oldest' ? ' selected' : ''}>Oldest</option>
          </select>
        </div>`;
      }

      for (const ch of group.items) {
        const sel = this._organizeSelected === ch.code;
        const tagBadge = ch.category ? `<span class="organize-tag-badge">${this._escapeHtml(ch.category)}</span>` : '';
        const icon = this._organizeServerLevel ? '#' : (ch.is_private ? '🔒' : '↳');
        html += `<div class="organize-item${sel ? ' selected' : ''}" data-code="${ch.code}">
          <span style="opacity:0.5">${icon}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._escapeHtml(ch.name)}</span>
          ${tagBadge}
        </div>`;
      }
    }

    if (!displayList.length) {
      html = '<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.9rem">' + (this._organizeServerLevel ? 'No channels yet' : 'No sub-channels yet') + '</div>';
    }

    listEl.innerHTML = html;

    // Click to select
    listEl.querySelectorAll('.organize-item').forEach(el => {
      el.addEventListener('click', () => {
        this._organizeSelected = el.dataset.code;
        const ch = this._organizeList.find(c => c.code === el.dataset.code);
        document.getElementById('organize-tag-input').value = (ch && ch.category) || '';
        this._renderOrganizeList();
      });
    });

    // Per-tag sort dropdowns
    listEl.querySelectorAll('.tag-sort-select').forEach(sel => {
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const tagKey = sel.dataset.tag;
        this._organizeTagSorts[tagKey] = sel.value;
        // Persist per-tag sorts so sidebar respects them
        localStorage.setItem(`haven_tag_sorts_${this._organizeParentCode}`, JSON.stringify(this._organizeTagSorts));
        this._renderOrganizeList();
      });
    });

    // Disable up/down when not manual sort or nothing selected
    const effectiveSort = this._organizeSelected
      ? (() => {
          const ch = this._organizeList.find(c => c.code === this._organizeSelected);
          const tag = ch && ch.category ? ch.category : '__untagged__';
          return this._organizeTagSorts[tag] || globalSort;
        })()
      : globalSort;
    const isManual = effectiveSort === 'manual';
    document.getElementById('organize-move-up').disabled = !isManual || !this._organizeSelected;
    document.getElementById('organize-move-down').disabled = !isManual || !this._organizeSelected;
    document.getElementById('organize-set-tag').disabled = !this._organizeSelected;
    document.getElementById('organize-remove-tag').disabled = !this._organizeSelected;
  }

  /* ── DM Organize (client-side, localStorage) ─────────── */

  _openDmOrganizeModal() {
    const dmChannels = this.channels.filter(c => c.is_dm);
    const order = JSON.parse(localStorage.getItem('haven_dm_order') || '[]');
    const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');

    // Build list sorted by saved order, then alphabetical for unknowns
    const ordered = [];
    for (const code of order) {
      const ch = dmChannels.find(c => c.code === code);
      if (ch) ordered.push(ch);
    }
    for (const ch of dmChannels) {
      if (!ordered.includes(ch)) ordered.push(ch);
    }
    this._dmOrganizeList = ordered;
    this._dmOrganizeSelected = null;

    const sortSel = document.getElementById('dm-organize-sort');
    sortSel.value = localStorage.getItem('haven_dm_sort_mode') || 'manual';
    document.getElementById('dm-organize-tag-input').value = '';
    this._renderDmOrganizeList();
    document.getElementById('dm-organize-modal').style.display = 'flex';
  }

  _saveDmOrder() {
    localStorage.setItem('haven_dm_order', JSON.stringify(this._dmOrganizeList.map(c => c.code)));
  }

  _renderDmOrganizeList() {
    const listEl = document.getElementById('dm-organize-list');
    const sortMode = document.getElementById('dm-organize-sort').value;
    const assignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');

    let displayList = [...(this._dmOrganizeList || [])];

    // Collect unique tags
    const allTags = [...new Set(displayList.map(c => assignments[c.code]).filter(Boolean))].sort();
    const hasTags = allTags.length > 0;

    const getDmName = (ch) => ch.dm_target ? ch.dm_target.username : 'Unknown';

    const sortGroup = (arr, mode) => {
      if (mode === 'alpha') {
        arr.sort((a, b) => getDmName(a).localeCompare(getDmName(b)));
      } else if (mode === 'recent') {
        arr.sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
      }
      // manual = keep current order
      return arr;
    };

    let grouped = [];
    if (hasTags) {
      for (const tag of allTags) {
        const tagItems = sortGroup(displayList.filter(c => assignments[c.code] === tag), sortMode);
        grouped.push({ tag, items: tagItems });
      }
      const untagged = displayList.filter(c => !assignments[c.code]);
      if (untagged.length) {
        grouped.push({ tag: '', items: sortGroup(untagged, sortMode) });
      }
    } else {
      grouped.push({ tag: '', items: sortGroup(displayList, sortMode) });
    }

    let html = '';
    for (const group of grouped) {
      if (group.tag) {
        html += `<div class="organize-tag-header">🏷️ ${this._escapeHtml(group.tag)}</div>`;
      } else if (hasTags) {
        html += `<div class="organize-tag-header" style="opacity:0.5">Uncategorized</div>`;
      }
      for (const ch of group.items) {
        const name = getDmName(ch);
        const sel = ch.code === this._dmOrganizeSelected ? ' selected' : '';
        const tagBadge = assignments[ch.code] ? `<span class="organize-tag-badge">${this._escapeHtml(assignments[ch.code])}</span>` : '';
        html += `<div class="organize-item${sel}" data-code="${ch.code}">
          <span class="organize-item-name">@ ${this._escapeHtml(name)}</span>
          ${tagBadge}
        </div>`;
      }
    }
    listEl.innerHTML = html || '<p class="muted-text">No DMs to organize</p>';

    // Click to select
    listEl.querySelectorAll('.organize-item').forEach(el => {
      el.addEventListener('click', () => {
        this._dmOrganizeSelected = el.dataset.code;
        listEl.querySelectorAll('.organize-item').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        // Pre-fill tag input with current tag
        const currentTag = assignments[el.dataset.code] || '';
        document.getElementById('dm-organize-tag-input').value = currentTag;
        this._updateDmOrganizeButtons();
      });
    });
    this._updateDmOrganizeButtons();
  }

  _updateDmOrganizeButtons() {
    const sortMode = document.getElementById('dm-organize-sort').value;
    const isManual = sortMode === 'manual';
    document.getElementById('dm-organize-move-up').disabled = !isManual || !this._dmOrganizeSelected;
    document.getElementById('dm-organize-move-down').disabled = !isManual || !this._dmOrganizeSelected;
    document.getElementById('dm-organize-set-tag').disabled = !this._dmOrganizeSelected;
    document.getElementById('dm-organize-remove-tag').disabled = !this._dmOrganizeSelected;
  }

  _openWebhookModal(channelCode) {
    const ch = this.channels.find(c => c.code === channelCode);
    const modal = document.getElementById('webhook-modal');
    modal._channelCode = channelCode;
    document.getElementById('webhook-modal-channel-name').textContent = ch ? `# ${ch.name}` : '';
    document.getElementById('webhook-name-input').value = '';
    document.getElementById('webhook-token-reveal').style.display = 'none';
    document.getElementById('webhook-list').innerHTML = '<p style="opacity:0.5;font-size:0.85rem">Loading…</p>';
    modal.style.display = 'flex';
    this.socket.emit('get-webhooks', { channelCode });
  }

  _renderWebhookList(webhooks, channelCode) {
    const container = document.getElementById('webhook-list');
    if (!webhooks.length) {
      container.innerHTML = '<p style="opacity:0.5;font-size:0.85rem">No webhooks yet. Create one above.</p>';
      return;
    }
    container.innerHTML = webhooks.map(wh => {
      const maskedToken = wh.token.slice(0, 8) + '••••••••';
      const statusLabel = wh.is_active ? '🟢 Active' : '🔴 Disabled';
      const toggleLabel = wh.is_active ? 'Disable' : 'Enable';
      return `
        <div class="webhook-item" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.04);margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:0.9rem">${this._escapeHtml(wh.name)}</div>
            <div style="font-size:0.75rem;opacity:0.5;font-family:monospace">${maskedToken}</div>
          </div>
          <span style="font-size:0.75rem;white-space:nowrap">${statusLabel}</span>
          <button class="btn-xs webhook-toggle-btn" data-id="${wh.id}" style="font-size:0.75rem">${toggleLabel}</button>
          <button class="btn-xs webhook-delete-btn" data-id="${wh.id}" style="font-size:0.75rem;color:#ff4444">🗑️</button>
        </div>`;
    }).join('');

    container.querySelectorAll('.webhook-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Delete this webhook? This cannot be undone.')) {
          this.socket.emit('delete-webhook', { webhookId: parseInt(btn.dataset.id) });
        }
      });
    });
    container.querySelectorAll('.webhook-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.socket.emit('toggle-webhook', { webhookId: parseInt(btn.dataset.id) });
      });
    });
  }

  _renderChannels() {
    const list = document.getElementById('channel-list');
    list.innerHTML = '';

    const regularChannels = this.channels.filter(c => !c.is_dm);
    const dmChannels = this.channels.filter(c => c.is_dm);

    // Build parent → sub-channel tree
    const parentChannels = regularChannels.filter(c => !c.parent_channel_id);
    const subChannelMap = {};
    regularChannels.filter(c => c.parent_channel_id).forEach(c => {
      if (!subChannelMap[c.parent_channel_id]) subChannelMap[c.parent_channel_id] = [];
      subChannelMap[c.parent_channel_id].push(c);
    });

    // Sort sub-channels — respect parent's sort_alphabetical setting & per-tag overrides
    // sort_alphabetical: 0=manual, 1=alpha, 2=created, 3=oldest
    // Per-tag overrides (from organize modal) are stored in localStorage
    Object.entries(subChannelMap).forEach(([parentId, arr]) => {
      const parent = parentChannels.find(p => p.id === parseInt(parentId));
      const globalSortMode = parent ? parent.sort_alphabetical : 0;
      const hasTags = arr.some(c => c.category);

      // Load per-tag sort overrides
      const tagOverrides = parent ? JSON.parse(localStorage.getItem(`haven_tag_sorts_${parent.code}`) || '{}') : {};

      // Tag grouping helper (groups by tag name)
      const tagGroup = (a, b) => {
        const tagA = (a.category || '').toLowerCase();
        const tagB = (b.category || '').toLowerCase();
        if (tagA !== tagB) {
          if (!tagA) return 1;
          if (!tagB) return -1;
          return tagA.localeCompare(tagB);
        }
        return 0;
      };

      // Sort function for a given mode
      const sortByMode = (a, b, mode) => {
        if (mode === 1 || mode === 'alpha') return a.name.localeCompare(b.name);
        if (mode === 2 || mode === 'created') return (b.id || 0) - (a.id || 0);
        if (mode === 3 || mode === 'oldest') return (a.id || 0) - (b.id || 0);
        return (a.position || 0) - (b.position || 0); // manual
      };

      // Map string modes to numbers for consistency
      const modeToNum = (m) => m === 'alpha' ? 1 : m === 'created' ? 2 : m === 'oldest' ? 3 : m === 'manual' ? 0 : m;

      if (hasTags) {
        // Sort by tag group first, then within each group use per-tag override or global
        arr.sort((a, b) => {
          const g = tagGroup(a, b);
          if (g !== 0) return g;
          // Same tag group — check per-tag override
          const tag = a.category || '__untagged__';
          const override = tagOverrides[tag];
          const effectiveMode = override !== undefined ? modeToNum(override) : globalSortMode;
          return sortByMode(a, b, effectiveMode);
        });
      } else {
        arr.sort((a, b) => sortByMode(a, b, globalSortMode));
      }
    });

    // Sort parent channels — respect server-level sort mode & per-tag overrides
    const serverSortMode = localStorage.getItem('haven_server_sort_mode') || 'manual';
    const serverTagOverrides = JSON.parse(localStorage.getItem('haven_tag_sorts___server__') || '{}');
    const parentHasTags = parentChannels.some(c => c.category);

    const serverSortByMode = (a, b, mode) => {
      if (mode === 'alpha') return a.name.localeCompare(b.name);
      if (mode === 'created') return (b.id || 0) - (a.id || 0);
      if (mode === 'oldest') return (a.id || 0) - (b.id || 0);
      return (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name); // manual
    };

    if (parentHasTags) {
      const tagGroup = (a, b) => {
        const tagA = (a.category || '').toLowerCase();
        const tagB = (b.category || '').toLowerCase();
        if (tagA !== tagB) {
          if (!tagA) return 1;
          if (!tagB) return -1;
          return tagA.localeCompare(tagB);
        }
        return 0;
      };
      parentChannels.sort((a, b) => {
        const g = tagGroup(a, b);
        if (g !== 0) return g;
        const tag = a.category || '__untagged__';
        const override = serverTagOverrides[tag];
        const effectiveMode = override !== undefined ? override : serverSortMode;
        return serverSortByMode(a, b, effectiveMode);
      });
    } else {
      parentChannels.sort((a, b) => serverSortByMode(a, b, serverSortMode));
    }

    const renderChannelItem = (ch, isSub) => {
      const el = document.createElement('div');
      el.className = 'channel-item' + (isSub ? ' sub-channel-item' : '') + (ch.is_private ? ' private-channel' : '') + (ch.code === this.currentChannel ? ' active' : '');
      el.dataset.code = ch.code;
      if (isSub) el.dataset.parentId = ch.parent_channel_id;

      const hasSubs = !isSub && (subChannelMap[ch.id] || []).length > 0;
      const isCollapsed = hasSubs && localStorage.getItem(`haven_subs_collapsed_${ch.code}`) === 'true';

      const hashIcon = isSub ? (ch.is_private ? '🔒' : '↳') : '#';

      // Build small status indicators for channel features
      let indicators = '';
      if (!isSub) {
        const badges = [];
        if (ch.streams_enabled === 0) badges.push('<span title="Streams disabled" style="opacity:0.4;font-size:0.65rem">🖥️</span>');
        if (ch.music_enabled === 0) badges.push('<span title="Music disabled" style="opacity:0.4;font-size:0.65rem">🎵</span>');
        if (ch.slow_mode_interval > 0) badges.push('<span title="Slow mode: ' + ch.slow_mode_interval + 's" style="opacity:0.5;font-size:0.65rem">🐢</span>');
        if (badges.length) indicators = `<span class="channel-indicators" style="margin-left:auto;display:flex;gap:2px;flex-shrink:0">${badges.join('')}</span>`;
      }

      el.innerHTML = `
        ${hasSubs ? `<span class="channel-collapse-arrow${isCollapsed ? ' collapsed' : ''}" title="Expand/collapse sub-channels">▾</span>` : ''}
        <span class="channel-hash">${hashIcon}</span>
        <span class="channel-name">${this._escapeHtml(ch.name)}</span>
        ${indicators}
        <button class="channel-more-btn" title="Channel options">⋯</button>
      `;

      // If parent has sub-channels, clicking the arrow toggles them
      if (hasSubs) {
        const arrow = el.querySelector('.channel-collapse-arrow');
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = arrow.classList.toggle('collapsed');
          localStorage.setItem(`haven_subs_collapsed_${ch.code}`, collapsed);
          document.querySelectorAll(`.sub-channel-item[data-parent-id="${ch.id}"], .sub-tag-label[data-parent-id="${ch.id}"]`).forEach(sub => {
            sub.style.display = collapsed ? 'none' : '';
          });
        });
      }

      const count = (ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0);
      if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'channel-badge';
        badge.textContent = count > 99 ? '99+' : count;
        el.appendChild(badge);
      }

      el.addEventListener('click', () => this.switchChannel(ch.code));
      // Right-click to open context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const btn = el.querySelector('.channel-more-btn');
        if (btn) this._openChannelCtxMenu(ch.code, btn);
      });
      return el;
    };

    // ── Channels toggle (collapsible) ──
    const channelsCollapsed = localStorage.getItem('haven_channels_collapsed') === 'true';
    const channelsArrow = document.getElementById('channels-toggle-arrow');
    if (channelsArrow) {
      channelsArrow.classList.toggle('collapsed', channelsCollapsed);
    }

    // Set up channels toggle click (only once)
    if (!this._channelsToggleBound) {
      this._channelsToggleBound = true;
      document.getElementById('channels-toggle')?.addEventListener('click', (e) => {
        // Ignore clicks on the organize button inside the header
        if (e.target.closest('#organize-channels-btn')) return;
        const nowCollapsed = list.style.display !== 'none';
        list.style.display = nowCollapsed ? 'none' : '';
        const arrow = document.getElementById('channels-toggle-arrow');
        if (arrow) arrow.classList.toggle('collapsed', nowCollapsed);
        localStorage.setItem('haven_channels_collapsed', nowCollapsed);
        // Adjust pane flex so DMs fill when channels collapsed
        const channelsPane = document.getElementById('channels-pane');
        const dmPane = document.getElementById('dm-pane');
        if (nowCollapsed) {
          channelsPane.style.flex = '0 0 auto';
          dmPane.style.flex = '1 1 0';
        } else {
          const savedRatio = localStorage.getItem('haven_sidebar_split_ratio');
          const ratio = savedRatio ? parseFloat(savedRatio) : 0.6;
          channelsPane.style.flex = `${ratio} 1 0`;
          dmPane.style.flex = `${1 - ratio} 1 0`;
        }
      });
      // Organize Channels button (admin only)
      document.getElementById('organize-channels-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openOrganizeModal(null, true); // server-level mode
      });
    }
    if (channelsCollapsed) {
      list.style.display = 'none';
      const cp = document.getElementById('channels-pane');
      const dp = document.getElementById('dm-pane');
      if (cp) cp.style.flex = '0 0 auto';
      if (dp) dp.style.flex = '1 1 0';
    }

    // ── Render channels grouped by category ──
    const categories = new Map();
    parentChannels.forEach(ch => {
      const cat = ch.category || '';
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat).push(ch);
    });

    const sortedCats = [...categories.keys()].sort((a, b) => {
      if (!a) return -1; if (!b) return 1;
      return a.localeCompare(b);
    });

    for (const cat of sortedCats) {
      if (cat) {
        const catLabel = document.createElement('h5');
        catLabel.className = 'section-label category-label';
        catLabel.style.cssText = 'padding:10px 12px 4px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.5;user-select:none';
        catLabel.textContent = cat;
        list.appendChild(catLabel);
      }

      categories.get(cat).forEach(ch => {
        list.appendChild(renderChannelItem(ch, false));
        const subs = subChannelMap[ch.id] || [];
        const isCollapsed = localStorage.getItem(`haven_subs_collapsed_${ch.code}`) === 'true';
        const subHasTags = subs.some(s => s.category);
        let lastSubTag = undefined;
        subs.forEach(sub => {
          if (subHasTags && sub.category !== lastSubTag) {
            const tagLabel = document.createElement('div');
            tagLabel.className = 'sub-channel-item sub-tag-label';
            tagLabel.dataset.parentId = ch.id;
            tagLabel.style.cssText = 'padding:4px 12px 2px 28px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.35;user-select:none;font-weight:600';
            tagLabel.textContent = sub.category || 'Untagged';
            if (isCollapsed) tagLabel.style.display = 'none';
            list.appendChild(tagLabel);
            lastSubTag = sub.category;
          }
          const subEl = renderChannelItem(sub, true);
          if (isCollapsed) subEl.style.display = 'none';
          list.appendChild(subEl);
        });
      });
    }

    // ── DM section (separate pane) ──
    const dmList = document.getElementById('dm-list');
    if (dmList) {
      dmList.innerHTML = '';
      const dmCollapsed = localStorage.getItem('haven_dm_collapsed') === 'true';
      const dmArrow = document.getElementById('dm-toggle-arrow');

      // Set up DM toggle click (only once)
      if (!this._dmToggleBound) {
        this._dmToggleBound = true;
        document.getElementById('dm-toggle-header')?.addEventListener('click', (e) => {
          if (e.target.closest('#organize-dms-btn')) return;
          const nowCollapsed = dmList.style.display !== 'none';
          dmList.style.display = nowCollapsed ? 'none' : '';
          const arrow = document.getElementById('dm-toggle-arrow');
          if (arrow) arrow.classList.toggle('collapsed', nowCollapsed);
          localStorage.setItem('haven_dm_collapsed', nowCollapsed);
        });
      }

      if (dmArrow) dmArrow.classList.toggle('collapsed', dmCollapsed);
      if (dmCollapsed) dmList.style.display = 'none';

      // Update unread badge
      const totalUnread = dmChannels.reduce((sum, ch) => sum + ((ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0)), 0);
      const badge = document.getElementById('dm-unread-badge');
      if (badge) {
        if (totalUnread > 0) {
          badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }

      // Show/hide DM pane
      const dmPane = document.getElementById('dm-pane');
      if (dmPane) dmPane.style.display = dmChannels.length ? '' : 'none';

      // ── DM categorization (client-side localStorage) ──
      const dmAssignments = JSON.parse(localStorage.getItem('haven_dm_assignments') || '{}');
      const dmCategories = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
      const dmSortMode = localStorage.getItem('haven_dm_sort_mode') || 'manual';
      const dmOrder = JSON.parse(localStorage.getItem('haven_dm_order') || '[]');

      const getDmName = (ch) => ch.dm_target ? ch.dm_target.username : 'Unknown';

      // Sort DMs by saved order first, then append any new ones
      let sortedDms = [];
      if (dmSortMode === 'manual' && dmOrder.length) {
        for (const code of dmOrder) {
          const ch = dmChannels.find(c => c.code === code);
          if (ch) sortedDms.push(ch);
        }
        for (const ch of dmChannels) {
          if (!sortedDms.includes(ch)) sortedDms.push(ch);
        }
      } else if (dmSortMode === 'alpha') {
        sortedDms = [...dmChannels].sort((a, b) => getDmName(a).localeCompare(getDmName(b)));
      } else if (dmSortMode === 'recent') {
        sortedDms = [...dmChannels].sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
      } else {
        sortedDms = [...dmChannels];
      }

      // Collect active tag names from assigned DMs
      const activeTags = [...new Set(sortedDms.map(c => dmAssignments[c.code]).filter(Boolean))].sort();
      const hasDmTags = activeTags.length > 0;

      const renderDmItem = (ch) => {
        const el = document.createElement('div');
        el.className = 'channel-item dm-item' + (ch.code === this.currentChannel ? ' active' : '');
        el.dataset.code = ch.code;
        const dmName = getDmName(ch);
        el.innerHTML = `
          <span class="channel-hash">@</span>
          <span class="channel-name">${this._escapeHtml(dmName)}</span>
        `;
        const count = (ch.code in this.unreadCounts) ? this.unreadCounts[ch.code] : (ch.unreadCount || 0);
        if (count > 0) {
          const bdg = document.createElement('span');
          bdg.className = 'channel-badge';
          bdg.textContent = count > 99 ? '99+' : count;
          el.appendChild(bdg);
        }
        // "..." more button for DM context menu
        const moreBtn = document.createElement('button');
        moreBtn.className = 'channel-more-btn dm-more-btn';
        moreBtn.textContent = '⋯';
        moreBtn.title = 'More options';
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._openDmCtxMenu(ch.code, moreBtn);
        });
        el.appendChild(moreBtn);
        // Right-click context menu
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._openDmCtxMenu(ch.code, el, e);
        });
        el.addEventListener('click', () => this.switchChannel(ch.code));
        return el;
      };

      if (hasDmTags) {
        // Render by category groups
        for (const tag of activeTags) {
          const tagDms = sortedDms.filter(c => dmAssignments[c.code] === tag);
          if (!tagDms.length) continue;

          const catState = dmCategories[tag] || {};
          const isCollapsed = catState.collapsed || false;

          // Category header
          const header = document.createElement('div');
          header.className = 'dm-category-header';
          header.innerHTML = `<span class="dm-category-arrow${isCollapsed ? ' collapsed' : ''}">▾</span> <span class="dm-category-name">${this._escapeHtml(tag)}</span>`;
          header.style.cursor = 'pointer';
          header.addEventListener('click', () => {
            const cats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
            if (!cats[tag]) cats[tag] = {};
            cats[tag].collapsed = !cats[tag].collapsed;
            localStorage.setItem('haven_dm_categories', JSON.stringify(cats));
            this._renderChannels();
          });
          dmList.appendChild(header);

          for (const ch of tagDms) {
            const el = renderDmItem(ch);
            if (isCollapsed) el.style.display = 'none';
            el.dataset.dmTag = tag;
            dmList.appendChild(el);
          }
        }
        // Untagged DMs
        const untagged = sortedDms.filter(c => !dmAssignments[c.code]);
        if (untagged.length) {
          const uncatCats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
          const uncatCollapsed = uncatCats['__uncategorized__']?.collapsed || false;
          const header = document.createElement('div');
          header.className = 'dm-category-header';
          header.style.opacity = '0.5';
          header.style.cursor = 'pointer';
          header.innerHTML = `<span class="dm-category-arrow${uncatCollapsed ? ' collapsed' : ''}">▾</span> <span class="dm-category-name">Uncategorized</span>`;
          header.addEventListener('click', () => {
            const cats = JSON.parse(localStorage.getItem('haven_dm_categories') || '{}');
            if (!cats['__uncategorized__']) cats['__uncategorized__'] = {};
            cats['__uncategorized__'].collapsed = !cats['__uncategorized__'].collapsed;
            localStorage.setItem('haven_dm_categories', JSON.stringify(cats));
            this._renderChannels();
          });
          dmList.appendChild(header);
          for (const ch of untagged) {
            const el = renderDmItem(ch);
            if (uncatCollapsed) el.style.display = 'none';
            dmList.appendChild(el);
          }
        }
      } else {
        // No tags — flat list (original behavior)
        sortedDms.forEach(ch => dmList.appendChild(renderDmItem(ch)));
      }
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

    // Update the DM section header total badge
    this._updateDmSectionBadge();
  }

  _updateDmSectionBadge() {
    const badge = document.getElementById('dm-unread-badge');
    if (!badge) return;
    const dmChannels = (this.channels || []).filter(c => c.is_dm);
    const total = dmChannels.reduce((sum, ch) => sum + (this.unreadCounts[ch.code] || 0), 0);
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : total;
      badge.style.display = '';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
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
          // Insert before the ⋯ button so they don't overlap
          const moreBtn = el.querySelector('.channel-more-btn');
          if (moreBtn) el.insertBefore(indicator, moreBtn);
          else el.appendChild(indicator);
        }
        indicator.innerHTML = `<span class="voice-icon">🔊</span>${count}`;
      } else if (indicator) {
        indicator.remove();
      }
    });
  }

  // ── Messages ──────────────────────────────────────────

  async _sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    const hasImages = this._imageQueue && this._imageQueue.length > 0;
    if (!content && !hasImages) return;
    if (!this.currentChannel) return;

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
        if (cmd === 'play') {
          if (!arg) { this._showToast('Usage: /play <song name> or /play <url>', 'error'); }
          else if (!this.voice || !this.voice.inVoice) { this._showToast('Join voice first to share music', 'error'); }
          else if (this._getMusicEmbed(arg)) {
            // Direct URL — share immediately
            this.socket.emit('music-share', { code: this.voice.currentChannel, url: arg });
          } else {
            // Not a URL — treat as a search query
            this._musicSearchQuery = arg;
            this._musicSearchOffset = 0;
            this.socket.emit('music-search', { query: arg, offset: 0 });
            this._showToast('Searching…', 'info');
          }
          input.value = '';
          input.style.height = 'auto';
          this._hideMentionDropdown();
          this._hideSlashDropdown();
          return;
        }
        if (cmd === 'gif') {
          if (!arg) { this._showToast('Usage: /gif <search query>', 'error'); }
          else { this._showGifSlashResults(arg); }
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

    // Clear UI immediately (before any async E2E work)
    input.value = '';
    input.style.height = 'auto';
    input.focus();
    this._clearReply();
    this._hideMentionDropdown();
    this._hideSlashDropdown();

    // Send text message if there is one
    if (content) {
      // E2E: encrypt DM messages
      const ch = this.channels.find(c => c.code === this.currentChannel);
      const isDm = ch && ch.is_dm && ch.dm_target;
      let partner = this._getE2EPartner();

      // If DM but partner key not yet cached, request it and wait briefly
      if (isDm && !partner && this.e2e && this.e2e.ready) {
        this.socket.emit('get-public-key', { userId: ch.dm_target.id });
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 100));
          partner = this._getE2EPartner();
          if (partner) break;
        }
        if (!partner) {
          this._showToast('Encryption key unavailable — message sent without E2E', 'warning');
        }
      }

      if (partner) {
        try {
          const encrypted = await this.e2e.encrypt(content, partner.userId, partner.publicKeyJwk);
          payload.content = encrypted;
          payload.encrypted = true;
        } catch (err) {
          console.warn('[E2E] Encryption failed:', err);
          this._showToast('Encryption failed — message sent without E2E', 'warning');
        }
      }
      this.socket.emit('send-message', payload);
    }

    // Upload queued images
    if (hasImages) {
      this._flushImageQueue();
    }
  }

  _renderMessages(messages) {
    const container = document.getElementById('messages');
    container.innerHTML = '';
    messages.forEach((msg, i) => {
      const prevMsg = i > 0 ? messages[i - 1] : null;
      container.appendChild(this._createMessageEl(msg, prevMsg));
    });
    this._scrollToBottom(true);
    // Re-scroll after images load ONLY if user is still near the bottom
    // (prevents snapping back when user is scrolling up through history)
    container.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => this._scrollToBottom(), { once: true });
    });
    // Fetch link previews for all messages
    this._fetchLinkPreviews(container);
    // Mark as read (last message ID)
    if (messages.length > 0) {
      this._markRead(messages[messages.length - 1].id);
    }
  }

  /** Prepend older messages to the top of the messages container, preserving scroll position */
  _prependMessages(messages) {
    const container = document.getElementById('messages');
    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;
    const firstChild = container.firstChild;

    // We need prevMsg chain: older messages are oldest-first, then link to existing first message
    const fragment = document.createDocumentFragment();
    messages.forEach((msg, i) => {
      const prevMsg = i > 0 ? messages[i - 1] : null;
      fragment.appendChild(this._createMessageEl(msg, prevMsg));
    });

    // Re-evaluate grouping of the previously-first message against the new last prepended message
    if (firstChild && firstChild.dataset && messages.length > 0) {
      const lastPrepended = messages[messages.length - 1];
      const firstExisting = firstChild;
      // Check if they should be grouped (same user, close timestamps)
      if (firstExisting.dataset.userId && parseInt(firstExisting.dataset.userId) === lastPrepended.user_id) {
        const timeDiff = new Date(firstExisting.dataset.time) - new Date(lastPrepended.created_at);
        if (timeDiff < 5 * 60 * 1000) {
          // Already compact — that's fine, keep it
        }
      }
    }

    container.insertBefore(fragment, firstChild);

    // Restore scroll position so the view doesn't jump
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);

    // Fetch link previews for prepended messages
    this._fetchLinkPreviews(container);
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
    }
    // Scroll after images load only if user is near the bottom
    const imgs = container.lastElementChild?.querySelectorAll('img');
    if (imgs) imgs.forEach(img => {
      if (!img.complete) img.addEventListener('load', () => this._scrollToBottom(), { once: true });
    });
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
    const e2eTag = msg._e2e ? '<span class="e2e-tag" title="End-to-end encrypted">🔒</span>' : '';

    // Build toolbar with context-aware buttons
    let toolbarBtns = `<button data-action="react" title="React">😀</button><button data-action="reply" title="Reply">↩️</button>`;
    const canPin = this.user.isAdmin || this._canModerate();
    const canDelete = msg.user_id === this.user.id || this.user.isAdmin || this._canModerate();
    if (canPin) {
      toolbarBtns += msg.pinned
        ? `<button data-action="unpin" title="Unpin">📌</button>`
        : `<button data-action="pin" title="Pin">📌</button>`;
    }
    if (msg.user_id === this.user.id) {
      toolbarBtns += `<button data-action="edit" title="Edit">✏️</button>`;
    }
    if (canDelete) {
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
      if (msg._e2e) el.dataset.e2e = '1';
      el.innerHTML = `
        <span class="compact-time">${new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
        <div class="message-body">
          <div class="message-content">${pinnedTag}${this._formatContent(msg.content)}${editedHtml}</div>
          ${reactionsHtml}
        </div>
        ${e2eTag}
        ${toolbarHtml}
      `;
      return el;
    }

    const color = this._getUserColor(msg.username);
    const initial = msg.username.charAt(0).toUpperCase();
    // Look up user's role from online users list
    const onlineUser = this.users ? this.users.find(u => u.id === msg.user_id) : null;
    // Use the message sender's avatar_shape (from server), not the local user's preference
    const msgShape = msg.avatar_shape || (onlineUser && onlineUser.avatarShape) || 'circle';
    const shapeClass = 'avatar-' + msgShape;

    // For imported Discord messages, use the stored Discord avatar or a generic Discord icon
    let avatarHtml;
    if (msg.imported_from === 'discord') {
      const discordAvatar = msg.webhook_avatar;
      if (discordAvatar) {
        avatarHtml = `<img class="message-avatar message-avatar-img ${shapeClass}" src="${this._escapeHtml(discordAvatar)}" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`;
      } else {
        // Generic Discord-style avatar (colored circle with initial)
        avatarHtml = `<div class="message-avatar ${shapeClass} discord-import-avatar" style="background-color:#5865f2">${initial}</div>`;
      }
    } else if (msg.avatar) {
      avatarHtml = `<img class="message-avatar message-avatar-img ${shapeClass}" src="${this._escapeHtml(msg.avatar)}" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`;
    } else {
      avatarHtml = `<div class="message-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;
    }

    const msgRoleBadge = onlineUser && onlineUser.role
      ? `<span class="user-role-badge msg-role-badge" style="color:${onlineUser.role.color || 'var(--text-muted)'}">${this._escapeHtml(onlineUser.role.name)}</span>`
      : '';

    const botBadge = msg.imported_from === 'discord'
      ? '<span class="discord-badge">DISCORD</span>'
      : msg.is_webhook ? '<span class="bot-badge">BOT</span>' : '';

    const el = document.createElement('div');
    el.className = 'message' + (isImage ? ' message-has-image' : '') + (msg.pinned ? ' pinned' : '') + (msg.is_webhook ? ' webhook-message' : '') + (msg.imported_from ? ' imported-message' : '');
    el.dataset.userId = msg.user_id;
    el.dataset.time = msg.created_at;
    el.dataset.msgId = msg.id;
    if (msg.pinned) el.dataset.pinned = '1';
    if (msg._e2e) el.dataset.e2e = '1';
    el.innerHTML = `
      ${replyHtml}
      <div class="message-row">
        ${avatarHtml}
        <div class="message-body">
          <div class="message-header">
            <span class="message-author" style="color:${color}">${this._escapeHtml(msg.username)}</span>
            ${botBadge}
            ${msgRoleBadge}
            <span class="message-time">${this._formatTime(msg.created_at)}</span>
            ${pinnedTag}
            <span class="message-header-spacer"></span>
            ${e2eTag}
          </div>
          <div class="message-content">${this._formatContent(msg.content)}${editedHtml}</div>
          ${reactionsHtml}
        </div>
        ${toolbarHtml}
      </div>
    `;
    return el;
  }

  /**
   * Promote a compact (grouped) message to a full message with avatar + header.
   * Called when the root message of a group is deleted.
   */
  _promoteCompactToFull(compactEl) {
    const userId = parseInt(compactEl.dataset.userId);
    const username = compactEl.dataset.username || 'Unknown';
    const time = compactEl.dataset.time;
    const msgId = compactEl.dataset.msgId;
    const isPinned = compactEl.dataset.pinned === '1';

    // Grab existing inner content & toolbar before replacing
    const contentEl = compactEl.querySelector('.message-content');
    const contentHtml = contentEl ? contentEl.innerHTML : '';
    const toolbarEl = compactEl.querySelector('.msg-toolbar');
    const toolbarHtml = toolbarEl ? toolbarEl.outerHTML : '';
    const reactionsEl = compactEl.querySelector('.reactions-row');
    const reactionsHtml = reactionsEl ? reactionsEl.outerHTML : '';
    const pinnedTag = isPinned ? '<span class="pinned-tag" title="Pinned message">📌</span>' : '';
    const e2eTag = compactEl.dataset.e2e === '1' ? '<span class="e2e-tag" title="End-to-end encrypted">🔒</span>' : '';

    const color = this._getUserColor(username);
    const initial = username.charAt(0).toUpperCase();
    const onlineUser = this.users ? this.users.find(u => u.id === userId) : null;
    const msgShape = (onlineUser && onlineUser.avatarShape) || 'circle';
    const shapeClass = 'avatar-' + msgShape;
    const avatar = onlineUser && onlineUser.avatar;
    const avatarHtml = avatar
      ? `<img class="message-avatar message-avatar-img ${shapeClass}" src="${this._escapeHtml(avatar)}" alt="${initial}"><div class="message-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`
      : `<div class="message-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;

    const msgRoleBadge = onlineUser && onlineUser.role
      ? `<span class="user-role-badge msg-role-badge" style="color:${onlineUser.role.color || 'var(--text-muted)'}">${this._escapeHtml(onlineUser.role.name)}</span>`
      : '';

    // Replace the compact element in-place
    compactEl.className = 'message' + (isPinned ? ' pinned' : '');
    compactEl.dataset.userId = userId;
    compactEl.dataset.time = time;
    compactEl.dataset.msgId = msgId;
    if (isPinned) compactEl.dataset.pinned = '1';
    compactEl.innerHTML = `
      <div class="message-row">
        ${avatarHtml}
        <div class="message-body">
          <div class="message-header">
            <span class="message-author" style="color:${color}">${this._escapeHtml(username)}</span>
            ${msgRoleBadge}
            <span class="message-time">${this._formatTime(time)}</span>
            ${pinnedTag}
            <span class="message-header-spacer"></span>
            ${e2eTag}
          </div>
          <div class="message-content">${contentHtml}</div>
          ${reactionsHtml}
        </div>
        ${toolbarHtml}
      </div>
    `;
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

    // Bind gear button → dropdown menu with mod actions
    if (this.user.isAdmin || this._canModerate() || this._hasPerm('promote_user')) {
      el.querySelectorAll('.user-gear-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const userId = parseInt(btn.dataset.uid);
          const username = btn.dataset.uname;
          this._showUserGearMenu(btn, userId, username);
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

  _showUserGearMenu(anchorEl, userId, username) {
    // Close any existing gear menu
    this._closeUserGearMenu();

    const canMod = this.user.isAdmin || this._canModerate();
    const canPromote = this._hasPerm('promote_user');
    const isAdmin = this.user.isAdmin;

    let items = '';
    if (canPromote) items += `<button class="gear-menu-item" data-action="assign-role">👑 Assign Role</button>`;
    if (canMod) items += `<button class="gear-menu-item" data-action="kick">👢 Kick</button>`;
    if (canMod) items += `<button class="gear-menu-item" data-action="mute">🔇 Mute</button>`;
    if (isAdmin) items += `<button class="gear-menu-item gear-menu-danger" data-action="ban">⛔ Ban</button>`;
    if (isAdmin) items += `<div class="gear-menu-divider"></div><button class="gear-menu-item gear-menu-danger" data-action="transfer-admin">🔑 Transfer Admin</button>`;

    const menu = document.createElement('div');
    menu.className = 'user-gear-menu';
    menu.innerHTML = items;
    document.body.appendChild(menu);

    // Position near the gear button
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 100}px`;

    // Keep in viewport
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
      if (mr.bottom > window.innerHeight - 8) menu.style.top = `${rect.top - mr.height - 4}px`;
      if (mr.left < 8) menu.style.left = '8px';
    });

    // Bind item clicks
    menu.querySelectorAll('.gear-menu-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        this._closeUserGearMenu();
        if (action === 'assign-role') {
          this._loadRoles(() => this._openAssignRoleModal(userId, username));
        } else if (action === 'transfer-admin') {
          this._confirmTransferAdmin(userId, username);
        } else {
          this._showAdminActionModal(action, userId, username);
        }
      });
    });

    // Close on outside click
    setTimeout(() => {
      this._gearMenuOutsideHandler = (e) => {
        if (!menu.contains(e.target)) this._closeUserGearMenu();
      };
      document.addEventListener('click', this._gearMenuOutsideHandler, true);
    }, 10);
  }

  _closeUserGearMenu() {
    const existing = document.querySelector('.user-gear-menu');
    if (existing) existing.remove();
    if (this._gearMenuOutsideHandler) {
      document.removeEventListener('click', this._gearMenuOutsideHandler, true);
      this._gearMenuOutsideHandler = null;
    }
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

    // Avatar: image or letter fallback
    const color = this._getUserColor(u.username);
    const initial = u.username.charAt(0).toUpperCase();
    const shapeClass = 'avatar-' + (u.avatarShape || 'circle');
    const avatarImg = u.avatar
      ? `<img class="user-item-avatar user-item-avatar-img ${shapeClass}" src="${this._escapeHtml(u.avatar)}" alt="${initial}"><div class="user-item-avatar ${shapeClass}" style="background-color:${color};display:none">${initial}</div>`
      : `<div class="user-item-avatar ${shapeClass}" style="background-color:${color}">${initial}</div>`;

    // Wrap avatar + status dot together (Discord-style overlay)
    const avatarHtml = `<div class="user-avatar-wrapper">${avatarImg}<span class="user-status-dot${statusClass ? ' ' + statusClass : ''}"></span></div>`;

    // Role: color dot to the left of name + tooltip on hover
    const roleColor = u.role ? (u.role.color || 'var(--text-muted)') : '';
    const roleDot = u.role
      ? `<span class="user-role-dot" style="background:${roleColor}" title="${this._escapeHtml(u.role.name)}"></span>`
      : '';

    // Keep the old badge for message area (msg-role-badge) but hide in sidebar
    const roleBadge = u.role
      ? `<span class="user-role-badge" style="color:${u.role.color || 'var(--text-muted)'}" title="${this._escapeHtml(u.role.name)}">${this._escapeHtml(u.role.name)}</span>`
      : '';

    // Build tooltip
    const tooltipRole = u.role ? `<div class="tooltip-role" style="color:${roleColor}">● ${this._escapeHtml(u.role.name)}</div>` : '';
    const tooltipStatus = u.statusText ? `<div class="tooltip-status">${this._escapeHtml(u.statusText)}</div>` : '';
    const tooltipOnline = u.online === false ? '<div class="tooltip-status">Offline</div>' : '';
    const tooltip = `<div class="user-item-tooltip"><div class="tooltip-username">${this._escapeHtml(u.username)}</div>${tooltipRole}${tooltipStatus}${tooltipOnline}</div>`;

    const dmBtn = u.id !== this.user.id
      ? `<button class="user-action-btn user-dm-btn" data-dm-uid="${u.id}" title="Direct Message">💬</button>`
      : '';

    // Show DM + Gear icon. Gear opens a dropdown with mod actions.
    const canModThis = (this.user.isAdmin || this._canModerate()) && u.id !== this.user.id;
    const canPromote = this._hasPerm('promote_user') && u.id !== this.user.id;
    const hasGear = canModThis || canPromote;
    const gearBtn = hasGear
      ? `<button class="user-action-btn user-gear-btn" data-uid="${u.id}" data-uname="${this._escapeHtml(u.username)}" title="More Actions">⚙️</button>`
      : '';
    const modBtns = (dmBtn || gearBtn)
      ? `<div class="user-admin-actions">${dmBtn}${gearBtn}</div>`
      : '';
    return `
      <div class="user-item${onlineClass}" data-user-id="${u.id}">
        ${avatarHtml}
        ${roleDot}
        <span class="user-item-name">${this._escapeHtml(u.username)}</span>
        ${roleBadge}
        ${statusTextHtml}
        ${scoreBadge}
        ${modBtns}
        ${tooltip}
      </div>
    `;
  }

  // ── Profile Popup (Discord-style mini profile) ────────

  _showProfilePopup(profile) {
    this._closeProfilePopup();

    const isSelf = profile.id === this.user.id;
    const color = this._getUserColor(profile.username);
    const initial = profile.username.charAt(0).toUpperCase();
    const shapeClass = 'avatar-' + (profile.avatarShape || 'circle');

    const avatarHtml = profile.avatar
      ? `<img class="profile-popup-avatar ${shapeClass}" src="${this._escapeHtml(profile.avatar)}" alt="${initial}">`
      : `<div class="profile-popup-avatar profile-popup-avatar-fallback ${shapeClass}" style="background-color:${color}">${initial}</div>`;

    // Status dot
    const statusClass = profile.status === 'dnd' ? 'dnd' : profile.status === 'away' ? 'away'
      : profile.status === 'invisible' ? 'invisible' : (!profile.online ? 'away' : '');
    const statusLabel = profile.status === 'dnd' ? 'Do Not Disturb' : profile.status === 'away' ? 'Away'
      : profile.status === 'invisible' ? 'Invisible' : (profile.online ? 'Online' : 'Offline');

    // Roles
    const rolesHtml = (profile.roles && profile.roles.length > 0)
      ? profile.roles.map(r =>
          `<span class="profile-popup-role" style="border-color:${r.color || 'var(--border-light)'}; color:${r.color || 'var(--text-secondary)'}"><span class="profile-role-dot" style="background:${r.color || 'var(--text-muted)'}"></span>${this._escapeHtml(r.name)}</span>`
        ).join('')
      : '';

    // Status text badge
    const statusTextHtml = profile.statusText
      ? `<div class="profile-popup-status-text">${this._escapeHtml(profile.statusText)}</div>`
      : '';

    // Bio (with "View Full Bio" toggle for long bios)
    const bioText = profile.bio || '';
    const bioShort = bioText.length > 80 ? bioText.slice(0, 80) + '…' : bioText;
    const bioHtml = bioText
      ? `<div class="profile-popup-bio">
           <span class="profile-bio-short">${this._escapeHtml(bioShort)}</span>
           ${bioText.length > 80 ? `<span class="profile-bio-full" style="display:none">${this._escapeHtml(bioText)}</span><button class="profile-bio-toggle">View Full Bio</button>` : ''}
         </div>`
      : (isSelf ? `<div class="profile-popup-bio profile-bio-empty">No bio yet — click Edit Profile to add one</div>` : '');

    // Join date
    const joinDate = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

    // Action buttons
    const actionsHtml = isSelf
      ? `<button class="profile-popup-action-btn profile-edit-btn" id="profile-popup-edit-btn">✏️ Edit Profile</button>`
      : `<button class="profile-popup-action-btn profile-dm-btn" data-dm-uid="${profile.id}">💬 Message</button>`;

    const popup = document.createElement('div');
    popup.id = 'profile-popup';
    popup.className = 'profile-popup';
    popup.innerHTML = `
      <div class="profile-popup-banner" style="background:linear-gradient(135deg, ${color}44, ${color}22)">
        <button class="profile-popup-close" title="Close">&times;</button>
      </div>
      <div class="profile-popup-avatar-wrapper">
        ${avatarHtml}
        <span class="profile-popup-status-dot ${statusClass}" title="${statusLabel}"></span>
      </div>
      <div class="profile-popup-body">
        <div class="profile-popup-names">
          <span class="profile-popup-displayname">${this._escapeHtml(profile.displayName)}</span>
          <span class="profile-popup-username">@${this._escapeHtml(profile.username)}</span>
        </div>
        ${statusTextHtml}
        ${bioHtml}
        <div class="profile-popup-divider"></div>
        ${rolesHtml ? `<div class="profile-popup-section-label">Roles</div><div class="profile-popup-roles">${rolesHtml}</div>` : ''}
        ${joinDate ? `<div class="profile-popup-section-label">Member Since</div><div class="profile-popup-join-date">${joinDate}</div>` : ''}
        <div class="profile-popup-actions">${actionsHtml}</div>
      </div>
    `;

    document.body.appendChild(popup);

    // Position near the anchor element
    this._positionProfilePopup(popup);

    // Close button
    popup.querySelector('.profile-popup-close').addEventListener('click', () => this._closeProfilePopup());

    // Bio toggle
    const bioToggle = popup.querySelector('.profile-bio-toggle');
    if (bioToggle) {
      bioToggle.addEventListener('click', () => {
        const short = popup.querySelector('.profile-bio-short');
        const full = popup.querySelector('.profile-bio-full');
        if (full.style.display === 'none') {
          full.style.display = '';
          short.style.display = 'none';
          bioToggle.textContent = 'Show Less';
        } else {
          full.style.display = 'none';
          short.style.display = '';
          bioToggle.textContent = 'View Full Bio';
        }
      });
    }

    // DM button
    const dmBtnEl = popup.querySelector('.profile-dm-btn');
    if (dmBtnEl) {
      dmBtnEl.addEventListener('click', () => {
        const targetId = parseInt(dmBtnEl.dataset.dmUid);
        this.socket.emit('start-dm', { targetUserId: targetId });
        this._closeProfilePopup();
        this._showToast(`Opening DM with ${profile.displayName}…`, 'info');
      });
    }

    // Edit profile button (for self)
    const editBtnEl = popup.querySelector('#profile-popup-edit-btn');
    if (editBtnEl) {
      editBtnEl.addEventListener('click', () => {
        this._closeProfilePopup();
        // Open the Edit Profile (rename) modal which now includes avatar + display name + bio
        document.getElementById('rename-modal').style.display = 'flex';
        const input = document.getElementById('rename-input');
        input.value = this.user.displayName || this.user.username;
        input.focus();
        input.select();
        const bioInput = document.getElementById('edit-profile-bio');
        if (bioInput) bioInput.value = this.user.bio || '';
        this._updateAvatarPreview();
        const picker = document.getElementById('avatar-shape-picker');
        if (picker) {
          const currentShape = this.user.avatarShape || localStorage.getItem('haven_avatar_shape') || 'circle';
          picker.querySelectorAll('.avatar-shape-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.shape === currentShape);
          });
          this._pendingAvatarShape = currentShape;
        }
      });
    }

    // Close on outside click (delay to avoid instant close)
    setTimeout(() => {
      this._profilePopupOutsideHandler = (e) => {
        if (!popup.contains(e.target)) this._closeProfilePopup();
      };
      document.addEventListener('click', this._profilePopupOutsideHandler);
    }, 50);
  }

  _positionProfilePopup(popup) {
    const anchor = this._profilePopupAnchor;
    if (!anchor) {
      // Center fallback
      popup.style.left = '50%';
      popup.style.top = '50%';
      popup.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const pw = 320; // popup width
    const ph = 400; // estimated max height

    let left = rect.left + rect.width / 2 - pw / 2;
    let top = rect.bottom + 8;

    // Keep within viewport
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) {
      top = rect.top - ph - 8;
      if (top < 8) top = 8;
    }

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  _closeProfilePopup() {
    const existing = document.getElementById('profile-popup');
    if (existing) existing.remove();
    if (this._profilePopupOutsideHandler) {
      document.removeEventListener('click', this._profilePopupOutsideHandler);
      this._profilePopupOutsideHandler = null;
    }
  }

  _openEditProfileModal(profile) {
    // Create a simple modal for editing bio and status
    this._closeProfilePopup();
    const existing = document.getElementById('edit-profile-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'edit-profile-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal edit-profile-modal-box">
        <h3>Edit Profile</h3>
        <label class="edit-profile-label">Bio <span class="muted-text">(max 190 chars)</span></label>
        <textarea id="edit-profile-bio" class="edit-profile-textarea" maxlength="190" placeholder="Tell people about yourself…">${this._escapeHtml(profile.bio || '')}</textarea>
        <div class="edit-profile-char-count"><span id="edit-profile-chars">${(profile.bio || '').length}</span>/190</div>
        <div class="modal-actions">
          <button class="btn-sm" id="edit-profile-cancel">Cancel</button>
          <button class="btn-sm btn-accent" id="edit-profile-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const bioInput = document.getElementById('edit-profile-bio');
    const charCount = document.getElementById('edit-profile-chars');

    bioInput.addEventListener('input', () => {
      charCount.textContent = bioInput.value.length;
    });
    bioInput.focus();

    document.getElementById('edit-profile-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    document.getElementById('edit-profile-save').addEventListener('click', () => {
      this.socket.emit('set-bio', { bio: bioInput.value });
      modal.remove();
    });
  }

  // ── Voice Users ───────────────────────────────────────

  _renderVoiceUsers(users) {
    this._lastVoiceUsers = users; // Cache for re-render on stream info updates
    const el = document.getElementById('voice-users');
    if (users.length === 0) {
      el.innerHTML = '<p class="muted-text">No one in voice</p>';
      return;
    }
    const streams = this._streamInfo || [];
    el.innerHTML = users.map(u => {
      const isSelf = u.id === this.user.id;
      const talking = this.voice && ((isSelf && this.voice.talkingState.get('self')) || this.voice.talkingState.get(u.id));
      const dotColor = u.roleColor || '';
      const dotStyle = dotColor ? ` style="background:${dotColor};--voice-dot-color:${dotColor}"` : '';

      // Stream indicators: is this user streaming? watching?
      const isStreaming = streams.some(s => s.sharerId === u.id);
      const watchingStreams = streams.filter(s => s.viewers.some(v => v.id === u.id));
      const isWatching = watchingStreams.length > 0;
      let streamBadge = '';
      if (isStreaming) {
        const myStream = streams.find(s => s.sharerId === u.id);
        const viewerCount = myStream ? myStream.viewers.length : 0;
        streamBadge = `<span class="voice-stream-badge live" title="Streaming${viewerCount ? ' · ' + viewerCount + ' viewer' + (viewerCount > 1 ? 's' : '') : ''}">🔴 LIVE${viewerCount ? ' · ' + viewerCount : ''}</span>`;
      }
      if (isWatching) {
        const watchNames = watchingStreams.map(s => s.sharerName).join(', ');
        streamBadge += `<span class="voice-stream-badge watching" title="Watching ${watchNames}">👁</span>`;
      }

      return `
        <div class="user-item voice-user-item${talking ? ' talking' : ''}" data-user-id="${u.id}"${dotColor ? ` style="--voice-dot-color:${dotColor}"` : ''}>
          <span class="user-dot voice"${dotStyle}></span>
          <span class="user-item-name">${this._escapeHtml(u.username)}</span>
          ${streamBadge}
          ${isSelf ? '<span class="you-tag">you</span>' : `<button class="voice-user-menu-btn" data-user-id="${u.id}" data-username="${this._escapeHtml(u.username)}" title="User options">⋯</button>`}
        </div>
      `;
    }).join('');

    // Bind "..." buttons to open per-user voice submenu
    el.querySelectorAll('.voice-user-menu-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const userId = parseInt(btn.dataset.userId);
        const username = btn.dataset.username;
        this._showVoiceUserMenu(btn, userId, username);
      });
    });

    // Bind voice user names/items to open profile popup (same as sidebar)
    el.querySelectorAll('.voice-user-item').forEach(item => {
      const nameEl = item.querySelector('.user-item-name');
      if (nameEl) {
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const userId = parseInt(item.dataset.userId);
          if (!isNaN(userId)) {
            this._profilePopupAnchor = nameEl;
            this.socket.emit('get-user-profile', { userId });
          }
        });
      }
    });
  }

  _showVoiceUserMenu(anchorEl, userId, username) {
    this._closeVoiceUserMenu();

    const savedVol = this._getVoiceVolume(userId);
    const isMuted = savedVol === 0;
    const isDeafened = this.voice ? this.voice.isUserDeafened(userId) : false;
    // Show voice kick for admins and mods with kick_user permission
    const canKick = this._hasPerm('kick_user');
    const menu = document.createElement('div');
    menu.className = 'voice-user-menu';
    menu.innerHTML = `
      <div class="voice-user-menu-header">${this._escapeHtml(username)}</div>
      <div class="voice-user-menu-row">
        <span class="voice-user-menu-label">🔊 Volume</span>
        <input type="range" class="volume-slider voice-user-vol-slider" min="0" max="200" value="${savedVol}" title="Volume: ${savedVol}%">
        <span class="voice-user-vol-value">${savedVol}%</span>
      </div>
      <div class="voice-user-menu-actions">
        <button class="voice-user-menu-action" data-action="mute-user">${isMuted ? '🔊 Unmute' : '🔇 Mute'}</button>
        <button class="voice-user-menu-action ${isDeafened ? 'active' : ''}" data-action="deafen-user">${isDeafened ? '🔊 Undeafen' : '🔇 Deafen'}</button>
        ${canKick ? `<button class="voice-user-menu-action danger" data-action="voice-kick" title="Remove from voice channel">🚪 Voice Kick</button>` : ''}
      </div>
      <div class="voice-user-menu-hint">
        <small>Mute = you can't hear them</small><br>
        <small>Deafen = they can't hear you</small>
      </div>
    `;
    document.body.appendChild(menu);

    // Position
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left - 140}px`;
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
      if (mr.bottom > window.innerHeight - 8) menu.style.top = `${rect.top - mr.height - 4}px`;
      if (mr.left < 8) menu.style.left = '8px';
    });

    // Bind volume slider
    const slider = menu.querySelector('.voice-user-vol-slider');
    const volLabel = menu.querySelector('.voice-user-vol-value');
    slider.addEventListener('input', () => {
      const vol = parseInt(slider.value);
      slider.title = `Volume: ${vol}%`;
      volLabel.textContent = `${vol}%`;
      this._setVoiceVolume(userId, vol);
      if (this.voice) this.voice.setVolume(userId, vol / 100);
    });

    // Bind mute/deafen actions
    menu.querySelectorAll('.voice-user-menu-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.action === 'mute-user') {
          // Mute: toggle their volume to 0 so YOU can't hear THEM
          const newVol = parseInt(slider.value) === 0 ? 100 : 0;
          slider.value = newVol;
          volLabel.textContent = `${newVol}%`;
          this._setVoiceVolume(userId, newVol);
          if (this.voice) this.voice.setVolume(userId, newVol / 100);
          btn.textContent = newVol === 0 ? '🔊 Unmute' : '🔇 Mute';
        } else if (btn.dataset.action === 'deafen-user') {
          // Deafen: stop sending YOUR audio to THEM (they can't hear you)
          if (this.voice) {
            if (this.voice.isUserDeafened(userId)) {
              this.voice.undeafenUser(userId);
              btn.textContent = '🔇 Deafen';
              btn.classList.remove('active');
              this._showToast(`${this._escapeHtml(username)} can hear you again`, 'info');
            } else {
              this.voice.deafenUser(userId);
              btn.textContent = '🔊 Undeafen';
              btn.classList.add('active');
              this._showToast(`${this._escapeHtml(username)} can no longer hear you`, 'info');
            }
          }
        } else if (btn.dataset.action === 'voice-kick') {
          // Voice Kick: remove this user from voice (server enforces level check)
          if (this.voice && this.voice.inVoice) {
            this.socket.emit('voice-kick', { code: this.voice.currentChannel, userId });
            this._closeVoiceUserMenu();
          }
        }
      });
    });

    // Close on outside click
    setTimeout(() => {
      this._voiceUserMenuHandler = (e) => {
        if (!menu.contains(e.target)) this._closeVoiceUserMenu();
      };
      document.addEventListener('click', this._voiceUserMenuHandler, true);
    }, 10);
  }

  _closeVoiceUserMenu() {
    const existing = document.querySelector('.voice-user-menu');
    if (existing) existing.remove();
    if (this._voiceUserMenuHandler) {
      document.removeEventListener('click', this._voiceUserMenuHandler, true);
      this._voiceUserMenuHandler = null;
    }
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
      this.notifications.playDirect('voice_join');
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
    this._hideMusicPanel();
    this._showToast('Left voice chat', 'info');
  }

  _toggleMute() {
    const muted = this.voice.toggleMute();
    const btn = document.getElementById('voice-mute-btn');
    btn.textContent = '🎙️';
    btn.title = muted ? 'Unmute' : 'Mute';
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
    btn.textContent = deafened ? '�' : '🔊';
    btn.title = deafened ? 'Undeafen' : 'Deafen';
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
    // Show/hide the header voice-active indicator (not a button, just a label)
    const indicator = document.getElementById('voice-active-indicator');
    if (indicator) indicator.style.display = inVoice ? 'inline-flex' : 'none';

    // Show/hide the sidebar voice controls panel (pinned at bottom)
    const voicePanel = document.getElementById('voice-panel');
    if (voicePanel) voicePanel.style.display = inVoice ? 'flex' : 'none';

    // Mobile voice join in right sidebar
    const mobileJoin = document.getElementById('voice-join-mobile');
    if (mobileJoin) mobileJoin.style.display = inVoice ? 'none' : '';

    if (!inVoice) {
      document.getElementById('voice-mute-btn').textContent = '🎙️';
      document.getElementById('voice-mute-btn').title = 'Mute';
      document.getElementById('voice-mute-btn').classList.remove('muted');
      document.getElementById('voice-deafen-btn').textContent = '🔊';
      document.getElementById('voice-deafen-btn').title = 'Deafen';
      document.getElementById('voice-deafen-btn').classList.remove('muted');
      document.getElementById('screen-share-btn').textContent = '🖥️';
      document.getElementById('screen-share-btn').title = 'Share Screen';
      document.getElementById('screen-share-btn').classList.remove('sharing');
      document.getElementById('voice-ns-slider').value = 10;
      // Hide voice settings sub-panel
      const vsPanel = document.getElementById('voice-settings-panel');
      if (vsPanel) vsPanel.style.display = 'none';
      const vsBtn = document.getElementById('voice-settings-toggle');
      if (vsBtn) vsBtn.classList.remove('active');
      // Clear all stream tiles so no ghost tiles persist after leaving voice
      const grid = document.getElementById('screen-share-grid');
      grid.querySelectorAll('video').forEach(v => { v.srcObject = null; });
      grid.innerHTML = '';
      document.getElementById('screen-share-container').style.display = 'none';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
      this._hideMusicPanel();
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
      document.getElementById('screen-share-btn').textContent = '🖥️';
      document.getElementById('screen-share-btn').title = 'Share Screen';
      document.getElementById('screen-share-btn').classList.remove('sharing');
      this._showToast('Stopped screen sharing', 'info');
    } else {
      const ok = await this.voice.shareScreen();
      if (ok) {
        document.getElementById('screen-share-btn').textContent = '🛑';
        document.getElementById('screen-share-btn').title = 'Stop Sharing';
        document.getElementById('screen-share-btn').classList.add('sharing');
        // Show our own screen in the viewer
        this._handleScreenStream(this.user.id, this.voice.screenStream);
        // Show audio/no-audio badge
        if (this.voice.screenHasAudio) {
          this._handleScreenAudio(this.user.id);
          this._showToast('Screen sharing started with audio', 'success');
        } else {
          this._handleScreenNoAudio(this.user.id);
          this._showToast('Screen sharing started (no audio — enable it in the browser picker)', 'info');
        }
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

        // Audio controls overlay (volume + mute for stream audio)
        const controls = document.createElement('div');
        controls.className = 'stream-audio-controls';
        controls.id = `stream-controls-${userId || 'self'}`;

        const muteBtn = document.createElement('button');
        muteBtn.className = 'stream-mute-btn';
        muteBtn.title = 'Mute/Unmute stream audio';
        muteBtn.textContent = '🔊';
        muteBtn.dataset.muted = 'false';

        const volSlider = document.createElement('input');
        volSlider.type = 'range';
        volSlider.className = 'stream-vol-slider';
        volSlider.min = '0';
        volSlider.max = '200';
        volSlider.title = 'Stream volume (0–200%)';

        const volPct = document.createElement('span');
        volPct.className = 'stream-vol-pct';

        // Restore saved volume
        try {
          const savedVols = JSON.parse(localStorage.getItem('haven_stream_volumes') || '{}');
          const sv = savedVols[userId] ?? 100;
          volSlider.value = String(sv);
          volPct.textContent = sv + '%';
        } catch { volSlider.value = '100'; volPct.textContent = '100%'; }

        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isMuted = muteBtn.dataset.muted === 'true';
          if (isMuted) {
            const vol = parseFloat(volSlider.value) / 100;
            this.voice.setStreamVolume(userId, vol);
            muteBtn.textContent = '🔊';
            muteBtn.dataset.muted = 'false';
            muteBtn.classList.remove('muted');
          } else {
            this.voice.setStreamVolume(userId, 0);
            muteBtn.textContent = '🔇';
            muteBtn.dataset.muted = 'true';
            muteBtn.classList.add('muted');
          }
        });

        volSlider.addEventListener('input', (e) => {
          e.stopPropagation();
          const val = parseInt(volSlider.value);
          this.voice.setStreamVolume(userId, val / 100);
          volPct.textContent = val + '%';
          muteBtn.textContent = val === 0 ? '🔇' : '🔊';
          muteBtn.dataset.muted = val === 0 ? 'true' : 'false';
          muteBtn.classList.toggle('muted', val === 0);
          try {
            const vols = JSON.parse(localStorage.getItem('haven_stream_volumes') || '{}');
            vols[userId] = val;
            localStorage.setItem('haven_stream_volumes', JSON.stringify(vols));
          } catch {}
        });

        controls.appendChild(muteBtn);
        controls.appendChild(volSlider);
        controls.appendChild(volPct);
        tile.appendChild(controls);

        // Double-click to toggle focus mode (expand tile to fill chat area)
        tile.addEventListener('dblclick', (e) => {
          e.preventDefault();
          this._toggleStreamFocus(tile);
        });

        // Pop-out button
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'stream-popout-btn';
        popoutBtn.title = 'Pop out stream';
        popoutBtn.textContent = '⧉';
        popoutBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._popOutStream(tile, userId);
        });
        tile.appendChild(popoutBtn);

        // Minimize button — hides tile but KEEPS audio playing
        const minBtn = document.createElement('button');
        minBtn.className = 'stream-minimize-btn';
        minBtn.title = 'Minimize (keep audio)';
        minBtn.textContent = '─';
        minBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._hideStreamTile(tile, userId, who, false);
        });
        tile.appendChild(minBtn);

        // Close button — hides tile AND mutes its audio
        const closeBtn = document.createElement('button');
        closeBtn.className = 'stream-close-btn';
        closeBtn.title = 'Close (stop audio)';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._hideStreamTile(tile, userId, who, true);
        });
        tile.appendChild(closeBtn);

        grid.appendChild(tile);
      }
      const videoEl = tile.querySelector('video');
      // Force re-render if the same stream is re-assigned (otherwise it's a no-op → black screen)
      if (videoEl.srcObject === stream) {
        videoEl.srcObject = null;
      }
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
      // Also re-play when metadata loads (handles late-arriving tracks)
      videoEl.onloadedmetadata = () => { videoEl.play().catch(() => {}); };

      // WebRTC video tracks often arrive muted (no frames yet). Retry playback
      // until the video actually has dimensions, which means frames are flowing.
      let _retries = 0;
      const _retryPlay = () => {
        if (!videoEl.srcObject || _retries > 20) return;
        if (videoEl.videoWidth === 0) {
          _retries++;
          // Re-trigger srcObject assignment to prod the decoder
          if (_retries % 5 === 0) {
            const s = videoEl.srcObject;
            videoEl.srcObject = null;
            videoEl.srcObject = s;
          }
          videoEl.play().catch(() => {});
          setTimeout(_retryPlay, 500);
        }
      };
      setTimeout(_retryPlay, 600);
      // Auto-show container (even if minimized) when new stream arrives
      container.style.display = 'flex';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
      // Apply saved stream size so it doesn't start at default/cut-off height
      const savedStreamSize = localStorage.getItem('haven_stream_size');
      if (savedStreamSize) {
        const vh = parseInt(savedStreamSize, 10);
        container.style.maxHeight = vh + 'vh';
        grid.style.maxHeight = (vh - 2) + 'vh';
        document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
      }
      // Update label accounting for hidden tiles, and refresh hidden streams bar
      this._updateHiddenStreamsBar();
      this._updateScreenShareVisibility();
      // Notify server we're watching this stream
      if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
        this.socket.emit('stream-watch', { code: this.voice.currentChannel, sharerId: userId });
      }
    } else {
      // Stream ended — remove this tile
      const tileId = `screen-tile-${userId || 'self'}`;
      const tile = document.getElementById(tileId);
      if (tile) {
        const vid = tile.querySelector('video');
        if (vid) vid.srcObject = null;
        tile.remove();
      }
      // If our OWN stream ended (e.g. browser "Stop sharing" button),
      // reset the screen-share button so it doesn't stay in "stop" state
      if (userId === this.user.id || userId === 'self') {
        const ssBtn = document.getElementById('screen-share-btn');
        if (ssBtn) {
          ssBtn.textContent = '🖥️';
          ssBtn.title = 'Share Screen';
          ssBtn.classList.remove('sharing');
        }
      }
      // Notify server we stopped watching
      if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
        this.socket.emit('stream-unwatch', { code: this.voice.currentChannel, sharerId: userId });
      }
      this._updateHiddenStreamsBar();
      this._updateScreenShareVisibility();
    }
  }

  _updateScreenShareVisibility() {
    const container = document.getElementById('screen-share-container');
    const grid = document.getElementById('screen-share-grid');
    const label = document.getElementById('screen-share-label');
    const totalCount = grid.children.length;
    const visibleCount = grid.querySelectorAll('.screen-share-tile:not([data-hidden=\"true\"])').length;
    const hiddenCount = totalCount - visibleCount;
    if (totalCount === 0) {
      container.style.display = 'none';
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
      // Clean up hidden streams bar
      document.getElementById('hidden-streams-bar')?.remove();
    } else if (visibleCount === 0) {
      // All tiles hidden — collapse the container to avoid empty gray space,
      // but keep the "hidden streams" bar in the header so user can restore.
      container.style.display = 'none';
    } else if (this._screenShareMinimized) {
      this._showScreenShareIndicator(totalCount);
    } else {
      container.style.display = 'flex';
      const labelParts = [`🖥️ ${visibleCount} stream${visibleCount !== 1 ? 's' : ''}`];
      if (hiddenCount > 0) labelParts.push(`(${hiddenCount} hidden)`);
      label.textContent = labelParts.join(' ');
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
        const grid = document.getElementById('screen-share-grid');
        // Restore all hidden tiles and their audio
        if (grid) {
          grid.querySelectorAll('.screen-share-tile[data-hidden="true"]').forEach(t => {
            t.style.display = '';
            delete t.dataset.hidden;
            if (t.dataset.muted === 'true') {
              delete t.dataset.muted;
              const uid = t.id.replace('screen-tile-', '');
              const volSlider = t.querySelector('.stream-vol-slider');
              const vol = volSlider ? parseInt(volSlider.value) / 100 : 1;
              this.voice.setStreamVolume(uid, vol);
            }
          });
        }
        container.style.display = 'flex';
        this._screenShareMinimized = false;
        ind.remove();
        document.getElementById('hidden-streams-bar')?.remove();
        this._updateScreenShareVisibility();
      });
      document.querySelector('.channel-header')?.appendChild(ind);
    }
    ind.textContent = `🖥️ ${count} stream${count > 1 ? 's' : ''} hidden`;
  }

  _removeScreenShareIndicator() {
    document.getElementById('screen-share-indicator')?.remove();
  }

  // ── Hide / Show individual stream tiles ─────────────

  _hideStreamTile(tile, userId, who, muteAudio = false) {
    tile.style.display = 'none';
    tile.dataset.hidden = 'true';
    if (muteAudio) {
      tile.dataset.muted = 'true';
      // Mute this stream's audio via gain node + audio element
      this.voice.setStreamVolume(userId, 0);
      // Also pause the underlying audio element to guarantee silence
      const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (audioEl) { audioEl.volume = 0; try { audioEl.pause(); } catch {} }
    }
    // Notify server we stopped watching this stream
    if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
      this.socket.emit('stream-unwatch', { code: this.voice.currentChannel, sharerId: userId });
    }
    this._updateHiddenStreamsBar();
    this._updateScreenShareVisibility();
  }

  _showStreamTile(tileId, userId) {
    const tile = document.getElementById(tileId);
    if (tile) {
      tile.style.display = '';
      delete tile.dataset.hidden;
      // Restore audio if it was muted by close
      if (tile.dataset.muted === 'true') {
        delete tile.dataset.muted;
        // Resume the audio element that was paused when hiding
        const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
        if (audioEl && audioEl.paused) { try { audioEl.play(); } catch {} }
        // Check if the user had manually muted the stream before closing —
        // if so, keep it muted instead of restoring volume
        const muteBtn = tile.querySelector('.stream-mute-btn');
        if (muteBtn && muteBtn.dataset.muted === 'true') {
          // User had it muted — re-mute
          if (userId) this.voice.setStreamVolume(userId, 0);
        } else {
          const volSlider = tile.querySelector('.stream-vol-slider');
          const vol = volSlider ? parseInt(volSlider.value) / 100 : 1;
          if (userId) this.voice.setStreamVolume(userId, vol);
        }
      }
      // Notify server we're watching this stream again
      if (this.voice && this.voice.inVoice && userId && userId !== this.user.id) {
        this.socket.emit('stream-watch', { code: this.voice.currentChannel, sharerId: userId });
      }
    }
    this._updateHiddenStreamsBar();
    this._updateScreenShareVisibility();
  }

  _updateHiddenStreamsBar() {
    const grid = document.getElementById('screen-share-grid');
    const container = document.getElementById('screen-share-container');
    let bar = document.getElementById('hidden-streams-bar');
    const hiddenTiles = grid.querySelectorAll('.screen-share-tile[data-hidden="true"]');

    if (hiddenTiles.length === 0) {
      if (bar) bar.remove();
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'hidden-streams-bar';
      bar.className = 'hidden-streams-bar';
      // Insert inside voice-controls so it groups with other header buttons
      document.querySelector('.voice-controls')?.appendChild(bar);
    }

    bar.innerHTML = `<button class="hidden-stream-restore-btn" title="Show hidden streams">🖥 ${hiddenTiles.length} stream${hiddenTiles.length > 1 ? 's' : ''} hidden</button>`;

    // Bind restore button — clicking it restores all hidden streams
    bar.querySelector('.hidden-stream-restore-btn').addEventListener('click', () => {
      hiddenTiles.forEach(t => {
        t.style.display = '';
        delete t.dataset.hidden;
        const uid = t.id.replace('screen-tile-', '');
        // Restore audio if it was muted by close
        if (t.dataset.muted === 'true') {
          delete t.dataset.muted;
          // Resume the audio element that was paused when hiding
          const audioEl = document.getElementById(`voice-audio-screen-${uid}`);
          if (audioEl && audioEl.paused) { try { audioEl.play(); } catch {} }
          // Check if the user had manually muted before closing
          const muteBtn = t.querySelector('.stream-mute-btn');
          if (muteBtn && muteBtn.dataset.muted === 'true') {
            this.voice.setStreamVolume(uid, 0);
          } else {
            const volSlider = t.querySelector('.stream-vol-slider');
            const vol = volSlider ? parseInt(volSlider.value) / 100 : 1;
            this.voice.setStreamVolume(uid, vol);
          }
        }
        // Notify server we're watching again
        if (this.voice && this.voice.inVoice && uid !== String(this.user?.id)) {
          this.socket.emit('stream-watch', { code: this.voice.currentChannel, sharerId: parseInt(uid) || uid });
        }
      });
      this._updateHiddenStreamsBar();
      this._updateScreenShareVisibility();
    });

    // Show the container only if there are still visible tiles — _updateScreenShareVisibility handles this.
    // (Removed forced container.style.display = 'flex' that caused empty gray space.)
  }

  _closeScreenShare() {
    // If user is actively sharing, stop that stream
    if (this.voice && this.voice.screenStream) {
      this._toggleScreenShare(); // stops sharing
    }
    const container = document.getElementById('screen-share-container');
    const grid = document.getElementById('screen-share-grid');
    const tiles = grid ? grid.querySelectorAll('.screen-share-tile') : [];

    // Mute all remote stream audio when closing the container
    tiles.forEach(t => {
      const uid = t.id.replace('screen-tile-', '');
      t.dataset.muted = 'true';
      this.voice.setStreamVolume(uid, 0);
      // Notify server we stopped watching
      if (this.voice && this.voice.inVoice && uid !== String(this.user.id)) {
        this.socket.emit('stream-unwatch', { code: this.voice.currentChannel, sharerId: parseInt(uid) || uid });
      }
    });

    container.style.display = 'none';
    container.classList.remove('stream-focus-mode');
    this._screenShareMinimized = true;

    // If there are still active streams running, show the indicator so user can reopen
    if (tiles.length > 0) {
      // Mark them hidden so restore works
      tiles.forEach(t => { t.style.display = 'none'; t.dataset.hidden = 'true'; });
      // Remove any existing hidden-streams-bar to avoid duplicates
      document.getElementById('hidden-streams-bar')?.remove();
      this._showScreenShareIndicator(tiles.length);
    } else {
      this._screenShareMinimized = false;
      this._removeScreenShareIndicator();
    }
  }

  // ── Screen Share Audio ──────────────────────────────

  _handleScreenAudio(userId) {
    const tileId = `screen-tile-${userId || 'self'}`;
    const tile = document.getElementById(tileId);
    if (tile) {
      // Remove opposite badge first (mutually exclusive)
      tile.querySelector('.stream-no-audio-badge')?.remove();
      if (!tile.querySelector('.stream-audio-badge')) {
        const badge = document.createElement('div');
        badge.className = 'stream-audio-badge';
        badge.innerHTML = '🔊 Audio';
        tile.appendChild(badge);
      }
      // Restore audio controls visibility since audio is available
      const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
      if (controls) controls.style.display = '';
    }
    // Flash controls visible briefly
    const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
    if (controls) {
      controls.style.opacity = '1';
      setTimeout(() => { controls.style.opacity = ''; }, 3000);
    }
  }

  _handleScreenNoAudio(userId) {
    const tileId = `screen-tile-${userId || 'self'}`;
    const tile = document.getElementById(tileId);
    if (!tile) {
      // Tile may not exist yet — defer until it's created
      const checkInterval = setInterval(() => {
        const t = document.getElementById(tileId);
        if (t) {
          clearInterval(checkInterval);
          this._applyNoAudioBadge(t, userId);
        }
      }, 200);
      setTimeout(() => clearInterval(checkInterval), 5000);
      return;
    }
    this._applyNoAudioBadge(tile, userId);
  }

  _applyNoAudioBadge(tile, userId) {
    // Remove opposite badge first (mutually exclusive)
    tile.querySelector('.stream-audio-badge')?.remove();
    if (tile.querySelector('.stream-no-audio-badge')) return;
    // Add the no-audio badge
    const badge = document.createElement('div');
    badge.className = 'stream-no-audio-badge';
    badge.innerHTML = '🔇 No Audio';
    tile.appendChild(badge);
    // Hide audio controls since there's no audio to control
    const controls = document.getElementById(`stream-controls-${userId || 'self'}`);
    if (controls) controls.style.display = 'none';
  }

  // ── Stream Viewer Badges ─────────────────────────────

  _updateStreamViewerBadges() {
    const grid = document.getElementById('screen-share-grid');
    if (!grid) return;
    const streams = this._streamInfo || [];

    grid.querySelectorAll('.screen-share-tile').forEach(tile => {
      const uid = tile.id.replace('screen-tile-', '');
      const numericUid = parseInt(uid);
      const streamInfo = streams.find(s => s.sharerId === numericUid || String(s.sharerId) === uid);

      // Remove old viewer badge
      tile.querySelector('.stream-viewer-badge')?.remove();

      const viewers = streamInfo ? streamInfo.viewers : [];
      if (viewers.length === 0) return;

      const badge = document.createElement('div');
      badge.className = 'stream-viewer-badge';
      const names = viewers.map(v => v.username).join(', ');
      const eyeCount = viewers.length;
      badge.innerHTML = `<span class="viewer-eye">👁</span> ${eyeCount}`;
      badge.title = `Watching: ${names}`;
      tile.appendChild(badge);
    });
  }

  // ── Stream Focus & Pop-out ──────────────────────────

  _toggleStreamFocus(tile) {
    const container = document.getElementById('screen-share-container');
    const grid = document.getElementById('screen-share-grid');
    const wasFocused = tile.classList.contains('stream-focused');

    // Remove focus from all tiles first
    grid.querySelectorAll('.screen-share-tile').forEach(t => {
      t.classList.remove('stream-focused');
    });
    container.classList.remove('stream-focus-mode');

    if (!wasFocused) {
      tile.classList.add('stream-focused');
      container.classList.add('stream-focus-mode');
      // Clear inline max-height so CSS flex constraints take over (viewport-bounded)
      container.style.maxHeight = '';
      grid.style.maxHeight = '';
      const vid = tile.querySelector('video');
      if (vid) vid.style.maxHeight = '';
    } else {
      // Restore slider-based size
      const saved = localStorage.getItem('haven_stream_size') || '50';
      const vh = parseInt(saved, 10);
      container.style.maxHeight = vh + 'vh';
      grid.style.maxHeight = (vh - 2) + 'vh';
      document.querySelectorAll('.screen-share-tile video').forEach(v => { v.style.maxHeight = (vh - 4) + 'vh'; });
    }
  }

  /** Collapse the stream container when all tiles are popped out (no visible streams) */
  _updateStreamContainerCollapse() {
    const container = document.querySelector('.screen-share-container');
    if (!container) return;
    const tiles = container.querySelectorAll('.screen-share-tile');
    const allPopped = tiles.length > 0 && [...tiles].every(t => t.classList.contains('stream-popped-out'));
    container.classList.toggle('all-streams-popped', allPopped);
  }

  _popOutStream(tile, userId) {
    const video = tile.querySelector('video');
    if (!video || !video.srcObject) return;

    // If already in Picture-in-Picture, exit it
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }

    // If already popped out, don't open another
    if (tile.classList.contains('stream-popped-out')) return;

    // Try native Picture-in-Picture first (OS-level window, can be dragged to other screens)
    if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
      video.requestPictureInPicture().then(() => {
        const popoutBtn = tile.querySelector('.stream-popout-btn');
        if (popoutBtn) { popoutBtn.textContent = '\u29C8'; popoutBtn.title = 'Pop in stream'; }
        tile.classList.add('stream-popped-out');
        this._updateStreamContainerCollapse();

        video.addEventListener('leavepictureinpicture', () => {
          if (popoutBtn) { popoutBtn.textContent = '\u29C9'; popoutBtn.title = 'Pop out stream'; }
          tile.classList.remove('stream-popped-out');
          this._updateStreamContainerCollapse();
        }, { once: true });
      }).catch(() => {
        // Fallback to in-page overlay if native PiP fails
        this._popOutStreamWindow(tile, userId);
      });
    } else {
      this._popOutStreamWindow(tile, userId);
    }
  }

  _popOutStreamWindow(tile, userId) {
    const video = tile.querySelector('video');
    if (!video || !video.srcObject) return;

    const stream = video.srcObject;
    const peer = this.voice.peers.get(userId);
    const who = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Stream');

    // Create floating in-page overlay (like music PiP) instead of window.open
    const pipId = `stream-pip-${userId || 'self'}`;
    if (document.getElementById(pipId)) return; // already open

    const savedOpacity = parseInt(localStorage.getItem('haven_pip_opacity') ?? '100');
    const pip = document.createElement('div');
    pip.id = pipId;
    pip.className = 'music-pip-overlay stream-pip-overlay';
    pip.style.opacity = savedOpacity / 100;
    pip.style.width = '480px';
    pip.style.minHeight = '320px';

    pip.innerHTML = `
      <div class="music-pip-embed stream-pip-video"></div>
      <div class="music-pip-controls">
        <button class="music-pip-btn stream-pip-popin" title="Pop back in">⧈</button>
        <span class="music-pip-label">🖥️ ${who}</span>
        <span class="music-pip-vol-icon stream-pip-opacity-icon" title="Window opacity">👁</span>
        <input type="range" class="music-pip-vol pip-opacity-slider stream-pip-opacity" min="20" max="100" value="${savedOpacity}">
        <button class="music-pip-btn stream-pip-close" title="Close">✕</button>
      </div>
    `;

    document.body.appendChild(pip);

    // Clone video into PiP (keep original in tile for when user pops back in)
    const pipVideo = document.createElement('video');
    pipVideo.autoplay = true;
    pipVideo.playsInline = true;
    pipVideo.muted = true;
    pipVideo.srcObject = stream;
    pipVideo.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
    pip.querySelector('.stream-pip-video').appendChild(pipVideo);
    pipVideo.play().catch(() => {});

    const popoutBtn = tile.querySelector('.stream-popout-btn');
    if (popoutBtn) { popoutBtn.textContent = '⧈'; popoutBtn.title = 'Pop in stream'; }
    tile.classList.add('stream-popped-out');
    this._updateStreamContainerCollapse();

    // Pop-in handler (minimize — return to inline grid)
    const popIn = () => {
      pip.remove();
      if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out stream'; }
      tile.classList.remove('stream-popped-out');
      this._updateStreamContainerCollapse();
    };

    // Close handler (destroy PiP overlay AND hide the inline tile)
    const closePip = () => {
      pip.remove();
      if (popoutBtn) { popoutBtn.textContent = '⧉'; popoutBtn.title = 'Pop out stream'; }
      tile.classList.remove('stream-popped-out');
      this._updateStreamContainerCollapse();
      // Also hide the stream tile — user wants to close the stream, not just pop back in
      const peer = this.voice.peers.get(userId);
      const who2 = userId === null || userId === this.user.id ? 'You' : (peer ? peer.username : 'Stream');
      this._hideStreamTile(tile, userId, who2, true);
    };

    pip.querySelector('.stream-pip-popin').addEventListener('click', popIn);
    pip.querySelector('.stream-pip-close').addEventListener('click', closePip);

    // Opacity slider
    pip.querySelector('.stream-pip-opacity').addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      pip.style.opacity = val / 100;
      localStorage.setItem('haven_pip_opacity', val);
    });

    // Dragging (whole overlay is drag handle, except buttons/sliders)
    this._initPipDrag(pip, pip);

    // Clean up if stream ends
    const streamTrack = stream.getVideoTracks()[0];
    if (streamTrack) {
      const prevOnEnded = streamTrack.onended;
      streamTrack.onended = () => {
        if (prevOnEnded) prevOnEnded();
        popIn();
      };
    }
  }

  // ── Music Streaming ───────────────────────────────

  _openMusicModal() {
    if (!this.voice || !this.voice.inVoice) {
      this._showToast('Join voice first to share music', 'error');
      return;
    }
    document.getElementById('music-link-input').value = '';
    document.getElementById('music-link-preview').innerHTML = '';
    document.getElementById('music-link-preview').classList.remove('active');
    document.getElementById('music-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('music-link-input').focus(), 100);
  }

  _closeMusicModal() {
    document.getElementById('music-modal').style.display = 'none';
  }

  _previewMusicLink(url) {
    const preview = document.getElementById('music-link-preview');
    if (!url) { preview.innerHTML = ''; preview.classList.remove('active'); return; }
    const platform = this._getMusicPlatform(url);
    const embedUrl = this._getMusicEmbed(url);
    if (platform && embedUrl) {
      preview.classList.add('active');
      preview.innerHTML = `${platform.icon} <strong>${platform.name}</strong> — Ready to share`;
    } else {
      preview.classList.remove('active');
      preview.innerHTML = '';
    }
  }

  _shareMusic() {
    const url = document.getElementById('music-link-input').value.trim();
    if (!url) { this._showToast('Please paste a music link', 'error'); return; }
    if (!this._getMusicEmbed(url)) {
      this._showToast('Unsupported link — try Spotify, YouTube, or SoundCloud', 'error');
      return;
    }
    if (!this.voice || !this.voice.inVoice) { this._showToast('Join voice first', 'error'); return; }
    this.socket.emit('music-share', { code: this.voice.currentChannel, url });
    this._closeMusicModal();
  }

  _stopMusic() {
    if (this.voice && this.voice.inVoice) {
      this.socket.emit('music-stop', { code: this.voice.currentChannel });
    }
    this._hideMusicPanel();
  }

  _showMusicSearchResults(data) {
    // Remove any existing search picker
    this._closeMusicSearchPicker();

    const { results, query, offset } = data;
    if (!results || results.length === 0) {
      this._showToast(offset > 0 ? 'No more results' : `No results for "${query}"`, 'error');
      return;
    }

    const picker = document.createElement('div');
    picker.id = 'music-search-picker';
    picker.className = 'music-search-picker';
    picker.innerHTML = `
      <div class="music-search-picker-header">
        <span>🔍 Results for "<strong>${this._escapeHtml(query)}</strong>"</span>
        <button class="music-search-picker-close" title="Cancel">✕</button>
      </div>
      <div class="music-search-picker-list">
        ${results.map((r, i) => `
          <div class="music-search-picker-item" data-video-id="${r.videoId}">
            <div class="music-search-picker-thumb">
              ${r.thumbnail ? `<img src="${this._escapeHtml(r.thumbnail)}" alt="" loading="lazy">` : '<span>🎵</span>'}
            </div>
            <div class="music-search-picker-info">
              <div class="music-search-picker-title">${this._escapeHtml(r.title || `Result ${offset + i + 1}`)}</div>
              <div class="music-search-picker-meta">${this._escapeHtml(r.channel)}${r.duration ? ` · ${r.duration}` : ''}</div>
            </div>
            <button class="music-search-picker-play" data-video-id="${r.videoId}" title="Play this">▶</button>
          </div>
        `).join('')}
      </div>
      <div class="music-search-picker-footer">
        <button class="music-search-picker-more">More results</button>
        <button class="music-search-picker-cancel">Cancel</button>
      </div>
    `;

    // Insert above the message input area
    const msgArea = document.getElementById('message-area');
    msgArea.appendChild(picker);

    // Event handlers
    picker.querySelector('.music-search-picker-close').addEventListener('click', () => this._closeMusicSearchPicker());
    picker.querySelector('.music-search-picker-cancel').addEventListener('click', () => this._closeMusicSearchPicker());
    picker.querySelector('.music-search-picker-more').addEventListener('click', () => {
      const newOffset = (offset || 0) + 5;
      this._musicSearchOffset = newOffset;
      this.socket.emit('music-search', { query: this._musicSearchQuery, offset: newOffset });
      this._closeMusicSearchPicker();
      this._showToast('Loading more…', 'info');
    });

    picker.querySelectorAll('.music-search-picker-play').forEach(btn => {
      btn.addEventListener('click', () => {
        const videoId = btn.dataset.videoId;
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        this.socket.emit('music-share', { code: this.voice.currentChannel, url });
        this._closeMusicSearchPicker();
      });
    });

    // Also allow clicking the whole row
    picker.querySelectorAll('.music-search-picker-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.music-search-picker-play')) return; // already handled
        const videoId = item.dataset.videoId;
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        this.socket.emit('music-share', { code: this.voice.currentChannel, url });
        this._closeMusicSearchPicker();
      });
    });
  }

  _closeMusicSearchPicker() {
    const existing = document.getElementById('music-search-picker');
    if (existing) existing.remove();
  }

  _handleMusicShared(data) {
    const embedUrl = this._getMusicEmbed(data.url);
    if (!embedUrl) return;
    const platform = this._getMusicPlatform(data.url);
    const panel = document.getElementById('music-panel');
    const container = document.getElementById('music-embed-container');
    const label = document.getElementById('music-panel-label');

    // Clean up previous player references
    this._musicYTPlayer = null;
    this._musicSCWidget = null;
    this._musicPlatform = platform ? platform.name : null;
    this._musicPlaying = true;
    this._musicActive = true;
    this._musicUrl = data.url;
    this._removeMusicIndicator();

    let iframeH = '152';
    if (data.url.includes('spotify.com')) iframeH = '152';
    else if (data.url.includes('soundcloud.com')) iframeH = '166';
    else if (data.url.includes('youtube.com') || data.url.includes('youtu.be')) iframeH = '200';

    // Wrap iframe in a container; overlay blocks direct clicks for SoundCloud (Haven has API control)
    // For Spotify & YouTube, no overlay — user interacts with their native controls (seek bar, etc.)
    const isSpotify = data.url.includes('spotify.com');
    const isYouTube = data.url.includes('youtube.com') || data.url.includes('youtu.be') || data.url.includes('music.youtube.com');
    const needsOverlay = !isSpotify && !isYouTube; // only SoundCloud gets the click-blocker now
    // YouTube embeds: origin param tells Google which page hosts the iframe.
    // We skip referrerpolicy=no-referrer so the IFrame API (enablejsapi) can
    // communicate with the parent window; the origin= param already handles
    // the "Video unavailable" issue that self-hosted instances used to trigger.
    container.innerHTML = `<div class="music-embed-wrapper"><iframe id="music-iframe" src="${embedUrl}" width="100%" height="${iframeH}" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>${needsOverlay ? '<div class="music-embed-overlay"></div>' : ''}</div>`;
    if (data.resolvedFrom === 'spotify') {
      label.textContent = `🎵 🟢 Spotify (via YouTube) — shared by ${data.username || 'someone'}`;
    } else {
      label.textContent = `🎵 ${platform ? platform.name : 'Music'} — shared by ${data.username || 'someone'}`;
    }
    panel.style.display = 'flex';

    // Update play/pause button — hide for Spotify (no external API)
    const ppBtn = document.getElementById('music-play-pause-btn');
    if (ppBtn) {
      ppBtn.textContent = isSpotify ? '' : '⏸';
      ppBtn.style.display = isSpotify ? 'none' : '';
    }

    // Seek bar — hide for Spotify (no external API for position tracking)
    const seekSlider = document.getElementById('music-seek-slider');
    const timeCur = document.getElementById('music-time-current');
    const timeDur = document.getElementById('music-time-duration');
    const hideSeek = isSpotify;
    if (seekSlider) seekSlider.style.display = hideSeek ? 'none' : '';
    if (timeCur) timeCur.style.display = hideSeek ? 'none' : '';
    if (timeDur) timeDur.style.display = hideSeek ? 'none' : '';

    // Apply saved volume
    const savedVol = parseInt(localStorage.getItem('haven_music_volume') ?? '80');
    document.getElementById('music-volume-slider').value = savedVol;

    // For Spotify: volume can only be controlled inside the embed — show disclaimer
    const volSlider = document.getElementById('music-volume-slider');
    const muteBtn = document.getElementById('music-mute-btn');
    if (isSpotify) {
      if (volSlider) { volSlider.disabled = true; volSlider.title = 'Use Spotify\'s built-in controls for volume'; }
      if (muteBtn) { muteBtn.disabled = true; muteBtn.title = 'Use Spotify\'s built-in controls for volume'; }
    } else {
      if (volSlider) { volSlider.disabled = false; volSlider.title = ''; }
      if (muteBtn) { muteBtn.disabled = false; muteBtn.title = 'Mute/Unmute'; }
    }

    // Show next/prev/shuffle for SoundCloud & YouTube playlists only (not single YT videos, not Spotify)
    const isSoundCloud = data.url.includes('soundcloud.com');
    const showTrackBtns = isSoundCloud || this._musicIsYTPlaylist;
    const prevBtn = document.getElementById('music-prev-btn');
    const nextBtn = document.getElementById('music-next-btn');
    const shuffleBtn = document.getElementById('music-shuffle-btn');
    if (prevBtn) prevBtn.style.display = showTrackBtns ? '' : 'none';
    if (nextBtn) nextBtn.style.display = showTrackBtns ? '' : 'none';
    if (shuffleBtn) shuffleBtn.style.display = showTrackBtns ? '' : 'none';


    // Initialize platform-specific APIs for volume & sync control
    const iframe = document.getElementById('music-iframe');
    if (iframe) {
      if (data.url.includes('youtube.com') || data.url.includes('youtu.be') || data.url.includes('music.youtube.com')) {
        this._initYouTubePlayer(iframe, savedVol);
      } else if (data.url.includes('soundcloud.com')) {
        this._initSoundCloudWidget(iframe, savedVol);
      }
    }

    const who = data.userId === this.user?.id ? 'You shared' : `${data.username} shared`;
    const platformLabel = data.resolvedFrom === 'spotify' ? 'Spotify (via YouTube)' : (platform ? platform.name : 'music');
    this._showToast(`${who} ${platformLabel}`, 'info');
  }

  _initYouTubePlayer(iframe, volume) {
    // YouTube IFrame API — load the API script once, then create a player
    if (!window.YT || !window.YT.Player) {
      if (!document.getElementById('yt-iframe-api')) {
        const tag = document.createElement('script');
        tag.id = 'yt-iframe-api';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      // Wait for API to load, then retry
      const check = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(check);
          this._createYTPlayer(iframe, volume);
        }
      }, 200);
      setTimeout(() => clearInterval(check), 10000); // give up after 10s
    } else {
      this._createYTPlayer(iframe, volume);
    }
  }

  _createYTPlayer(iframe, volume) {
    try {
      this._musicYTPlayer = new YT.Player(iframe, {
        events: {
          onReady: (e) => {
            e.target.setVolume(volume);
            this._startMusicTimeTracking();
          },
          onStateChange: (e) => {
            // Sync Haven's play/pause state when user interacts with YT's native controls
            const ppBtn = document.getElementById('music-play-pause-btn');
            const pipPP = document.getElementById('music-pip-pp');
            if (e.data === YT.PlayerState.PLAYING) {
              this._musicPlaying = true;
              if (ppBtn) ppBtn.textContent = '⏸';
              if (pipPP) pipPP.textContent = '⏸';
            } else if (e.data === YT.PlayerState.PAUSED) {
              this._musicPlaying = false;
              if (ppBtn) ppBtn.textContent = '▶';
              if (pipPP) pipPP.textContent = '▶';
            } else if (e.data === YT.PlayerState.ENDED) {
              // Auto-advance: if YouTube playlist, play the next video
              if (this._musicIsYTPlaylist) {
                try { e.target.nextVideo(); } catch {}
              } else {
                this._musicPlaying = false;
                if (ppBtn) ppBtn.textContent = '▶';
                if (pipPP) pipPP.textContent = '▶';
              }
            }
          }
        }
      });
    } catch { /* iframe may already be destroyed */ }
  }

  _initSoundCloudWidget(iframe, volume) {
    // SoundCloud Widget API
    if (!window.SC || !window.SC.Widget) {
      if (!document.getElementById('sc-widget-api')) {
        const tag = document.createElement('script');
        tag.id = 'sc-widget-api';
        tag.src = 'https://w.soundcloud.com/player/api.js';
        document.head.appendChild(tag);
      }
      const check = setInterval(() => {
        if (window.SC && window.SC.Widget) {
          clearInterval(check);
          this._createSCWidget(iframe, volume);
        }
      }, 200);
      setTimeout(() => clearInterval(check), 10000);
    } else {
      this._createSCWidget(iframe, volume);
    }
  }

  _createSCWidget(iframe, volume) {
    try {
      this._musicSCWidget = SC.Widget(iframe);
      this._musicSCShuffle = false;
      this._musicSCTrackCount = 0;
      this._musicSCCurrentIndex = 0;
      this._musicSCWidget.bind(SC.Widget.Events.READY, () => {
        this._musicSCWidget.setVolume(volume);
        this._startMusicTimeTracking();
        // Get track count for shuffle support
        this._musicSCWidget.getSounds((sounds) => {
          this._musicSCTrackCount = sounds ? sounds.length : 0;
        });
      });
      // Auto-advance on track finish (supports shuffle)
      this._musicSCWidget.bind(SC.Widget.Events.FINISH, () => {
        if (this._musicSCShuffle && this._musicSCTrackCount > 1) {
          // Pick a random track that isn't the current one
          let next;
          do { next = Math.floor(Math.random() * this._musicSCTrackCount); } while (next === this._musicSCCurrentIndex);
          this._musicSCCurrentIndex = next;
          this._musicSCWidget.skip(next);
        } else {
          this._musicSCWidget.next();
        }
      });
      // Track current index for shuffle
      this._musicSCWidget.bind(SC.Widget.Events.PLAY, () => {
        this._musicSCWidget.getCurrentSoundIndex((idx) => { this._musicSCCurrentIndex = idx; });
      });
    } catch { /* iframe may already be destroyed */ }
  }

  _handleMusicStopped(data) {
    this._stopMusicTimeTracking();
    this._musicYTPlayer = null;
    this._musicSCWidget = null;
    this._musicPlatform = null;
    this._musicPlaying = false;
    this._hideMusicPanel();
    const who = data.userId === this.user?.id ? 'You' : (data.username || 'Someone');
    this._showToast(`${who} stopped the music`, 'info');
  }

  _handleMusicControl(data) {
    if (data.action === 'pause') {
      this._pauseMusicEmbed();
      this._musicPlaying = false;
    } else if (data.action === 'play') {
      this._playMusicEmbed();
      this._musicPlaying = true;
    } else if (data.action === 'next') {
      this._musicNextTrack();
    } else if (data.action === 'prev') {
      this._musicPrevTrack();
    } else if (data.action === 'shuffle') {
      this._musicToggleShuffle();
    }
    const ppBtn = document.getElementById('music-play-pause-btn');
    if (ppBtn) ppBtn.textContent = this._musicPlaying ? '⏸' : '▶';
  }

  _toggleMusicPlayPause() {
    if (this._musicPlaying) {
      this._pauseMusicEmbed();
      this._musicPlaying = false;
    } else {
      this._playMusicEmbed();
      this._musicPlaying = true;
    }
    const ppBtn = document.getElementById('music-play-pause-btn');
    if (ppBtn) ppBtn.textContent = this._musicPlaying ? '⏸' : '▶';
    // Broadcast to others in voice
    if (this.voice && this.voice.inVoice) {
      this.socket.emit('music-control', {
        code: this.voice.currentChannel,
        action: this._musicPlaying ? 'play' : 'pause'
      });
    }
  }

  _musicTrackControl(action) {
    // Execute locally
    if (action === 'next') this._musicNextTrack();
    else if (action === 'prev') this._musicPrevTrack();
    else if (action === 'shuffle') this._musicToggleShuffle();
    // Broadcast to others in voice
    if (this.voice && this.voice.inVoice) {
      this.socket.emit('music-control', {
        code: this.voice.currentChannel,
        action
      });
    }
  }

  _musicNextTrack() {
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.nextVideo) {
        this._musicYTPlayer.nextVideo();
      } else if (this._musicSCWidget) {
        this._musicSCWidget.next();
      }
    } catch { /* player may not support next */ }
  }

  _musicPrevTrack() {
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.previousVideo) {
        this._musicYTPlayer.previousVideo();
      } else if (this._musicSCWidget) {
        this._musicSCWidget.prev();
      }
    } catch { /* player may not support prev */ }
  }

  _musicToggleShuffle() {
    try {
      this._musicSCShuffle = !this._musicSCShuffle;
      const btn = document.getElementById('music-shuffle-btn');
      if (btn) btn.classList.toggle('active', this._musicSCShuffle);
      // YouTube has native shuffle support for playlists
      if (this._musicYTPlayer && this._musicYTPlayer.setShuffle) {
        this._musicYTPlayer.setShuffle(this._musicSCShuffle);
      }
      // SoundCloud: immediately skip to a random track when shuffle is turned ON
      if (this._musicSCShuffle && this._musicSCWidget && this._musicSCTrackCount > 1) {
        let next;
        do { next = Math.floor(Math.random() * this._musicSCTrackCount); } while (next === this._musicSCCurrentIndex);
        this._musicSCCurrentIndex = next;
        this._musicSCWidget.skip(next);
      }
      this._showToast(this._musicSCShuffle ? 'Shuffle on' : 'Shuffle off', 'info');
    } catch { /* player may not support shuffle */ }
  }

  _playMusicEmbed() {
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.playVideo) {
        this._musicYTPlayer.playVideo();
      } else if (this._musicSCWidget) {
        this._musicSCWidget.play();
      } else {
        // Spotify or fallback — restore paused src to resume
        const iframe = document.getElementById('music-iframe');
        if (iframe) {
          const src = iframe.dataset.pausedSrc || iframe.src;
          delete iframe.dataset.pausedSrc;
          if (src && src !== 'about:blank') iframe.src = src;
        }
      }
    } catch { /* player may be destroyed */ }
  }

  _pauseMusicEmbed() {
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.pauseVideo) {
        this._musicYTPlayer.pauseVideo();
      } else if (this._musicSCWidget) {
        this._musicSCWidget.pause();
      } else {
        // Spotify — no external API; remove src to pause, store for resume
        const iframe = document.getElementById('music-iframe');
        if (iframe) {
          iframe.dataset.pausedSrc = iframe.src;
          iframe.src = 'about:blank';
        }
      }
    } catch { /* player may be destroyed */ }
  }

  _hideMusicPanel() {
    this._stopMusicTimeTracking();
    // Clean up PiP overlay if active
    if (this._musicPip) {
      this._musicPip.remove();
      this._musicPip = null;
    }
    const panel = document.getElementById('music-panel');
    if (panel) {
      document.getElementById('music-embed-container').innerHTML = '';
      panel.style.display = 'none';
    }
    this._removeMusicIndicator();
    this._musicActive = false;
  }

  _minimizeMusicPanel() {
    document.getElementById('music-panel').style.display = 'none';
    // Show an indicator in the channel header so user can reopen
    if (this._musicActive) {
      this._showMusicIndicator();
    }
  }

  _popOutMusicPlayer() {
    const panel = document.getElementById('music-panel');
    const container = document.getElementById('music-embed-container');
    if (!container || !container.innerHTML.trim()) {
      this._showToast('No music playing', 'error');
      return;
    }

    // If already in PiP overlay, pop back in
    if (this._musicPip) {
      this._popInMusicPlayer();
      return;
    }

    // Create floating PiP overlay
    const pip = document.createElement('div');
    pip.id = 'music-pip-overlay';
    pip.className = 'music-pip-overlay';

    const volume = parseInt(document.getElementById('music-volume-slider')?.value ?? '80');
    const platform = this._musicPlatform || 'Music';
    const playing = this._musicPlaying;

    const savedOpacity = parseInt(localStorage.getItem('haven_pip_opacity') ?? '100');

    pip.innerHTML = `
      <div class="music-pip-header" id="music-pip-drag">
        <button class="music-pip-btn" id="music-pip-popin" title="Minimize (back to panel)">─</button>
        <span class="music-pip-label">🎵 ${platform}</span>
        <button class="music-pip-btn" id="music-pip-fullscreen" title="Fullscreen">⤢</button>
        <button class="music-pip-btn" id="music-pip-close" title="Close / stop music">✕</button>
      </div>
      <div class="music-pip-embed" id="music-pip-embed"></div>
      <div class="music-pip-controls">
        <button class="music-pip-btn" id="music-pip-pp" title="Play/Pause">${playing ? '⏸' : '▶'}</button>
        <span class="music-pip-vol-icon" id="music-pip-mute" title="Mute">🔊</span>
        <input type="range" class="music-pip-vol" id="music-pip-vol" min="0" max="100" value="${volume}">
        <span class="pip-opacity-divider"></span>
        <span class="music-pip-vol-icon" id="music-pip-opacity-icon" title="Window opacity">👁</span>
        <input type="range" class="music-pip-vol pip-opacity-slider" id="music-pip-opacity" min="20" max="100" value="${savedOpacity}">
      </div>
    `;

    pip.style.opacity = savedOpacity / 100;

    document.body.appendChild(pip);

    // Move the embed wrapper (with live iframe) into the PiP overlay — no reload!
    const embedWrapper = container.querySelector('.music-embed-wrapper');
    if (embedWrapper) {
      // Remove the click-blocking overlay so user can interact directly in PiP
      const overlay = embedWrapper.querySelector('.music-embed-overlay');
      if (overlay) overlay.style.display = 'none';
      document.getElementById('music-pip-embed').appendChild(embedWrapper);
    }

    // Hide the original panel
    panel.style.display = 'none';
    this._showMusicIndicator();
    this._musicPip = pip;

    // Update popout button icon to show "pop-in"
    const popBtn = document.getElementById('music-popout-btn');
    if (popBtn) { popBtn.textContent = '⧈'; popBtn.title = 'Pop back in'; }

    // ── PiP controls ──
    document.getElementById('music-pip-popin').addEventListener('click', () => this._popInMusicPlayer());
    document.getElementById('music-pip-close').addEventListener('click', () => this._stopMusic());
    document.getElementById('music-pip-pp').addEventListener('click', () => {
      this._toggleMusicPlayPause();
      document.getElementById('music-pip-pp').textContent = this._musicPlaying ? '⏸' : '▶';
    });
    document.getElementById('music-pip-vol').addEventListener('input', (e) => {
      this._setMusicVolume(parseInt(e.target.value));
      document.getElementById('music-pip-mute').textContent = parseInt(e.target.value) === 0 ? '🔇' : '🔊';
    });
    document.getElementById('music-pip-mute').addEventListener('click', () => {
      this._toggleMusicMute();
      const v = parseInt(document.getElementById('music-volume-slider')?.value ?? '0');
      document.getElementById('music-pip-vol').value = v;
      document.getElementById('music-pip-mute').textContent = v === 0 ? '🔇' : '🔊';
    });

    // ── Opacity ──
    document.getElementById('music-pip-opacity').addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      pip.style.opacity = val / 100;
      localStorage.setItem('haven_pip_opacity', val);
    });

    // ── Fullscreen ──
    const toggleMusicFS = () => {
      const el = pip;
      if (document.fullscreenElement === el) {
        document.exitFullscreen().catch(() => {});
      } else {
        (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el).catch(() => {});
      }
    };
    document.getElementById('music-pip-fullscreen').addEventListener('click', toggleMusicFS);
    document.getElementById('music-pip-embed').addEventListener('dblclick', toggleMusicFS);
    document.addEventListener('fullscreenchange', () => {
      const fsBtn = document.getElementById('music-pip-fullscreen');
      if (!fsBtn) return;
      if (document.fullscreenElement === pip) {
        fsBtn.textContent = '⤡'; fsBtn.title = 'Exit fullscreen';
      } else {
        fsBtn.textContent = '⤢'; fsBtn.title = 'Fullscreen';
      }
    });

    // ── Dragging ──
    this._initPipDrag(pip, document.getElementById('music-pip-drag'));
  }

  _popInMusicPlayer() {
    const pip = this._musicPip;
    if (!pip) return;

    const container = document.getElementById('music-embed-container');
    const panel = document.getElementById('music-panel');

    // Move embed wrapper back to the panel
    const embedWrapper = pip.querySelector('.music-embed-wrapper');
    if (embedWrapper && container) {
      // Re-add the click-blocking overlay
      const overlay = embedWrapper.querySelector('.music-embed-overlay');
      if (overlay) overlay.style.display = '';
      container.appendChild(embedWrapper);
    }

    pip.remove();
    this._musicPip = null;

    // Restore panel
    if (this._musicActive && panel) {
      panel.style.display = 'flex';
      this._removeMusicIndicator();
    }

    // Restore popout button icon
    const popBtn = document.getElementById('music-popout-btn');
    if (popBtn) { popBtn.textContent = '⧉'; popBtn.title = 'Pop out player'; }
  }

  _initPipDrag(pip, handle) {
    let dragging = false, startX, startY, origX, origY;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // don't interfere with button clicks
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = pip.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      pip.style.left = (origX + e.clientX - startX) + 'px';
      pip.style.top = (origY + e.clientY - startY) + 'px';
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    // Touch support
    handle.addEventListener('touchstart', (e) => {
      dragging = true;
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      const rect = pip.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      pip.style.left = (origX + t.clientX - startX) + 'px';
      pip.style.top = (origY + t.clientY - startY) + 'px';
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
    }, { passive: true });
    document.addEventListener('touchend', () => { dragging = false; });
  }

  _showMusicIndicator() {
    let ind = document.getElementById('music-indicator');
    if (ind) return; // already showing
    ind = document.createElement('button');
    ind.id = 'music-indicator';
    ind.className = 'music-indicator';
    ind.textContent = '🎵 Music playing';
    ind.title = 'Click to show music player';
    ind.addEventListener('click', () => {
      // If PiP is active, pop back in first
      if (this._musicPip) {
        this._popInMusicPlayer();
        return;
      }
      const panel = document.getElementById('music-panel');
      panel.style.display = 'flex';
      ind.remove();
    });
    // Append inside voice-controls so it groups with other header buttons
    document.querySelector('.voice-controls')?.appendChild(ind);
  }

  _removeMusicIndicator() {
    document.getElementById('music-indicator')?.remove();
  }

  _setMusicVolume(vol) {
    localStorage.setItem('haven_music_volume', vol);
    const muteBtn = document.getElementById('music-mute-btn');
    if (muteBtn) muteBtn.textContent = vol === 0 ? '🔇' : '🔊';
    // Apply to active player
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.setVolume) {
        this._musicYTPlayer.setVolume(vol);
      } else if (this._musicSCWidget) {
        this._musicSCWidget.setVolume(vol);
      }
    } catch { /* player may be gone */ }
  }

  _toggleMusicMute() {
    const slider = document.getElementById('music-volume-slider');
    const muteBtn = document.getElementById('music-mute-btn');
    if (!slider) return;
    if (parseInt(slider.value) > 0) {
      slider.dataset.prevValue = slider.value;
      slider.value = 0;
      muteBtn.textContent = '🔇';
    } else {
      slider.value = slider.dataset.prevValue || 80;
      muteBtn.textContent = '🔊';
    }
    this._setMusicVolume(parseInt(slider.value));
  }

  // ── Seek bar & time tracking ──────────────────────────
  _seekMusic(pct) {
    try {
      if (this._musicYTPlayer && this._musicYTPlayer.getDuration) {
        const dur = this._musicYTPlayer.getDuration();
        if (dur > 0) this._musicYTPlayer.seekTo(dur * pct / 100, true);
      } else if (this._musicSCWidget) {
        this._musicSCWidget.getDuration((dur) => {
          if (dur > 0) this._musicSCWidget.seekTo(dur * pct / 100);
        });
      }
    } catch { /* player may be gone */ }
  }

  _startMusicTimeTracking() {
    this._stopMusicTimeTracking();
    const seekSlider = document.getElementById('music-seek-slider');
    const curEl = document.getElementById('music-time-current');
    const durEl = document.getElementById('music-time-duration');
    const fmt = (s) => { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

    this._musicTimeInterval = setInterval(() => {
      try {
        if (this._musicYTPlayer && this._musicYTPlayer.getCurrentTime && this._musicYTPlayer.getDuration) {
          const cur = this._musicYTPlayer.getCurrentTime() || 0;
          const dur = this._musicYTPlayer.getDuration() || 0;
          if (curEl) curEl.textContent = fmt(cur);
          if (durEl) durEl.textContent = fmt(dur);
          if (seekSlider && !this._musicSeeking && dur > 0) seekSlider.value = (cur / dur * 100).toFixed(1);
        } else if (this._musicSCWidget) {
          this._musicSCWidget.getPosition((pos) => {
            this._musicSCWidget.getDuration((dur) => {
              const curS = (pos || 0) / 1000;
              const durS = (dur || 0) / 1000;
              if (curEl) curEl.textContent = fmt(curS);
              if (durEl) durEl.textContent = fmt(durS);
              if (seekSlider && !this._musicSeeking && durS > 0) seekSlider.value = (curS / durS * 100).toFixed(1);
            });
          });
        }
      } catch { /* player gone */ }
    }, 500);
  }

  _stopMusicTimeTracking() {
    if (this._musicTimeInterval) { clearInterval(this._musicTimeInterval); this._musicTimeInterval = null; }
    const seekSlider = document.getElementById('music-seek-slider');
    const curEl = document.getElementById('music-time-current');
    const durEl = document.getElementById('music-time-duration');
    if (seekSlider) seekSlider.value = 0;
    if (curEl) curEl.textContent = '0:00';
    if (durEl) durEl.textContent = '0:00';
  }

  _getMusicEmbed(url) {
    this._musicIsYTPlaylist = false;
    if (!url) return null;
    const spotifyMatch = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) return `https://open.spotify.com/embed/${spotifyMatch[1]}/${spotifyMatch[2]}?theme=0&utm_source=generator&autoplay=1`;
    // Extract YouTube playlist ID if present
    const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    const listParam = listMatch ? `&list=${listMatch[1]}` : '';
    this._musicIsYTPlaylist = !!listMatch;
    const ytMusicMatch = url.match(/music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (ytMusicMatch) return `https://www.youtube-nocookie.com/embed/${ytMusicMatch[1]}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&rel=0${listParam}`;
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) return `https://www.youtube-nocookie.com/embed/${ytMatch[1]}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&rel=0${listParam}`;
    this._musicIsYTPlaylist = false;
    if (url.includes('soundcloud.com/')) {
      return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=false`;
    }
    return null;
  }

  _getMusicPlatform(url) {
    if (!url) return null;
    if (url.includes('spotify.com')) return { name: 'Spotify', icon: '🟢' };
    if (url.includes('music.youtube.com')) return { name: 'YouTube Music', icon: '🔴' };
    if (url.includes('youtube.com') || url.includes('youtu.be')) return { name: 'YouTube', icon: '🔴' };
    if (url.includes('soundcloud.com')) return { name: 'SoundCloud', icon: '🟠' };
    return null;
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

    // Render custom emojis :name:
    if (this.customEmojis && this.customEmojis.length > 0) {
      html = html.replace(/:([a-zA-Z0-9_-]+):/g, (match, name) => {
        const emoji = this.customEmojis.find(e => e.name === name.toLowerCase());
        if (emoji) return `<img src="${emoji.url}" alt=":${name}:" title=":${name}:" class="custom-emoji">`;
        return match;
      });
    }

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

    // Build combined categories (standard + custom)
    const allCategories = { ...this.emojiCategories };
    const hasCustom = this.customEmojis && this.customEmojis.length > 0;
    if (hasCustom) {
      allCategories['Custom'] = this.customEmojis.map(e => `:${e.name}:`);
    }

    // Category tabs
    const tabRow = document.createElement('div');
    tabRow.className = 'emoji-tab-row';
    const catIcons = { 'Smileys':'😀', 'People':'👋', 'Animals':'🐶', 'Food':'🍕', 'Activities':'🎮', 'Travel':'🚀', 'Objects':'💡', 'Symbols':'❤️', 'Custom':'⭐' };
    for (const cat of Object.keys(allCategories)) {
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
        const q = filter.toLowerCase();
        const matched = new Set();
        // Search by emoji name keywords
        for (const [emoji, keywords] of Object.entries(self.emojiNames)) {
          if (keywords.toLowerCase().includes(q)) matched.add(emoji);
        }
        // Also search by category name
        for (const [cat, list] of Object.entries(self.emojiCategories)) {
          if (cat.toLowerCase().includes(q)) list.forEach(e => matched.add(e));
        }
        // Search custom emojis by name
        if (self.customEmojis) {
          self.customEmojis.forEach(e => {
            if (e.name.toLowerCase().includes(q)) matched.add(`:${e.name}:`);
          });
        }
        emojis = matched.size > 0 ? [...matched] : [];
      } else {
        emojis = allCategories[self._emojiActiveCategory] || self.emojis;
      }
      if (filter && emojis.length === 0) {
        grid.innerHTML = '<p class="muted-text" style="padding:12px;font-size:12px;width:100%;text-align:center">No emoji found</p>';
        return;
      }
      emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'emoji-item';
        // Check if it's a custom emoji (:name:)
        const customMatch = typeof emoji === 'string' && emoji.match(/^:([a-zA-Z0-9_-]+):$/);
        if (customMatch) {
          const ce = self.customEmojis.find(e => e.name === customMatch[1]);
          if (ce) {
            btn.innerHTML = `<img src="${ce.url}" alt=":${ce.name}:" title=":${ce.name}:" class="custom-emoji">`;
          } else {
            btn.textContent = emoji;
          }
        } else {
          btn.textContent = emoji;
        }
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

  // /gif slash command — inline GIF search results above the input
  _showGifSlashResults(query) {
    // Remove any existing picker
    document.getElementById('gif-slash-picker')?.remove();

    const picker = document.createElement('div');
    picker.id = 'gif-slash-picker';
    picker.className = 'gif-slash-picker';
    picker.innerHTML = '<div class="gif-slash-loading">Searching GIFs...</div>';

    // Position above the message input
    const inputArea = document.querySelector('.message-input-area');
    inputArea.parentElement.insertBefore(picker, inputArea);

    // Close on click outside
    const closeOnClick = (e) => {
      if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', closeOnClick); }
    };
    setTimeout(() => document.addEventListener('click', closeOnClick), 100);

    // Close on Escape
    const closeOnEsc = (e) => {
      if (e.key === 'Escape') { picker.remove(); document.removeEventListener('keydown', closeOnEsc); }
    };
    document.addEventListener('keydown', closeOnEsc);

    fetch(`/api/gif/search?q=${encodeURIComponent(query)}&limit=12`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.error === 'gif_not_configured') {
          picker.innerHTML = '<div class="gif-slash-loading">GIF search not configured — an admin needs to set up the GIPHY API key (use the GIF button 🎞️)</div>';
          return;
        }
        if (data.error) { picker.innerHTML = `<div class="gif-slash-loading">${data.error}</div>`; return; }
        const results = data.results || [];
        if (results.length === 0) { picker.innerHTML = '<div class="gif-slash-loading">No GIFs found</div>'; return; }

        picker.innerHTML = `<div class="gif-slash-header"><span>/gif ${this._escapeHtml(query)}</span><button class="icon-btn small gif-slash-close">&times;</button></div><div class="gif-slash-grid"></div>`;
        const grid = picker.querySelector('.gif-slash-grid');
        picker.querySelector('.gif-slash-close').addEventListener('click', () => picker.remove());

        results.forEach(gif => {
          if (!gif.tiny) return;
          const img = document.createElement('img');
          img.src = gif.tiny;
          img.alt = gif.title || 'GIF';
          img.loading = 'lazy';
          img.dataset.full = gif.full || gif.tiny;
          img.addEventListener('click', () => {
            this._sendGifMessage(img.dataset.full);
            picker.remove();
            document.removeEventListener('click', closeOnClick);
            document.removeEventListener('keydown', closeOnEsc);
          });
          grid.appendChild(img);
        });
      })
      .catch(() => {
        picker.innerHTML = '<div class="gif-slash-loading">GIF search failed</div>';
      });
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
      // Check if it's a custom emoji
      const customMatch = g.emoji.match(/^:([a-zA-Z0-9_-]+):$/);
      let emojiDisplay = g.emoji;
      if (customMatch && this.customEmojis) {
        const ce = this.customEmojis.find(e => e.name === customMatch[1]);
        if (ce) emojiDisplay = `<img src="${ce.url}" alt=":${ce.name}:" class="custom-emoji reaction-custom-emoji">`;
      }
      return `<button class="reaction-badge${isOwn ? ' own' : ''}" data-emoji="${this._escapeHtml(g.emoji)}" title="${names}">${emojiDisplay} ${g.users.length}</button>`;
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

  _getQuickEmojis() {
    const saved = localStorage.getItem('haven_quick_emojis');
    if (saved) {
      try { const arr = JSON.parse(saved); if (Array.isArray(arr) && arr.length === 8) return arr; } catch {}
    }
    return ['👍','👎','😂','❤️','🔥','💯','😮','😢'];
  }

  _saveQuickEmojis(emojis) {
    localStorage.setItem('haven_quick_emojis', JSON.stringify(emojis));
  }

  _showQuickEmojiEditor(picker, msgEl, msgId) {
    // Remove any existing editor
    document.querySelectorAll('.quick-emoji-editor').forEach(el => el.remove());

    const editor = document.createElement('div');
    editor.className = 'quick-emoji-editor reaction-full-picker';

    const title = document.createElement('div');
    title.className = 'reaction-full-category';
    title.textContent = 'Customize Quick Reactions';
    editor.appendChild(title);

    const hint = document.createElement('p');
    hint.className = 'muted-text';
    hint.style.cssText = 'font-size:11px;padding:0 8px 6px;margin:0';
    hint.textContent = 'Click a slot, then pick an emoji to replace it.';
    editor.appendChild(hint);

    // Current slots
    const current = this._getQuickEmojis();
    const slotsRow = document.createElement('div');
    slotsRow.className = 'quick-emoji-slots';
    let activeSlot = null;

    const renderSlots = () => {
      slotsRow.innerHTML = '';
      current.forEach((emoji, i) => {
        const slot = document.createElement('button');
        slot.className = 'reaction-pick-btn quick-emoji-slot' + (activeSlot === i ? ' active' : '');
        // Check for custom emoji
        const customMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/);
        if (customMatch && this.customEmojis) {
          const ce = this.customEmojis.find(e => e.name === customMatch[1]);
          if (ce) slot.innerHTML = `<img src="${ce.url}" alt="${emoji}" class="custom-emoji" style="width:20px;height:20px">`;
          else slot.textContent = emoji;
        } else {
          slot.textContent = emoji;
        }
        slot.addEventListener('click', (e) => {
          e.stopPropagation();
          activeSlot = i;
          renderSlots();
        });
        slotsRow.appendChild(slot);
      });
    };
    renderSlots();
    editor.appendChild(slotsRow);

    // Emoji grid for selection
    const grid = document.createElement('div');
    grid.className = 'reaction-full-grid';
    grid.style.maxHeight = '180px';

    const renderOptions = () => {
      grid.innerHTML = '';
      // Standard emojis
      for (const [category, emojis] of Object.entries(this.emojiCategories)) {
        const label = document.createElement('div');
        label.className = 'reaction-full-category';
        label.textContent = category;
        grid.appendChild(label);

        const row = document.createElement('div');
        row.className = 'reaction-full-row';
        emojis.forEach(emoji => {
          const btn = document.createElement('button');
          btn.className = 'reaction-full-btn';
          btn.textContent = emoji;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activeSlot !== null) {
              current[activeSlot] = emoji;
              this._saveQuickEmojis(current);
              renderSlots();
            }
          });
          row.appendChild(btn);
        });
        grid.appendChild(row);
      }
      // Custom emojis
      if (this.customEmojis && this.customEmojis.length > 0) {
        const label = document.createElement('div');
        label.className = 'reaction-full-category';
        label.textContent = 'Custom';
        grid.appendChild(label);

        const row = document.createElement('div');
        row.className = 'reaction-full-row';
        this.customEmojis.forEach(ce => {
          const btn = document.createElement('button');
          btn.className = 'reaction-full-btn';
          btn.innerHTML = `<img src="${ce.url}" alt=":${ce.name}:" class="custom-emoji" style="width:22px;height:22px">`;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activeSlot !== null) {
              current[activeSlot] = `:${ce.name}:`;
              this._saveQuickEmojis(current);
              renderSlots();
            }
          });
          row.appendChild(btn);
        });
        grid.appendChild(row);
      }
    };
    renderOptions();
    editor.appendChild(grid);

    // Done button
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn-sm btn-accent';
    doneBtn.style.cssText = 'margin:8px;width:calc(100% - 16px)';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editor.remove();
    });
    editor.appendChild(doneBtn);

    msgEl.appendChild(editor);
  }

  _showReactionPicker(msgEl, msgId) {
    // Remove any existing reaction picker
    document.querySelectorAll('.reaction-picker').forEach(el => el.remove());
    document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
    document.querySelectorAll('.quick-emoji-editor').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    const quickEmojis = this._getQuickEmojis();
    quickEmojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'reaction-pick-btn';
      // Check for custom emoji
      const customMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/);
      if (customMatch && this.customEmojis) {
        const ce = this.customEmojis.find(e => e.name === customMatch[1]);
        if (ce) btn.innerHTML = `<img src="${ce.url}" alt="${emoji}" class="custom-emoji" style="width:20px;height:20px">`;
        else btn.textContent = emoji;
      } else {
        btn.textContent = emoji;
      }
      btn.addEventListener('click', () => {
        this.socket.emit('add-reaction', { messageId: msgId, emoji });
        picker.remove();
      });
      picker.appendChild(btn);
    });

    // "..." button opens the full emoji picker for reactions
    const moreBtn = document.createElement('button');
    moreBtn.className = 'reaction-pick-btn reaction-more-btn';
    moreBtn.textContent = '⋯';
    moreBtn.title = 'All emojis';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showFullReactionPicker(msgEl, msgId, picker);
    });
    picker.appendChild(moreBtn);

    // Separator + gear icon for customization
    const sep = document.createElement('span');
    sep.className = 'reaction-pick-sep';
    sep.textContent = '|';
    picker.appendChild(sep);

    const gearBtn = document.createElement('button');
    gearBtn.className = 'reaction-pick-btn reaction-gear-btn';
    gearBtn.textContent = '⚙️';
    gearBtn.title = 'Customize quick reactions';
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showQuickEmojiEditor(picker, msgEl, msgId);
    });
    picker.appendChild(gearBtn);

    msgEl.appendChild(picker);

    // Close on click outside
    const close = (e) => {
      if (!picker.contains(e.target) && !e.target.closest('.reaction-full-picker') && !e.target.closest('.quick-emoji-editor')) {
        picker.remove();
        document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  _showFullReactionPicker(msgEl, msgId, quickPicker) {
    // Remove any existing full picker
    document.querySelectorAll('.reaction-full-picker').forEach(el => el.remove());

    const panel = document.createElement('div');
    panel.className = 'reaction-full-picker';

    // Search bar
    const searchRow = document.createElement('div');
    searchRow.className = 'reaction-full-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search emojis...';
    searchInput.className = 'reaction-full-search-input';
    searchRow.appendChild(searchInput);
    panel.appendChild(searchRow);

    // Scrollable emoji grid
    const grid = document.createElement('div');
    grid.className = 'reaction-full-grid';

    const renderAll = (filter) => {
      grid.innerHTML = '';
      const lowerFilter = filter ? filter.toLowerCase() : '';
      for (const [category, emojis] of Object.entries(this.emojiCategories)) {
        const matching = lowerFilter
          ? emojis.filter(e => {
              const names = this.emojiNames[e] || '';
              return e.includes(lowerFilter) || names.toLowerCase().includes(lowerFilter) || category.toLowerCase().includes(lowerFilter);
            })
          : emojis;
        if (matching.length === 0) continue;

        const label = document.createElement('div');
        label.className = 'reaction-full-category';
        label.textContent = category;
        grid.appendChild(label);

        const row = document.createElement('div');
        row.className = 'reaction-full-row';
        matching.forEach(emoji => {
          const btn = document.createElement('button');
          btn.className = 'reaction-full-btn';
          btn.textContent = emoji;
          btn.title = this.emojiNames[emoji] || '';
          btn.addEventListener('click', () => {
            this.socket.emit('add-reaction', { messageId: msgId, emoji });
            panel.remove();
            quickPicker.remove();
          });
          row.appendChild(btn);
        });
        grid.appendChild(row);
      }

      // Custom emojis section
      if (this.customEmojis && this.customEmojis.length > 0) {
        const customMatching = lowerFilter
          ? this.customEmojis.filter(e => e.name.toLowerCase().includes(lowerFilter) || 'custom'.includes(lowerFilter))
          : this.customEmojis;
        if (customMatching.length > 0) {
          const label = document.createElement('div');
          label.className = 'reaction-full-category';
          label.textContent = 'Custom';
          grid.appendChild(label);

          const row = document.createElement('div');
          row.className = 'reaction-full-row';
          customMatching.forEach(ce => {
            const btn = document.createElement('button');
            btn.className = 'reaction-full-btn';
            btn.innerHTML = `<img src="${ce.url}" alt=":${ce.name}:" title=":${ce.name}:" class="custom-emoji">`;
            btn.addEventListener('click', () => {
              this.socket.emit('add-reaction', { messageId: msgId, emoji: `:${ce.name}:` });
              panel.remove();
              quickPicker.remove();
            });
            row.appendChild(btn);
          });
          grid.appendChild(row);
        }
      }
    };

    renderAll('');
    panel.appendChild(grid);

    // Debounced search
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderAll(searchInput.value.trim()), 150);
    });

    // Position the panel near the quick picker
    msgEl.appendChild(panel);
    searchInput.focus();
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
    // Guard against re-entering edit mode
    if (msgEl.classList.contains('editing')) return;

    const contentEl = msgEl.querySelector('.message-content');
    if (!contentEl) return;

    // Get raw text (strip HTML)
    const rawText = contentEl.textContent;

    // Replace content with an editable textarea
    const originalHtml = contentEl.innerHTML;
    contentEl.innerHTML = '';
    msgEl.classList.add('editing'); // hide toolbar while editing

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
      msgEl.classList.remove('editing');
      contentEl.innerHTML = originalHtml;
    };

    btnRow.querySelector('.edit-cancel-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      cancel();
    });
    btnRow.querySelector('.edit-save-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      let newContent = textarea.value.trim();
      if (!newContent) return cancel();
      if (newContent === rawText) return cancel();

      // E2E: encrypt edited DM content
      const partner = this._getE2EPartner();
      if (partner) {
        try {
          newContent = await this.e2e.encrypt(newContent, partner.userId, partner.publicKeyJwk);
        } catch (err) {
          console.warn('[E2E] Failed to encrypt edited message:', err);
        }
      }

      this.socket.emit('edit-message', { messageId: msgId, content: newContent });
      cancel(); // will be updated by the server event
    });

    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        btnRow.querySelector('.edit-save-btn').click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    // Click inside edit area should not bubble to delegation handler
    contentEl.addEventListener('click', (e) => {
      e.stopPropagation();
    }, { once: false });
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

  _confirmTransferAdmin(userId, username) {
    // Build a custom modal for transfer admin with password verification
    this._closeUserGearMenu();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay transfer-admin-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal transfer-admin-modal">
        <div class="modal-header">
          <h4>🔑 Transfer Admin</h4>
          <button class="modal-close-btn transfer-admin-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="transfer-admin-warning">
            <div class="transfer-admin-warning-icon">⚠️</div>
            <div class="transfer-admin-warning-text">
              This will make <strong>${this._escapeHtml(username)}</strong> the new server Admin and demote you to <strong>Former Admin</strong> (Lv.99).
            </div>
          </div>
          <p class="transfer-admin-note">This action cannot be undone by you.</p>
          <div class="form-group">
            <label class="form-label">Enter your password to confirm</label>
            <input type="password" id="transfer-admin-pw" class="form-input" placeholder="Your password" autocomplete="current-password">
          </div>
          <p id="transfer-admin-error" class="transfer-admin-error"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary transfer-admin-cancel">Cancel</button>
          <button class="btn-danger-fill transfer-admin-confirm">Transfer Admin</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const pwInput = overlay.querySelector('#transfer-admin-pw');
    const errorEl = overlay.querySelector('#transfer-admin-error');
    const confirmBtn = overlay.querySelector('.transfer-admin-confirm');
    const close = () => overlay.remove();

    overlay.querySelector('.transfer-admin-close').addEventListener('click', close);
    overlay.querySelector('.transfer-admin-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    pwInput.focus();
    pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });

    confirmBtn.addEventListener('click', () => {
      const password = pwInput.value.trim();
      if (!password) {
        errorEl.textContent = 'Password is required.';
        errorEl.style.display = '';
        pwInput.focus();
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Transferring…';
      this.socket.emit('transfer-admin', { userId, password }, (res) => {
        if (res && res.error) {
          errorEl.textContent = res.error;
          errorEl.style.display = '';
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Transfer Admin';
          pwInput.value = '';
          pwInput.focus();
        } else if (res && res.success) {
          close();
          this._showToast(res.message || 'Admin transferred', 'info');
        }
      });
    });
  }

  // ── First-Time Setup Wizard ─────────────────────────────

  _maybeShowSetupWizard() {
    // Only show for admin, only if wizard hasn't been completed
    if (!this.user?.isAdmin) return;
    if (this.serverSettings?.setup_wizard_complete === 'true') return;
    if (this._wizardShown) return;
    this._wizardShown = true;

    const modal = document.getElementById('setup-wizard-modal');
    if (!modal) return;

    this._wizardStep = 1;
    this._wizardChannelCode = null;
    this._wizardPortResult = null;

    // Pre-fill server name from settings
    const nameInput = document.getElementById('wizard-server-name');
    if (nameInput && this.serverSettings?.server_name) {
      nameInput.value = this.serverSettings.server_name;
    }

    this._wizardUpdateUI();
    modal.style.display = 'flex';

    // Button handlers (clean up old listeners)
    const nextBtn = document.getElementById('wizard-next-btn');
    const backBtn = document.getElementById('wizard-back-btn');
    const skipBtn = document.getElementById('wizard-skip-btn');
    const portBtn = document.getElementById('wizard-check-port-btn');
    const copyBtn = document.getElementById('wizard-copy-code');

    const newNext = nextBtn.cloneNode(true);
    nextBtn.parentNode.replaceChild(newNext, nextBtn);
    const newBack = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(newBack, backBtn);
    const newSkip = skipBtn.cloneNode(true);
    skipBtn.parentNode.replaceChild(newSkip, skipBtn);
    const newPort = portBtn.cloneNode(true);
    portBtn.parentNode.replaceChild(newPort, portBtn);
    const newCopy = copyBtn.cloneNode(true);
    copyBtn.parentNode.replaceChild(newCopy, copyBtn);

    newNext.addEventListener('click', () => this._wizardNext());
    newBack.addEventListener('click', () => this._wizardBack());
    newSkip.addEventListener('click', () => this._wizardComplete());
    newPort.addEventListener('click', () => this._wizardCheckPort());
    newCopy.addEventListener('click', () => {
      if (this._wizardChannelCode) {
        navigator.clipboard.writeText(this._wizardChannelCode).then(() => {
          newCopy.textContent = 'Copied!';
          setTimeout(() => newCopy.textContent = 'Copy', 2000);
        });
      }
    });
  }

  _wizardUpdateUI() {
    const step = this._wizardStep;

    // Update step indicators
    document.querySelectorAll('.wizard-indicator').forEach(ind => {
      const s = parseInt(ind.dataset.step);
      ind.classList.remove('active', 'done');
      if (s === step) ind.classList.add('active');
      else if (s < step) ind.classList.add('done');
    });

    // Show/hide steps
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById(`wizard-step-${i}`);
      if (el) el.style.display = i === step ? 'block' : 'none';
    }

    // Back button
    const backBtn = document.getElementById('wizard-back-btn');
    if (backBtn) backBtn.style.display = step > 1 ? '' : 'none';

    // Next/Finish button text
    const nextBtn = document.getElementById('wizard-next-btn');
    if (nextBtn) {
      if (step === 4) {
        nextBtn.textContent = '🚀 Get Started';
      } else if (step === 2 && !this._wizardChannelCode) {
        nextBtn.textContent = 'Create & Continue →';
      } else {
        nextBtn.textContent = 'Next →';
      }
    }

    // Step 4 summary
    if (step === 4) {
      const chanSummary = document.getElementById('wizard-summary-channel');
      if (chanSummary) {
        chanSummary.textContent = this._wizardChannelCode
          ? `✅ Channel created (code: ${this._wizardChannelCode})`
          : '⏭️ No channel created (you can create one from the sidebar)';
      }
      const portSummary = document.getElementById('wizard-summary-port');
      if (portSummary) {
        if (this._wizardPortResult === true) portSummary.textContent = '✅ Port is open — friends can connect from anywhere';
        else if (this._wizardPortResult === false) portSummary.textContent = '⚠️ Port not reachable — check port forwarding for remote access';
        else portSummary.textContent = '⏭️ Port check skipped';
      }

      // Set final URL
      const urlEl = document.getElementById('wizard-final-url');
      if (urlEl && this._wizardPublicIp) {
        const port = location.port || (location.protocol === 'https:' ? '443' : '80');
        urlEl.textContent = `${location.protocol}//${this._wizardPublicIp}:${port}`;
      }
    }
  }

  _wizardNext() {
    const step = this._wizardStep;

    if (step === 1) {
      // Save server name if changed
      const nameInput = document.getElementById('wizard-server-name');
      const name = nameInput?.value?.trim();
      if (name && name !== (this.serverSettings?.server_name || 'Haven')) {
        this.socket.emit('update-server-setting', { key: 'server_name', value: name });
      }
      this._wizardStep = 2;
      this._wizardUpdateUI();

    } else if (step === 2) {
      // Create channel if not already created
      if (!this._wizardChannelCode) {
        const nameInput = document.getElementById('wizard-channel-name');
        const channelName = nameInput?.value?.trim() || 'General';

        // Listen for channel creation result
        const handler = (data) => {
          if (data.channels) {
            // Find the newly created channel (last one)
            const newest = data.channels[data.channels.length - 1];
            if (newest && newest.code) {
              this._wizardChannelCode = newest.code;
              const resultDiv = document.getElementById('wizard-channel-result');
              const codeEl = document.getElementById('wizard-channel-code');
              if (resultDiv) resultDiv.style.display = 'block';
              if (codeEl) codeEl.textContent = newest.code;
              nameInput.disabled = true;
              this._wizardUpdateUI();
            }
          }
          this.socket.off('channels', handler);
        };
        this.socket.on('channels', handler);
        this.socket.emit('create-channel', channelName);
      } else {
        this._wizardStep = 3;
        this._wizardUpdateUI();
      }

    } else if (step === 3) {
      this._wizardStep = 4;
      this._wizardUpdateUI();

    } else if (step === 4) {
      this._wizardComplete();
    }
  }

  _wizardBack() {
    if (this._wizardStep > 1) {
      this._wizardStep--;
      this._wizardUpdateUI();
    }
  }

  async _wizardCheckPort() {
    const checkBtn = document.getElementById('wizard-check-port-btn');
    const checking = document.getElementById('wizard-port-checking');
    const result = document.getElementById('wizard-port-result');

    if (checkBtn) checkBtn.style.display = 'none';
    if (checking) checking.style.display = 'flex';
    if (result) result.style.display = 'none';

    try {
      const resp = await fetch('/api/port-check', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      const data = await resp.json();

      if (checking) checking.style.display = 'none';
      if (result) result.style.display = 'block';

      this._wizardPublicIp = data.publicIp;

      if (data.reachable) {
        this._wizardPortResult = true;
        result.innerHTML = `
          <div class="wizard-port-success">
            ✅ <strong>Your server is reachable from the internet!</strong><br>
            Public IP: <code>${data.publicIp}</code><br>
            Friends can connect at: <code>${location.protocol}//${data.publicIp}:${location.port || 3000}</code>
          </div>`;
      } else {
        this._wizardPortResult = false;
        const port = location.port || 3000;
        result.innerHTML = `
          <div class="wizard-port-fail">
            ⚠️ <strong>Port ${port} is not reachable from the internet.</strong><br>
            ${data.publicIp ? `Your public IP is <code>${data.publicIp}</code>, but the port is blocked.` : data.error || 'Could not reach port.'}<br><br>
            <strong>To fix this:</strong>
            <ol>
              <li>Log into your router (usually <code>192.168.1.1</code>)</li>
              <li>Find <strong>Port Forwarding</strong> (or NAT / Virtual Servers)</li>
              <li>Forward port <code>${port}</code> (TCP) to your PC's local IP</li>
              <li>Open <strong>Windows Firewall</strong> for port <code>${port}</code></li>
              <li>Re-run this check</li>
            </ol>
            <strong>LAN only?</strong> If friends are on the same WiFi, this doesn't matter — they can connect directly.
          </div>`;
        if (checkBtn) {
          checkBtn.textContent = '🔄 Re-check';
          checkBtn.style.display = '';
        }
      }
    } catch (err) {
      if (checking) checking.style.display = 'none';
      if (result) {
        result.style.display = 'block';
        result.innerHTML = `<div class="wizard-port-fail">❌ Check failed: ${err.message}. You may be offline.</div>`;
      }
      if (checkBtn) {
        checkBtn.textContent = '🔄 Retry';
        checkBtn.style.display = '';
      }
    }
  }

  _wizardComplete() {
    // Mark wizard as complete in server settings
    this.socket.emit('update-server-setting', { key: 'setup_wizard_complete', value: 'true' });

    // Close the modal
    const modal = document.getElementById('setup-wizard-modal');
    if (modal) modal.style.display = 'none';

    this._showToast('Setup complete! Welcome to Haven.', 'success');
  }

  _applyServerSettings() {
    // Don't overwrite admin form inputs when settings modal is open (user may be editing)
    const modalOpen = document.getElementById('settings-modal')?.style.display === 'flex';

    if (!modalOpen) {
      const vis = document.getElementById('member-visibility-select');
      if (vis && this.serverSettings.member_visibility) {
        vis.value = this.serverSettings.member_visibility;
      }
      const nameInput = document.getElementById('server-name-input');
      if (nameInput && this.serverSettings.server_name !== undefined) {
        nameInput.value = this.serverSettings.server_name || '';
      }
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
      const maxUpload = document.getElementById('max-upload-mb');
      if (maxUpload) {
        maxUpload.value = this.serverSettings.max_upload_mb || '25';
      }
      const whitelistToggle = document.getElementById('whitelist-enabled');
      if (whitelistToggle) {
        whitelistToggle.checked = this.serverSettings.whitelist_enabled === 'true';
      }

      // Tunnel settings (live state, not part of Save/Cancel flow)
      const tunnelProvider = document.getElementById('tunnel-provider-select');
      if (tunnelProvider && this.serverSettings.tunnel_provider) {
        tunnelProvider.value = this.serverSettings.tunnel_provider;
      }
      this._refreshTunnelStatus();

      // Server invite code (live state, not part of Save/Cancel flow)
      const serverCodeEl = document.getElementById('server-code-value');
      if (serverCodeEl) {
        const code = this.serverSettings.server_code;
        serverCodeEl.textContent = code || '—';
        serverCodeEl.style.opacity = code ? '1' : '0.4';
      }

      this._renderPermThresholds();
    }

    // Always update visual branding regardless of modal state
    this._applyServerBranding();

    if (!modalOpen && this.user && this.user.isAdmin) {
      this.socket.emit('get-whitelist');
    }
  }

  /* ── Admin settings save / cancel ───────────────────── */

  _renderWebhooksList(webhooks) {
    const container = document.getElementById('webhooks-list');
    if (!container) return;
    if (!webhooks.length) {
      container.innerHTML = '<p class="muted-text">No bots configured</p>';
      return;
    }
    // Simple preview list for server settings — full management is in the bot modal
    container.innerHTML = webhooks.map(wh => {
      const statusDot = wh.is_active ? '🟢' : '🔴';
      const avatarHtml = wh.avatar_url
        ? `<img src="${this._escapeHtml(wh.avatar_url)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover">`
        : '🤖';
      return `<div class="role-preview-item">${avatarHtml} <span style="font-weight:600">${this._escapeHtml(wh.name)}</span> <span style="opacity:0.5;font-size:11px">#${this._escapeHtml(wh.channel_name)}</span> ${statusDot}</div>`;
    }).join('');
  }

  _syncSettingsNav() {
    const isAdmin = document.getElementById('admin-mod-panel')?.style.display !== 'none';
    document.querySelectorAll('.settings-nav-admin').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
  }

  _snapshotAdminSettings() {
    this._adminSnapshot = {
      server_name: this.serverSettings.server_name || 'HAVEN',
      member_visibility: this.serverSettings.member_visibility || 'online',
      cleanup_enabled: this.serverSettings.cleanup_enabled || 'false',
      cleanup_max_age_days: this.serverSettings.cleanup_max_age_days || '0',
      cleanup_max_size_mb: this.serverSettings.cleanup_max_size_mb || '0',
      whitelist_enabled: this.serverSettings.whitelist_enabled || 'false',
      max_upload_mb: this.serverSettings.max_upload_mb || '25'
    };
    // Load webhooks list for admin preview
    if (this.user?.isAdmin) {
      this.socket.emit('get-webhooks');
    }
  }

  _saveAdminSettings() {
    if (!this.user?.isAdmin) {
      document.getElementById('settings-modal').style.display = 'none';
      return;
    }
    const snap = this._adminSnapshot || {};
    let changed = false;

    const name = document.getElementById('server-name-input')?.value.trim() || 'HAVEN';
    if (name !== snap.server_name) {
      this.socket.emit('update-server-setting', { key: 'server_name', value: name });
      changed = true;
    }

    const vis = document.getElementById('member-visibility-select')?.value;
    if (vis && vis !== snap.member_visibility) {
      this.socket.emit('update-server-setting', { key: 'member_visibility', value: vis });
      changed = true;
    }

    const cleanEnabled = document.getElementById('cleanup-enabled')?.checked ? 'true' : 'false';
    if (cleanEnabled !== snap.cleanup_enabled) {
      this.socket.emit('update-server-setting', { key: 'cleanup_enabled', value: cleanEnabled });
      changed = true;
    }

    const cleanAge = String(Math.max(0, Math.min(3650, parseInt(document.getElementById('cleanup-max-age')?.value) || 0)));
    if (cleanAge !== (snap.cleanup_max_age_days || '0')) {
      this.socket.emit('update-server-setting', { key: 'cleanup_max_age_days', value: cleanAge });
      changed = true;
    }

    const cleanSize = String(Math.max(0, Math.min(100000, parseInt(document.getElementById('cleanup-max-size')?.value) || 0)));
    if (cleanSize !== (snap.cleanup_max_size_mb || '0')) {
      this.socket.emit('update-server-setting', { key: 'cleanup_max_size_mb', value: cleanSize });
      changed = true;
    }

    const wlEnabled = document.getElementById('whitelist-enabled')?.checked ? 'true' : 'false';
    if (wlEnabled !== snap.whitelist_enabled) {
      this.socket.emit('whitelist-toggle', { enabled: wlEnabled === 'true' });
      this.socket.emit('update-server-setting', { key: 'whitelist_enabled', value: wlEnabled });
      changed = true;
    }

    const maxUpload = String(Math.max(1, Math.min(2048, parseInt(document.getElementById('max-upload-mb')?.value) || 25)));
    if (maxUpload !== (snap.max_upload_mb || '25')) {
      this.socket.emit('update-server-setting', { key: 'max_upload_mb', value: maxUpload });
      changed = true;
    }

    if (changed) {
      this._showToast('Settings saved', 'success');
    } else {
      this._showToast('No changes to save', 'info');
    }
    document.getElementById('settings-modal').style.display = 'none';
  }

  _cancelAdminSettings() {
    const snap = this._adminSnapshot;
    if (snap) {
      const ni = document.getElementById('server-name-input');
      if (ni) ni.value = snap.server_name;
      const vis = document.getElementById('member-visibility-select');
      if (vis) vis.value = snap.member_visibility;
      const ce = document.getElementById('cleanup-enabled');
      if (ce) ce.checked = snap.cleanup_enabled === 'true';
      const ca = document.getElementById('cleanup-max-age');
      if (ca) ca.value = snap.cleanup_max_age_days;
      const cs = document.getElementById('cleanup-max-size');
      if (cs) cs.value = snap.cleanup_max_size_mb;
      const wl = document.getElementById('whitelist-enabled');
      if (wl) wl.checked = snap.whitelist_enabled === 'true';
      const mu = document.getElementById('max-upload-mb');
      if (mu) mu.value = snap.max_upload_mb || '25';
    }
    document.getElementById('settings-modal').style.display = 'none';
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

  /* ── Server Branding (icon + name) ──────────────────── */

  _applyServerBranding() {
    const name = this.serverSettings.server_name || 'HAVEN';
    const icon = this.serverSettings.server_icon || '';

    // Sidebar brand text
    const brandText = document.querySelector('.brand-text');
    if (brandText) brandText.textContent = name;

    // Sidebar brand icon
    const logoSm = document.querySelector('.logo-sm');
    if (logoSm) {
      if (icon) {
        logoSm.style.display = 'none';
        let brandIcon = document.querySelector('.brand-icon');
        if (!brandIcon) {
          brandIcon = document.createElement('img');
          brandIcon.className = 'brand-icon';
          logoSm.parentNode.insertBefore(brandIcon, logoSm);
        }
        brandIcon.src = icon;
        brandIcon.style.display = '';
      } else {
        logoSm.style.display = '';
        const brandIcon = document.querySelector('.brand-icon');
        if (brandIcon) brandIcon.style.display = 'none';
      }
    }

    // Server bar icon
    const homeServer = document.getElementById('home-server');
    if (homeServer) {
      const existingImg = homeServer.querySelector('img');
      const iconText = homeServer.querySelector('.server-icon-text');
      if (icon) {
        if (iconText) iconText.style.display = 'none';
        if (!existingImg) {
          const img = document.createElement('img');
          img.src = icon;
          img.alt = name;
          homeServer.insertBefore(img, homeServer.firstChild);
        } else {
          existingImg.src = icon;
          existingImg.style.display = '';
        }
      } else {
        if (existingImg) existingImg.style.display = 'none';
        if (iconText) iconText.style.display = '';
      }
      homeServer.title = name;
    }

    // Admin preview
    const preview = document.getElementById('server-icon-preview');
    if (preview) {
      if (icon) {
        preview.innerHTML = `<img src="${icon}" alt="Server Icon">`;
      } else {
        preview.innerHTML = '<span class="server-icon-text">⬡</span>';
      }
    }
  }

  _initServerBranding() {
    // Server name — saved via admin Save button (no auto-save)

    // Server icon upload
    document.getElementById('server-icon-upload-btn')?.addEventListener('click', async () => {
      const fileInput = document.getElementById('server-icon-file');
      if (!fileInput || !fileInput.files[0]) return this._showToast('Select an image first', 'error');
      const form = new FormData();
      form.append('image', fileInput.files[0]);
      try {
        const res = await fetch('/api/upload-server-icon', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: form
        });
        const data = await res.json();
        if (data.error) return this._showToast(data.error, 'error');
        this.socket.emit('update-server-setting', { key: 'server_icon', value: data.url });
        this._showToast('Server icon updated', 'success');
        fileInput.value = '';
      } catch (err) {
        this._showToast('Upload failed', 'error');
      }
    });

    // Server icon remove
    document.getElementById('server-icon-remove-btn')?.addEventListener('click', () => {
      this.socket.emit('update-server-setting', { key: 'server_icon', value: '' });
      this._showToast('Server icon removed', 'success');
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
  // EMOJI AUTOCOMPLETE  (:name)
  // ═══════════════════════════════════════════════════════

  _checkEmojiTrigger() {
    const input = document.getElementById('message-input');
    const text = input.value;
    const cursor = input.selectionStart;

    // Walk backwards from cursor to find a ':' that starts a potential emoji token
    let colonIdx = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ':') { colonIdx = i; break; }
      if (ch === ' ' || ch === '\n') break; // stop at whitespace
    }

    if (colonIdx === -1) { this._hideEmojiDropdown(); return; }

    const query = text.substring(colonIdx + 1, cursor).toLowerCase();
    if (query.length < 2) { this._hideEmojiDropdown(); return; }

    this._emojiColonStart = colonIdx;
    this._showEmojiDropdown(query);
  }

  _showEmojiDropdown(query) {
    const dd = document.getElementById('emoji-dropdown');
    dd.innerHTML = '';

    let results = [];

    // Custom emojis first
    if (this.customEmojis) {
      this.customEmojis.forEach(em => {
        if (em.name.toLowerCase().includes(query)) {
          results.push({ type: 'custom', name: em.name, url: em.url });
        }
      });
    }

    // Standard emojis by name/keyword
    if (this.emojiNames) {
      for (const [name, char] of this.emojiNames) {
        if (name.includes(query)) {
          results.push({ type: 'standard', name, char });
        }
        if (results.length >= 20) break;
      }
    }

    results = results.slice(0, 10);
    if (!results.length) { this._hideEmojiDropdown(); return; }

    results.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'emoji-ac-item' + (i === 0 ? ' active' : '');
      const preview = document.createElement('span');
      preview.className = 'emoji-ac-preview';
      if (r.type === 'custom') {
        const img = document.createElement('img');
        img.src = r.url;
        img.alt = r.name;
        img.style.width = '20px'; img.style.height = '20px';
        preview.appendChild(img);
      } else {
        preview.classList.add('emoji-ac-preview-char');
        preview.textContent = r.char;
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'emoji-ac-name';
      nameSpan.textContent = ':' + r.name + ':';
      item.appendChild(preview);
      item.appendChild(nameSpan);
      item.addEventListener('click', () => {
        if (r.type === 'custom') {
          this._insertEmojiAc(':' + r.name + ':');
        } else {
          this._insertEmojiAc(r.char);
        }
      });
      dd.appendChild(item);
    });

    dd.style.display = 'block';
  }

  _hideEmojiDropdown() {
    const dd = document.getElementById('emoji-dropdown');
    if (dd) dd.style.display = 'none';
  }

  _navigateEmojiDropdown(dir) {
    const dd = document.getElementById('emoji-dropdown');
    const items = dd.querySelectorAll('.emoji-ac-item');
    if (!items.length) return;
    let idx = -1;
    items.forEach((it, i) => { if (it.classList.contains('active')) idx = i; });
    items.forEach(it => it.classList.remove('active'));
    idx += dir;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  _insertEmojiAc(insert) {
    const input = document.getElementById('message-input');
    const before = input.value.substring(0, this._emojiColonStart);
    const after = input.value.substring(input.selectionStart);
    input.value = before + insert + ' ' + after;
    input.selectionStart = input.selectionEnd = this._emojiColonStart + insert.length + 1;
    input.focus();
    this._hideEmojiDropdown();
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

    // Insert status dot to the right of the username block
    const statusDot = document.createElement('span');
    statusDot.id = 'user-status-dot';
    statusDot.className = 'user-dot status-picker-dot';
    statusDot.title = 'Set status';
    statusDot.addEventListener('click', (e) => { e.stopPropagation(); this._toggleStatusPicker(); });
    const userNames = userBar.querySelector('.user-names');
    if (userNames && userNames.nextSibling) {
      userBar.insertBefore(statusDot, userNames.nextSibling);
    } else {
      userBar.appendChild(statusDot);
    }

    // Build dropdown (opens downward to avoid clipping)
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
        // Track whether user manually chose a non-online status (away/dnd/invisible)
        this._manualStatusOverride = (status !== 'online');
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
  // ── Idle Detection (auto-away after 10 min) ───────────
  // ═══════════════════════════════════════════════════════

  _setupIdleDetection() {
    const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes of no activity
    const HIDDEN_TIMEOUT = 2 * 60 * 1000; // 2 minutes when tab is hidden
    let lastActivity = Date.now();
    let idleEmitPending = false;

    const goIdle = () => {
      if (this.userStatus === 'online' && !this._manualStatusOverride) {
        this.userStatus = 'away';  // optimistic local update (server confirms via status-updated)
        this._updateStatusPickerUI();
        this.socket.emit('set-status', { status: 'away', statusText: this.userStatusText });
      }
    };

    const goOnline = () => {
      if (this.userStatus === 'away' && !this._manualStatusOverride) {
        this.userStatus = 'online';  // optimistic local update
        this._updateStatusPickerUI();
        this.socket.emit('set-status', { status: 'online', statusText: this.userStatusText });
      }
    };

    const resetIdle = () => {
      lastActivity = Date.now();
      // Restore from away if needed (debounced — only emit once)
      if (this.userStatus === 'away' && !this._manualStatusOverride && !idleEmitPending) {
        idleEmitPending = true;
        setTimeout(() => { idleEmitPending = false; goOnline(); }, 300);
      }
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(goIdle, document.hidden ? HIDDEN_TIMEOUT : IDLE_TIMEOUT);
    };

    // Only fire on intentional input — NOT mousemove (micro-jitters keep resetting)
    ['keydown', 'click', 'scroll', 'touchstart', 'mousedown'].forEach(evt => {
      document.addEventListener(evt, resetIdle, { passive: true });
    });

    // Tab visibility: go idle faster when tab is hidden, come back when visible
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(goIdle, HIDDEN_TIMEOUT);
      } else {
        resetIdle();
      }
    });

    resetIdle();
  }

  // ═══════════════════════════════════════════════════════
  // ── General File Upload ───────────────────────────────
  // ═══════════════════════════════════════════════════════

  _setupFileUpload() {
    // Merged into upload-btn — no separate file button needed.
    // The unified upload button opens a file picker that accepts all types;
    // images are queued (with preview), other files upload immediately.
  }

  _handleFileUpload(input) {
    if (!input.files.length || !this.currentChannel) return;
    const file = input.files[0];
    this._uploadGeneralFile(file);
    input.value = '';
  }

  /** Upload any file via /api/upload-file — used by drag & drop, paste, and 📎 button */
  _uploadGeneralFile(file) {
    if (!this.currentChannel) return this._showToast('Select a channel first', 'error');
    const maxMb = parseInt(this.serverSettings?.max_upload_mb) || 25;
    if (file.size > maxMb * 1024 * 1024) {
      this._showToast(`File too large (max ${maxMb} MB)`, 'error');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    this._showToast(`Uploading ${file.name}…`, 'info');

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
  }

  _formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ═══════════════════════════════════════════════════════
  // ── Resizable Sidebars ─────────────────────────────────

  _setupResizableSidebars() {
    // Left sidebar resize (delta-based so it works with mod-mode panel repositioning)
    const sidebar = document.querySelector('.sidebar');
    const leftHandle = document.getElementById('sidebar-resize-handle');
    if (sidebar && leftHandle) {
      const savedLeft = localStorage.getItem('haven_sidebar_width');
      if (savedLeft) sidebar.style.width = savedLeft + 'px';

      let dragging = false, startX = 0, startW = 0;
      leftHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = sidebar.getBoundingClientRect().width;
        leftHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // Flip direction when mod mode has moved this sidebar to the right
        const factor = sidebar.dataset.panelPos === 'right' ? -1 : 1;
        let w = startW + (e.clientX - startX) * factor;
        w = Math.max(200, Math.min(400, w));
        sidebar.style.width = w + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        leftHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('haven_sidebar_width', parseInt(sidebar.style.width));
      });
    }

    // Right sidebar resize (delta-based)
    const rightSidebar = document.getElementById('right-sidebar');
    const rightHandle = document.getElementById('right-sidebar-resize-handle');
    if (rightSidebar && rightHandle) {
      const savedRight = localStorage.getItem('haven_right_sidebar_width');
      if (savedRight) rightSidebar.style.width = savedRight + 'px';

      let dragging = false, startX = 0, startW = 0;
      rightHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = rightSidebar.getBoundingClientRect().width;
        rightHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // Default right-side: shrinks when moving right; flip if mod moved it left
        const factor = rightSidebar.dataset.panelPos === 'left' ? 1 : -1;
        let w = startW + (e.clientX - startX) * factor;
        w = Math.max(200, Math.min(400, w));
        rightSidebar.style.width = w + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        rightHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('haven_right_sidebar_width', parseInt(rightSidebar.style.width));
      });
    }

    // Sidebar split handle (channels/DM divider)
    const splitHandle = document.getElementById('sidebar-split-handle');
    const splitContainer = document.getElementById('sidebar-split');
    const channelsPane = document.getElementById('channels-pane');
    const dmPane = document.getElementById('dm-pane');
    if (splitHandle && splitContainer && channelsPane && dmPane) {
      const savedRatio = localStorage.getItem('haven_sidebar_split_ratio');
      if (savedRatio) {
        channelsPane.style.flex = `${savedRatio} 1 0`;
        dmPane.style.flex = `${1 - parseFloat(savedRatio)} 1 0`;
      }

      let dragging = false;
      splitHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        splitHandle.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = splitContainer.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const total = rect.height;
        let ratio = y / total;
        ratio = Math.max(0.15, Math.min(0.85, ratio));
        channelsPane.style.flex = `${ratio} 1 0`;
        dmPane.style.flex = `${1 - ratio} 1 0`;
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        splitHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const chFlex = parseFloat(channelsPane.style.flex) || 0.6;
        localStorage.setItem('haven_sidebar_split_ratio', chFlex);
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // DISCORD IMPORT
  // ═══════════════════════════════════════════════════════

  _setupDiscordImport() {
    const modal      = document.getElementById('import-modal');
    const stepUpload = document.getElementById('import-step-upload');
    const stepPreview= document.getElementById('import-step-preview');
    const stepDone   = document.getElementById('import-step-done');
    const dropzone   = document.getElementById('import-dropzone');
    const fileInput  = document.getElementById('import-file-input');
    const browseLink = document.getElementById('import-browse-link');
    const progressWrap = document.getElementById('import-upload-progress');
    const progressFill = document.getElementById('import-progress-fill');
    const statusText   = document.getElementById('import-upload-status');
    const channelList  = document.getElementById('import-channel-list');
    const executeBtn   = document.getElementById('import-execute-btn');
    const backBtn      = document.getElementById('import-back-btn');
    if (!modal) return;

    let currentImportId = null;
    let currentPreview  = null;

    const resetModal = () => {
      stepUpload.style.display  = '';
      stepPreview.style.display = 'none';
      stepDone.style.display    = 'none';
      progressWrap.style.display = 'none';
      progressFill.style.width  = '0%';
      statusText.textContent    = 'Uploading...';
      dropzone.style.display    = '';
      fileInput.value           = '';
      channelList.innerHTML     = '';
      currentImportId           = null;
      currentPreview            = null;
      // Reset connect tab state
      const cs1 = document.getElementById('import-connect-step-token');
      const cs2 = document.getElementById('import-connect-step-servers');
      const cs3 = document.getElementById('import-connect-step-channels');
      if (cs1) cs1.style.display = '';
      if (cs2) cs2.style.display = 'none';
      if (cs3) cs3.style.display = 'none';
      const cStatus = document.getElementById('import-connect-status');
      if (cStatus) { cStatus.style.display = 'none'; cStatus.textContent = ''; }
      const fStatus = document.getElementById('import-fetch-status');
      if (fStatus) { fStatus.style.display = 'none'; fStatus.textContent = ''; }
      // Reset to file tab
      document.querySelectorAll('.import-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'file'));
      const fileTab = document.getElementById('import-tab-file');
      const connectTab = document.getElementById('import-tab-connect');
      if (fileTab) fileTab.style.display = '';
      if (connectTab) connectTab.style.display = 'none';
    };

    // Open import modal
    document.getElementById('open-import-btn')?.addEventListener('click', () => {
      resetModal();
      modal.style.display = 'flex';
    });

    // Close
    document.getElementById('close-import-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });

    // Browse link
    browseLink?.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });

    // File input change
    fileInput?.addEventListener('change', () => {
      if (fileInput.files.length) this._importUploadFile(fileInput.files[0]);
    });

    // Drag & drop
    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) this._importUploadFile(file);
    });

    // Back button
    backBtn?.addEventListener('click', () => {
      resetModal();
    });

    // Select all / Deselect all toggle
    const toggleAllLink = document.getElementById('import-toggle-all');
    toggleAllLink?.addEventListener('click', (e) => {
      e.preventDefault();
      const boxes = channelList.querySelectorAll('input[type="checkbox"]');
      const allChecked = [...boxes].every(cb => cb.checked);
      boxes.forEach(cb => cb.checked = !allChecked);
      toggleAllLink.textContent = allChecked ? 'Select All' : 'Deselect All';
    });

    // Execute button
    executeBtn?.addEventListener('click', () => {
      if (!currentImportId || !currentPreview) return;
      const selected = [];
      channelList.querySelectorAll('.import-channel-row').forEach(row => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (!cb?.checked) return;
        const nameInput = row.querySelector('input[type="text"]');
        selected.push({
          discordId: row.dataset.discordId,
          originalName: row.dataset.originalName,
          name: nameInput?.value?.trim() || row.dataset.originalName
        });
      });
      if (selected.length === 0) {
        alert('Select at least one channel to import.');
        return;
      }
      const totalMsgs = currentPreview.channels
        .filter(c => selected.some(s => (s.discordId && s.discordId === c.discordId) || s.originalName === c.name))
        .reduce((sum, c) => sum + c.messageCount, 0);
      if (!confirm(`Import ${selected.length} channel${selected.length !== 1 ? 's' : ''} with ~${totalMsgs.toLocaleString()} messages?\n\nThis cannot be undone easily.`)) return;
      this._importExecute(currentImportId, selected);
    });

    // ── Tab switching ────────────────────────────────────
    document.querySelectorAll('.import-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        const fileTab = document.getElementById('import-tab-file');
        const connectTab = document.getElementById('import-tab-connect');
        if (fileTab) fileTab.style.display = target === 'file' ? '' : 'none';
        if (connectTab) connectTab.style.display = target === 'connect' ? '' : 'none';
      });
    });

    // ── Connect to Discord flow ──────────────────────────
    const connectBtn = document.getElementById('import-connect-btn');
    const connectStatus = document.getElementById('import-connect-status');

    connectBtn?.addEventListener('click', async () => {
      const tokenInput = document.getElementById('import-discord-token');
      const discordToken = tokenInput?.value?.trim();
      if (!discordToken) { this._showToast('Paste your Discord token first', 'error'); return; }

      connectBtn.disabled = true;
      connectBtn.textContent = '⏳';
      connectStatus.style.display = '';
      connectStatus.textContent = 'Connecting...';
      connectStatus.style.color = '';

      try {
        const res = await fetch('/api/import/discord/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
          body: JSON.stringify({ discordToken })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Connection failed');

        // Show server list
        document.getElementById('import-connect-step-token').style.display = 'none';
        const serversStep = document.getElementById('import-connect-step-servers');
        serversStep.style.display = '';
        document.getElementById('import-discord-username').textContent = data.user.username;

        const serverList = document.getElementById('import-server-list');
        serverList.innerHTML = '';
        data.guilds.forEach(g => {
          const card = document.createElement('button');
          card.className = 'import-server-card';
          const iconUrl = g.icon
            ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
            : '';
          card.innerHTML = `
            ${iconUrl ? `<img src="${iconUrl}" alt="" class="import-server-icon">` : '<span class="import-server-icon-placeholder">🏠</span>'}
            <span class="import-server-name">${this._escapeHtml(g.name)}</span>
          `;
          card.addEventListener('click', () => this._importPickGuild(g));
          serverList.appendChild(card);
        });
      } catch (err) {
        connectStatus.textContent = '❌ ' + err.message;
        connectStatus.style.color = '#ed4245';
      } finally {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
      }
    });

    // Disconnect
    document.getElementById('import-connect-disconnect')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('import-connect-step-servers').style.display = 'none';
      document.getElementById('import-connect-step-token').style.display = '';
      document.getElementById('import-discord-token').value = '';
    });

    // Back to servers from channels
    document.getElementById('import-connect-back-servers')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('import-connect-step-channels').style.display = 'none';
      document.getElementById('import-connect-step-servers').style.display = '';
    });

    // Toggle all channels in connect flow
    const connectToggleAll = document.getElementById('import-connect-toggle-all');
    connectToggleAll?.addEventListener('click', (e) => {
      e.preventDefault();
      const cList = document.getElementById('import-connect-channel-list');
      const boxes = cList.querySelectorAll('input[type="checkbox"]');
      const allChecked = [...boxes].every(cb => cb.checked);
      boxes.forEach(cb => cb.checked = !allChecked);
      connectToggleAll.textContent = allChecked ? 'Select All' : 'Deselect All';
    });

    // Fetch messages button
    document.getElementById('import-fetch-btn')?.addEventListener('click', () => {
      this._importConnectFetch();
    });

    // Expose state setters for the upload/execute helpers
    this._importSetState = (importId, preview) => {
      currentImportId = importId;
      currentPreview  = preview;
    };
  }

  async _importUploadFile(file) {
    const modal        = document.getElementById('import-modal');
    const dropzone     = document.getElementById('import-dropzone');
    const progressWrap = document.getElementById('import-upload-progress');
    const progressFill = document.getElementById('import-progress-fill');
    const statusText   = document.getElementById('import-upload-status');
    const stepUpload   = document.getElementById('import-step-upload');
    const stepPreview  = document.getElementById('import-step-preview');
    const channelList  = document.getElementById('import-channel-list');

    // Validate extension
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['json', 'zip'].includes(ext)) {
      alert('Please upload a .json or .zip file.');
      return;
    }

    // Show progress
    dropzone.style.display     = 'none';
    progressWrap.style.display = '';
    progressFill.style.width   = '0%';
    statusText.textContent     = `Uploading ${file.name}...`;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/import/discord/upload');
      xhr.setRequestHeader('Authorization', 'Bearer ' + this.token);

      // Progress tracking
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = pct + '%';
          statusText.textContent = `Uploading... ${pct}%`;
        }
      });

      const result = await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            try {
              const err = JSON.parse(xhr.responseText);
              reject(new Error(err.error || 'Upload failed'));
            } catch {
              reject(new Error('Upload failed (status ' + xhr.status + ')'));
            }
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      // Switch to parsing
      progressFill.style.width = '100%';
      statusText.textContent = 'Parsing...';
      await new Promise(r => setTimeout(r, 300));

      // Show preview
      this._importSetState(result.importId, result);
      stepUpload.style.display  = 'none';
      stepPreview.style.display = '';

      // Format badge
      const badge = document.getElementById('import-format-badge');
      badge.textContent = result.format;
      badge.classList.toggle('official', result.format === 'Discord Data Package');

      document.getElementById('import-server-name').textContent = result.serverName;
      document.getElementById('import-total-msgs').textContent = `${result.totalMessages.toLocaleString()} messages total`;

      // Build channel list
      channelList.innerHTML = '';
      result.channels.forEach(ch => {
        const row = document.createElement('div');
        row.className = 'import-channel-row';
        row.dataset.discordId = ch.discordId || '';
        row.dataset.originalName = ch.name;
        row.innerHTML = `
          <label>
            <input type="checkbox" checked>
            <span class="import-ch-name">
              <input type="text" value="${this._escapeHtml(ch.name)}" title="Rename channel">
            </span>
          </label>
          <span class="import-ch-count">${ch.messageCount.toLocaleString()} msgs</span>
        `;
        channelList.appendChild(row);
      });

    } catch (err) {
      statusText.textContent = '❌ ' + err.message;
      progressFill.style.width = '100%';
      progressFill.style.background = '#ed4245';
      setTimeout(() => {
        dropzone.style.display     = '';
        progressWrap.style.display = 'none';
        progressFill.style.background = '';
      }, 3000);
    }
  }

  // ── Discord Direct Connect helpers ────────────────────

  async _importPickGuild(guild) {
    const serversStep = document.getElementById('import-connect-step-servers');
    const channelsStep = document.getElementById('import-connect-step-channels');
    const fetchStatus = document.getElementById('import-fetch-status');

    document.getElementById('import-connect-guild-name').textContent = guild.name;
    serversStep.style.display = 'none';
    channelsStep.style.display = '';
    fetchStatus.style.display = '';
    fetchStatus.textContent = 'Loading channels...';
    fetchStatus.style.color = '';

    try {
      const discordToken = document.getElementById('import-discord-token')?.value?.trim();
      const res = await fetch('/api/import/discord/guild-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
        body: JSON.stringify({ discordToken, guildId: guild.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load channels');

      const cList = document.getElementById('import-connect-channel-list');
      cList.innerHTML = '';
      let lastCategory = null;

      // Type icons for visual distinction
      const typeIcons = { text: '#', announcement: '📢', forum: '💬', media: '🖼️', thread: '🧵' };

      // Render channels grouped by category
      data.channels.forEach(ch => {
        if (ch.category && ch.category !== lastCategory) {
          const catDiv = document.createElement('div');
          catDiv.className = 'import-channel-category';
          catDiv.textContent = ch.category;
          cList.appendChild(catDiv);
          lastCategory = ch.category;
        }
        const icon = typeIcons[ch.type] || '#';
        const tagHint = ch.tags && ch.tags.length
          ? ` <span class="muted-text" style="font-size:10px">(${ch.tags.map(t => t.name).join(', ')})</span>`
          : '';
        const row = document.createElement('div');
        row.className = 'import-channel-row';
        row.dataset.channelId = ch.id;
        row.dataset.channelName = ch.name;
        row.dataset.channelTopic = ch.topic || '';
        row.dataset.channelCategory = ch.category || '';
        row.innerHTML = `
          <label>
            <input type="checkbox" checked>
            <span class="import-ch-name">${icon} ${this._escapeHtml(ch.name)}${tagHint}</span>
          </label>
          <span class="import-ch-count import-type-badge">${ch.type}</span>
        `;
        cList.appendChild(row);

        // Render threads nested under this channel
        if (data.threads) {
          const childThreads = data.threads.filter(t => t.parentId === ch.id);
          childThreads.forEach(t => {
            const tagStr = t.tags && t.tags.length
              ? ` <span class="muted-text" style="font-size:10px">[${t.tags.join(', ')}]</span>`
              : '';
            const tRow = document.createElement('div');
            tRow.className = 'import-channel-row import-thread-row';
            tRow.dataset.channelId = t.id;
            tRow.dataset.channelName = t.name;
            tRow.dataset.channelTopic = '';
            tRow.dataset.channelCategory = ch.category || '';
            tRow.innerHTML = `
              <label>
                <input type="checkbox" checked>
                <span class="import-ch-name">🧵 ${this._escapeHtml(t.name)}${tagStr}</span>
              </label>
              <span class="import-ch-count import-type-badge">thread</span>
            `;
            cList.appendChild(tRow);
          });
        }
      });

      // Render orphan threads (parent not in the list)
      if (data.threads) {
        const renderedParents = new Set(data.channels.map(c => c.id));
        const orphans = data.threads.filter(t => !renderedParents.has(t.parentId));
        if (orphans.length > 0) {
          const catDiv = document.createElement('div');
          catDiv.className = 'import-channel-category';
          catDiv.textContent = 'Other Threads';
          cList.appendChild(catDiv);
          orphans.forEach(t => {
            const tRow = document.createElement('div');
            tRow.className = 'import-channel-row import-thread-row';
            tRow.dataset.channelId = t.id;
            tRow.dataset.channelName = t.name;
            tRow.dataset.channelTopic = '';
            tRow.dataset.channelCategory = t.category || '';
            tRow.innerHTML = `
              <label>
                <input type="checkbox" checked>
                <span class="import-ch-name">🧵 ${this._escapeHtml(t.name)}${t.parentName ? ` <span class="muted-text" style="font-size:10px">in #${this._escapeHtml(t.parentName)}</span>` : ''}</span>
              </label>
              <span class="import-ch-count import-type-badge">thread</span>
            `;
            cList.appendChild(tRow);
          });
        }
      }

      this._connectGuild = guild;
      fetchStatus.style.display = 'none';
    } catch (err) {
      fetchStatus.textContent = '❌ ' + err.message;
      fetchStatus.style.color = '#ed4245';
    }
  }

  async _importConnectFetch() {
    const cList = document.getElementById('import-connect-channel-list');
    const fetchBtn = document.getElementById('import-fetch-btn');
    const fetchStatus = document.getElementById('import-fetch-status');
    const stepUpload = document.getElementById('import-step-upload');
    const stepPreview = document.getElementById('import-step-preview');
    const channelList = document.getElementById('import-channel-list');

    // Build selected channel list
    const selected = [];
    cList.querySelectorAll('.import-channel-row').forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (!cb?.checked) return;
      selected.push({
        id: row.dataset.channelId,
        name: row.dataset.channelName,
        topic: row.dataset.channelTopic,
        category: row.dataset.channelCategory
      });
    });
    if (!selected.length) { this._showToast('Select at least one channel', 'error'); return; }

    fetchBtn.disabled = true;
    fetchBtn.textContent = '⏳ Fetching...';
    fetchStatus.style.display = '';
    fetchStatus.textContent = `Fetching ${selected.length} channel${selected.length !== 1 ? 's' : ''}... This may take a while for large servers.`;
    fetchStatus.style.color = '';

    try {
      const discordToken = document.getElementById('import-discord-token')?.value?.trim();
      const res = await fetch('/api/import/discord/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
        body: JSON.stringify({
          discordToken,
          guildName: this._connectGuild?.name || 'Discord Import',
          channels: selected
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Fetch failed');

      // Transition to the standard preview step (reuses existing execute flow)
      this._importSetState(result.importId, result);
      stepUpload.style.display = 'none';
      stepPreview.style.display = '';

      const badge = document.getElementById('import-format-badge');
      badge.textContent = result.format;
      badge.classList.remove('official');

      document.getElementById('import-server-name').textContent = result.serverName;
      document.getElementById('import-total-msgs').textContent = `${result.totalMessages.toLocaleString()} messages total`;

      channelList.innerHTML = '';
      result.channels.forEach(ch => {
        const row = document.createElement('div');
        row.className = 'import-channel-row';
        row.dataset.discordId = ch.discordId || '';
        row.dataset.originalName = ch.name;
        row.innerHTML = `
          <label>
            <input type="checkbox" checked>
            <span class="import-ch-name">
              <input type="text" value="${this._escapeHtml(ch.name)}" title="Rename channel">
            </span>
          </label>
          <span class="import-ch-count">${ch.messageCount.toLocaleString()} msgs</span>
        `;
        channelList.appendChild(row);
      });
    } catch (err) {
      fetchStatus.textContent = '❌ ' + err.message;
      fetchStatus.style.color = '#ed4245';
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = '📥 Fetch Messages';
    }
  }

  async _importExecute(importId, selectedChannels) {
    const executeBtn = document.getElementById('import-execute-btn');
    const stepPreview = document.getElementById('import-step-preview');
    const stepDone    = document.getElementById('import-step-done');
    const doneMsg     = document.getElementById('import-done-msg');

    executeBtn.disabled = true;
    executeBtn.textContent = '⏳ Importing...';

    try {
      const res = await fetch('/api/import/discord/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.token
        },
        body: JSON.stringify({ importId, selectedChannels })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');

      // Show done step
      stepPreview.style.display = 'none';
      stepDone.style.display    = '';
      doneMsg.textContent = `Successfully imported ${data.channelsCreated} channel${data.channelsCreated !== 1 ? 's' : ''} with ${data.messagesImported.toLocaleString()} messages.`;

      // Refresh channel list
      if (this.socket) this.socket.emit('get-channels');
    } catch (err) {
      alert('Import failed: ' + err.message);
    } finally {
      executeBtn.disabled = false;
      executeBtn.textContent = '📦 Import Selected';
    }
  }

  // ── Role Management ───────────────────────────────────
  // ═══════════════════════════════════════════════════════

  _initRoleManagement() {
    this._allRoles = [];
    this._selectedRoleId = null;

    // Open role editor modal
    document.getElementById('open-role-editor-btn')?.addEventListener('click', () => {
      this._openRoleModal();
    });
    document.getElementById('close-role-modal-btn')?.addEventListener('click', () => {
      document.getElementById('role-modal').style.display = 'none';
    });
    document.getElementById('create-role-btn')?.addEventListener('click', () => {
      const name = prompt('Enter role name:');
      if (!name || !name.trim()) return;
      const level = parseInt(prompt('Role level (1-99, higher = more authority):\nServer Mod default = 50, Channel Mod default = 25', '25'), 10);
      if (isNaN(level) || level < 1 || level > 99) { this._showToast('Level must be 1-99', 'error'); return; }
      this.socket.emit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast('Role created', 'success');
        this._loadRoles();
      });
    });

    // Assign role modal handlers
    document.getElementById('cancel-assign-role-btn')?.addEventListener('click', () => {
      document.getElementById('assign-role-modal').style.display = 'none';
    });
    document.getElementById('confirm-assign-role-btn')?.addEventListener('click', () => {
      const roleId = document.getElementById('assign-role-select').value;
      const userId = document.getElementById('assign-role-modal').dataset.userId;
      const scope = document.getElementById('assign-role-scope').value;
      if (!roleId || !userId) return;
      const channelId = scope !== 'server' ? parseInt(scope, 10) : null;
      this.socket.emit('assign-role', { userId: parseInt(userId, 10), roleId: parseInt(roleId, 10), channelId }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast('Role assigned', 'success');
        document.getElementById('assign-role-modal').style.display = 'none';
      });
    });

    // Listen for role updates
    this.socket.on('roles-updated', () => this._loadRoles());
  }

  _loadRoles(cb) {
    this.socket.emit('get-roles', {}, (res) => {
      if (res.error) return;
      this._allRoles = res.roles || [];
      this._renderRolesPreview();
      if (document.getElementById('role-modal').style.display !== 'none') {
        this._renderRoleSidebar();
      }
      if (typeof cb === 'function') cb();
    });
  }

  _renderRolesPreview() {
    const container = document.getElementById('roles-list-preview');
    if (!container) return;
    if (this._allRoles.length === 0) {
      container.innerHTML = '<p class="muted-text">No custom roles</p>';
      return;
    }
    container.innerHTML = this._allRoles.map(r =>
      `<div class="role-preview-item">
        <span class="role-color-dot" style="background:${r.color || '#aaa'}"></span>
        <span>${this._escapeHtml(r.name)}</span>
        <span class="muted-text" style="font-size:11px;margin-left:auto">Lv.${r.level}</span>
      </div>`
    ).join('');
  }

  _openRoleModal() {
    document.getElementById('role-modal').style.display = 'flex';
    this._loadRoles();
  }

  _renderRoleSidebar() {
    const list = document.getElementById('role-list-sidebar');
    if (!list) return;
    list.innerHTML = this._allRoles.map(r =>
      `<div class="role-sidebar-item${this._selectedRoleId === r.id ? ' active' : ''}" data-role-id="${r.id}">
        <span class="role-color-dot" style="background:${r.color || '#aaa'}"></span>
        ${this._escapeHtml(r.name)}
      </div>`
    ).join('');
    list.querySelectorAll('.role-sidebar-item').forEach(el => {
      el.addEventListener('click', () => {
        this._selectedRoleId = parseInt(el.dataset.roleId, 10);
        this._renderRoleSidebar();
        this._renderRoleDetail();
      });
    });
  }

  _renderRoleDetail() {
    const panel = document.getElementById('role-detail-panel');
    const role = this._allRoles.find(r => r.id === this._selectedRoleId);
    if (!role) { panel.innerHTML = '<p class="muted-text" style="padding:20px;text-align:center">Select a role</p>'; return; }

    const allPerms = [
      'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
      'pin_message', 'kick_user', 'mute_user', 'ban_user',
      'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
      'upload_files', 'use_voice', 'manage_webhooks', 'mention_everyone', 'view_history',
      'promote_user', 'transfer_admin'
    ];
    const permLabels = {
      edit_own_messages: 'Edit Own Messages', delete_own_messages: 'Delete Own Messages',
      delete_message: 'Delete Any Message', delete_lower_messages: 'Delete Lower-level Messages',
      pin_message: 'Pin Messages', kick_user: 'Kick Users', mute_user: 'Mute Users', ban_user: 'Ban Users',
      rename_channel: 'Rename Channels', rename_sub_channel: 'Rename Sub-channels',
      set_channel_topic: 'Set Channel Topic', manage_sub_channels: 'Manage Sub-channels',
      upload_files: 'Upload Files', use_voice: 'Use Voice Chat',
      manage_webhooks: 'Manage Webhooks', mention_everyone: 'Mention @everyone',
      view_history: 'View Message History',
      promote_user: 'Promote Users', transfer_admin: 'Transfer Admin'
    };
    const rolePerms = role.permissions || [];

    panel.innerHTML = `
      <div class="role-detail-form">
        <label class="settings-label">Name</label>
        <input type="text" class="settings-text-input" id="role-edit-name" value="${this._escapeHtml(role.name)}" maxlength="30">
        <label class="settings-label" style="margin-top:8px;">Level (1-99)</label>
        <input type="number" class="settings-number-input" id="role-edit-level" value="${role.level}" min="1" max="99">
        <label class="settings-label" style="margin-top:8px;">Color</label>
        <input type="color" id="role-edit-color" value="${role.color || '#aaaaaa'}" style="width:50px;height:30px;border:none;cursor:pointer">
        <h5 class="settings-section-subtitle" style="margin-top:12px;">Permissions</h5>
        ${allPerms.map(p => `
          <label class="toggle-row">
            <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
            <input type="checkbox" class="role-perm-checkbox" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}>
          </label>
        `).join('')}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn-sm btn-accent" id="save-role-btn">Save</button>
          <button class="btn-sm danger" id="delete-role-btn">Delete</button>
        </div>
      </div>
    `;

    document.getElementById('save-role-btn').addEventListener('click', () => {
      const perms = [...panel.querySelectorAll('.role-perm-checkbox:checked')].map(cb => cb.dataset.perm);
      this.socket.emit('update-role', {
        roleId: role.id,
        name: document.getElementById('role-edit-name').value.trim(),
        level: parseInt(document.getElementById('role-edit-level').value, 10),
        color: document.getElementById('role-edit-color').value,
        permissions: perms
      }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast('Role updated', 'success');
        this._loadRoles();
      });
    });

    document.getElementById('delete-role-btn').addEventListener('click', () => {
      if (!confirm(`Delete role "${role.name}"? Users with this role will lose it.`)) return;
      this.socket.emit('delete-role', { roleId: role.id }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast('Role deleted', 'success');
        this._selectedRoleId = null;
        this._loadRoles();
        this._renderRoleDetail();
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // ── Channel Roles Modal ───────────────────────────────
  // ═══════════════════════════════════════════════════════

  _openChannelRolesModal(channelCode) {
    this._channelRolesCode = channelCode;
    this._channelRolesSelectedUser = null;
    this._channelRolesMembers = [];
    this._channelRolesChannelId = null;
    this._channelRolesSelectedRole = null;

    const modal = document.getElementById('channel-roles-modal');
    const ch = this.channels.find(c => c.code === channelCode);
    document.getElementById('channel-roles-channel-name').textContent = ch ? `# ${ch.name}` : '';
    document.getElementById('channel-roles-member-list').innerHTML = '<p class="channel-roles-no-members">Loading…</p>';
    document.getElementById('channel-roles-actions').style.display = 'none';
    document.getElementById('channel-roles-role-detail').innerHTML =
      '<p class="muted-text" style="padding:12px;text-align:center;font-size:0.82rem">Select a role to configure</p>';
    modal.style.display = 'flex';

    // Fetch members + roles and all available roles in parallel
    this._loadRoles(() => {
      this._renderChannelRolesRoleList();
      this.socket.emit('get-channel-member-roles', { code: channelCode }, (res) => {
        if (res.error) {
          document.getElementById('channel-roles-member-list').innerHTML =
            `<p class="channel-roles-no-members">${this._escapeHtml(res.error)}</p>`;
          return;
        }
        this._channelRolesMembers = res.members || [];
        this._channelRolesChannelId = res.channelId;
        this._renderChannelRolesMembers();
        // Populate role dropdown
        const roleSel = document.getElementById('channel-roles-role-select');
        roleSel.innerHTML = '<option value="">-- Select Role --</option>' +
          this._allRoles.map(r =>
            `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
          ).join('');
      });
    });
  }

  _renderChannelRolesMembers() {
    const list = document.getElementById('channel-roles-member-list');
    if (!this._channelRolesMembers.length) {
      list.innerHTML = '<p class="channel-roles-no-members">No members in this channel</p>';
      return;
    }

    // Sort alphabetically by display name
    const sorted = [...this._channelRolesMembers].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    );

    list.innerHTML = sorted.map(m => {
      const sel = this._channelRolesSelectedUser === m.id ? ' selected' : '';
      const avatarSrc = m.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(m.loginName)}`;
      const shapeClass = m.avatarShape === 'square' ? ' square' : '';
      const badges = m.isAdmin
        ? '<span class="channel-roles-badge badge-admin"><span class="badge-dot" style="background:#e74c3c"></span>Admin</span>'
        : (m.roles || []).map(r =>
            `<span class="channel-roles-badge"><span class="badge-dot" style="background:${r.color || '#aaa'}"></span>${this._escapeHtml(r.name)}<span class="badge-scope">${r.scope === 'channel' ? '📌 Channel' : '🌐 Server'}</span><span class="revoke-btn" data-uid="${m.id}" data-rid="${r.roleId}" data-scope="${r.scope}" title="Revoke">✕</span></span>`
          ).join('') || '<span class="channel-roles-no-role">No roles</span>';

      return `<div class="channel-roles-member${sel}" data-uid="${m.id}">
        <img class="channel-roles-member-avatar${shapeClass}" src="${avatarSrc}" alt="">
        <div class="channel-roles-member-info">
          <span class="channel-roles-member-name">${this._escapeHtml(m.displayName)}</span>
          <span class="channel-roles-member-login">@${this._escapeHtml(m.loginName)}</span>
          <div class="channel-roles-member-badges">${badges}</div>
        </div>
      </div>`;
    }).join('');

    // Member click → select
    list.querySelectorAll('.channel-roles-member').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.revoke-btn')) return; // handled below
        const uid = parseInt(el.dataset.uid);
        this._channelRolesSelectedUser = uid;
        this._renderChannelRolesMembers();
        this._showChannelRolesActions(uid);
      });
    });

    // Revoke button clicks
    list.querySelectorAll('.revoke-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uid = parseInt(btn.dataset.uid);
        const rid = parseInt(btn.dataset.rid);
        const scope = btn.dataset.scope;
        const channelId = scope === 'channel' ? this._channelRolesChannelId : null;
        this.socket.emit('revoke-role', { userId: uid, roleId: rid, channelId });
        this._showToast('Role revoked', 'success');
        // Refresh after a short delay
        setTimeout(() => this._refreshChannelRoles(), 400);
      });
    });
  }

  _showChannelRolesActions(userId) {
    const panel = document.getElementById('channel-roles-actions');
    const member = this._channelRolesMembers.find(m => m.id === userId);
    if (!member) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    document.getElementById('channel-roles-selected-name').textContent = member.displayName;

    const currentDiv = document.getElementById('channel-roles-current-roles');

    // Admins cannot modify their own roles
    if (member.isAdmin && member.id === this.user.id) {
      currentDiv.innerHTML = '<span class="channel-roles-badge" style="background:rgba(231,76,60,0.2);color:#e74c3c"><span class="badge-dot" style="background:#e74c3c"></span>Admin</span>';
      const assignArea = panel.querySelector('.channel-roles-assign-area');
      if (assignArea) assignArea.style.display = 'none';
      return;
    }
    // Show assign area for non-self-admin targets
    const assignArea = panel.querySelector('.channel-roles-assign-area');
    if (assignArea) assignArea.style.display = '';

    if (member.isAdmin) {
      currentDiv.innerHTML = '<span class="channel-roles-badge badge-admin"><span class="badge-dot" style="background:#e74c3c"></span>Admin</span>';
    } else if (member.roles.length) {
      currentDiv.innerHTML = member.roles.map(r =>
        `<span class="channel-roles-badge"><span class="badge-dot" style="background:${r.color || '#aaa'}"></span>${this._escapeHtml(r.name)} <span class="badge-scope">${r.scope === 'channel' ? '📌 Channel' : '🌐 Server'}</span></span>`
      ).join('');
    } else {
      currentDiv.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">No roles assigned</span>';
    }
  }

  _assignChannelRole() {
    const userId = this._channelRolesSelectedUser;
    if (!userId) return this._showToast('Select a member first', 'error');

    const roleId = parseInt(document.getElementById('channel-roles-role-select').value);
    if (!roleId) return this._showToast('Select a role', 'error');

    const scopeVal = document.getElementById('channel-roles-scope-select').value;
    const channelId = scopeVal === 'channel' ? this._channelRolesChannelId : null;

    this.socket.emit('assign-role', { userId, roleId, channelId }, (res) => {
      if (res.error) return this._showToast(res.error, 'error');
      this._showToast('Role assigned', 'success');
      // Reset selection
      document.getElementById('channel-roles-role-select').value = '';
      // Refresh member list
      setTimeout(() => this._refreshChannelRoles(), 400);
    });
  }

  _refreshChannelRoles() {
    if (!this._channelRolesCode) return;
    this.socket.emit('get-channel-member-roles', { code: this._channelRolesCode }, (res) => {
      if (res.error) return;
      this._channelRolesMembers = res.members || [];
      this._renderChannelRolesMembers();
      // Re-select user if still valid
      if (this._channelRolesSelectedUser) {
        this._showChannelRolesActions(this._channelRolesSelectedUser);
      }
    });
  }

  /* ── Channel Roles: Role configuration panel ────────── */

  _renderChannelRolesRoleList() {
    const list = document.getElementById('channel-roles-role-list');
    if (!list) return;
    if (!this._allRoles.length) {
      list.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);text-align:center;padding:8px">No roles yet</p>';
      return;
    }
    list.innerHTML = this._allRoles.map(r =>
      `<div class="channel-roles-role-item${this._channelRolesSelectedRole === r.id ? ' active' : ''}" data-role-id="${r.id}">
        <span class="role-color-dot" style="background:${r.color || '#aaa'}"></span>
        <span class="channel-roles-role-name">${this._escapeHtml(r.name)}</span>
        <span class="channel-roles-role-level">Lv.${r.level}</span>
      </div>`
    ).join('');
    list.querySelectorAll('.channel-roles-role-item').forEach(el => {
      el.addEventListener('click', () => {
        this._channelRolesSelectedRole = parseInt(el.dataset.roleId, 10);
        this._renderChannelRolesRoleList();
        this._renderChannelRolesRoleDetail();
      });
    });
  }

  _renderChannelRolesRoleDetail() {
    const panel = document.getElementById('channel-roles-role-detail');
    const role = this._allRoles.find(r => r.id === this._channelRolesSelectedRole);
    if (!role) {
      panel.innerHTML = '<p class="muted-text" style="padding:12px;text-align:center;font-size:0.82rem">Select a role to configure</p>';
      return;
    }

    const allPerms = [
      'edit_own_messages', 'delete_own_messages', 'delete_message', 'delete_lower_messages',
      'pin_message', 'kick_user', 'mute_user', 'ban_user',
      'rename_channel', 'rename_sub_channel', 'set_channel_topic', 'manage_sub_channels',
      'upload_files', 'use_voice', 'manage_webhooks', 'mention_everyone', 'view_history',
      'promote_user', 'transfer_admin'
    ];
    const permLabels = {
      edit_own_messages: 'Edit Own Messages', delete_own_messages: 'Delete Own Messages',
      delete_message: 'Delete Any Message', delete_lower_messages: 'Delete Lower-level Messages',
      pin_message: 'Pin Messages', kick_user: 'Kick Users', mute_user: 'Mute Users', ban_user: 'Ban Users',
      rename_channel: 'Rename Channels', rename_sub_channel: 'Rename Sub-channels',
      set_channel_topic: 'Set Channel Topic', manage_sub_channels: 'Manage Sub-channels',
      upload_files: 'Upload Files', use_voice: 'Use Voice Chat',
      manage_webhooks: 'Manage Webhooks', mention_everyone: 'Mention @everyone',
      view_history: 'View Message History',
      promote_user: 'Promote Users', transfer_admin: 'Transfer Admin'
    };
    const rolePerms = role.permissions || [];

    panel.innerHTML = `
      <div class="cr-role-form">
        <div class="cr-role-form-row">
          <label class="cr-role-label">Name</label>
          <input type="text" class="settings-text-input" id="cr-role-name" value="${this._escapeHtml(role.name)}" maxlength="30">
        </div>
        <div class="cr-role-form-row cr-role-inline">
          <div>
            <label class="cr-role-label">Level (1-99)</label>
            <input type="number" class="settings-number-input" id="cr-role-level" value="${role.level}" min="1" max="99" style="width:60px">
          </div>
          <div>
            <label class="cr-role-label">Color</label>
            <input type="color" id="cr-role-color" value="${role.color || '#aaaaaa'}" style="width:36px;height:28px;border:none;cursor:pointer;background:none">
          </div>
        </div>
        <label class="cr-role-label" style="margin-top:4px">Permissions</label>
        <div class="cr-role-perms">
          ${allPerms.map(p => `
            <label class="cr-perm-toggle">
              <input type="checkbox" class="cr-perm-cb" data-perm="${p}" ${rolePerms.includes(p) ? 'checked' : ''}>
              <span>${permLabels[p] || p.replace(/_/g, ' ')}</span>
            </label>
          `).join('')}
        </div>
        <div class="cr-role-btns">
          <button class="btn-sm btn-accent" id="cr-save-role-btn">Save</button>
          <button class="btn-sm danger" id="cr-delete-role-btn">Delete</button>
        </div>
      </div>
    `;

    document.getElementById('cr-save-role-btn').addEventListener('click', () => {
      const perms = [...panel.querySelectorAll('.cr-perm-cb:checked')].map(cb => cb.dataset.perm);
      const newLevel = parseInt(document.getElementById('cr-role-level').value, 10);
      if (isNaN(newLevel) || newLevel < 1 || newLevel > 99) { this._showToast('Level must be 1–99', 'error'); return; }
      this.socket.emit('update-role', {
        roleId: role.id,
        name: document.getElementById('cr-role-name').value.trim(),
        level: newLevel,
        color: document.getElementById('cr-role-color').value,
        permissions: perms
      }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast('Role updated', 'success');
        this._loadRoles(() => {
          this._renderChannelRolesRoleList();
          this._renderChannelRolesRoleDetail();
          this._refreshChannelRolesDropdown();
          this._refreshChannelRoles();
        });
      });
    });

    document.getElementById('cr-delete-role-btn').addEventListener('click', () => {
      if (!confirm(`Delete role "${role.name}"? Users with this role will lose it.`)) return;
      this.socket.emit('delete-role', { roleId: role.id }, (res) => {
        if (res.error) { this._showToast(res.error, 'error'); return; }
        this._showToast('Role deleted', 'success');
        this._channelRolesSelectedRole = null;
        this._loadRoles(() => {
          this._renderChannelRolesRoleList();
          this._renderChannelRolesRoleDetail();
          this._refreshChannelRolesDropdown();
          this._refreshChannelRoles();
        });
      });
    });
  }

  _createChannelRole() {
    const name = prompt('Enter role name:');
    if (!name || !name.trim()) return;
    const level = parseInt(prompt('Role level (1-99, higher = more authority):\nServer Mod default = 50, Channel Mod default = 25', '25'), 10);
    if (isNaN(level) || level < 1 || level > 99) { this._showToast('Level must be 1–99', 'error'); return; }
    this.socket.emit('create-role', { name: name.trim(), level, color: '#aaaaaa' }, (res) => {
      if (res.error) { this._showToast(res.error, 'error'); return; }
      this._showToast('Role created', 'success');
      this._loadRoles(() => {
        this._renderChannelRolesRoleList();
        this._refreshChannelRolesDropdown();
      });
    });
  }

  _refreshChannelRolesDropdown() {
    const roleSel = document.getElementById('channel-roles-role-select');
    if (!roleSel) return;
    roleSel.innerHTML = '<option value="">-- Select Role --</option>' +
      this._allRoles.map(r =>
        `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
      ).join('');
  }

  _openAssignRoleModal(userId, username) {
    const modal = document.getElementById('assign-role-modal');
    modal.dataset.userId = userId;
    document.getElementById('assign-role-user-label').textContent = `Assigning role to: ${username}`;

    // Populate role select with color-coded level info
    const sel = document.getElementById('assign-role-select');
    sel.innerHTML = '<option value="">-- Select Role --</option>' + this._allRoles.map(r =>
      `<option value="${r.id}">● ${this._escapeHtml(r.name)} — Lv.${r.level}</option>`
    ).join('');

    // Populate scope with structured parent → sub-channel grouping
    const scopeSel = document.getElementById('assign-role-scope');
    const nonDm = this.channels.filter(c => !c.is_dm);
    const parents = nonDm.filter(c => !c.parent_channel_id);
    const subMap = {};
    nonDm.filter(c => c.parent_channel_id).forEach(c => {
      if (!subMap[c.parent_channel_id]) subMap[c.parent_channel_id] = [];
      subMap[c.parent_channel_id].push(c);
    });

    let scopeHtml = '<option value="server">🌐 Server-wide</option>';
    parents.forEach(p => {
      scopeHtml += `<option value="${p.id}"># ${this._escapeHtml(p.name)}</option>`;
      const subs = subMap[p.id] || [];
      subs.forEach(s => {
        scopeHtml += `<option value="${s.id}">&nbsp;&nbsp;└ ${this._escapeHtml(s.name)}</option>`;
      });
    });
    scopeSel.innerHTML = scopeHtml;
    modal.style.display = 'flex';
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

  // ── Update Checker ─────────────────────────────────────
  async _checkForUpdates() {
    try {
      // Get local version from the server
      const localRes = await fetch('/api/version');
      if (!localRes.ok) return;
      const { version: localVersion } = await localRes.json();

      // Check GitHub for latest release
      const ghRes = await fetch('https://api.github.com/repos/ancsemi/Haven/releases/latest', {
        headers: { Accept: 'application/vnd.github.v3+json' }
      });
      if (!ghRes.ok) return;
      const release = await ghRes.json();

      const remoteVersion = (release.tag_name || '').replace(/^v/, '');
      if (!remoteVersion || !localVersion) return;

      if (this._isNewerVersion(remoteVersion, localVersion)) {
        const banner = document.getElementById('update-banner');
        if (banner) {
          banner.style.display = 'inline-flex';
          banner.querySelector('.update-text').textContent = `Update v${remoteVersion}`;
          banner.title = `Haven v${remoteVersion} is available (you have v${localVersion}). Click to view.`;
          // Link to release page (or zip download if available)
          const zipAsset = (release.assets || []).find(a => a.name && a.name.endsWith('.zip'));
          banner.href = zipAsset ? zipAsset.browser_download_url : release.html_url;
        }
      }
    } catch (e) {
      // Silently fail — update check is non-critical
    }

    // Re-check every 30 minutes
    setTimeout(() => this._checkForUpdates(), 30 * 60 * 1000);
  }

  /**
   * Compare semver strings. Returns true if remote > local.
   */
  _isNewerVersion(remote, local) {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const rv = r[i] || 0;
      const lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }

  /* ── E2E Encryption Helpers ──────────────────────────── */

  async _initE2E() {
    if (typeof HavenE2E === 'undefined') return;
    try {
      this.e2e = new HavenE2E();
      // e2eSecret is always available: comes from server in session-info → stored in this.user
      const e2eSecret = this.user.e2eSecret || null;
      // Password fallback for migrating old password-wrapped keys (only on form login)
      const pw = sessionStorage.getItem('haven_e2e_pw');
      const ok = await this.e2e.init(this.socket, e2eSecret, pw || null);
      // Clear password immediately — only needed for one-time migration
      sessionStorage.removeItem('haven_e2e_pw');
      if (ok) {
        this._e2eSetupListeners();
      } else if (this.e2e.needsPassword) {
        // Only happens if e2eSecret is missing AND no password — edge case
        this._showE2EPasswordRecovery();
      }
    } catch (err) {
      console.warn('[E2E] Init failed:', err);
      this.e2e = null;
      sessionStorage.removeItem('haven_e2e_pw');
    }
  }

  /** Set up E2E listeners and publish key after successful init */
  _e2eSetupListeners() {
    // Publish our public key to the server
    const publishData = { jwk: this.e2e.publicKeyJwk };
    // Check both app-level flag and e2e-level flag (set by resetKeys auto-reset)
    if (this._e2eForcePublish || (this.e2e && this.e2e._forcePublish)) {
      publishData.force = true;
      this._e2eForcePublish = false;
      if (this.e2e) this.e2e._forcePublish = false;
    }
    this.socket.emit('publish-public-key', publishData);
    // Listen for public key responses (only attach once)
    if (!this._e2eListenersAttached) {
      this._e2eListenersAttached = true;
      this.socket.on('public-key-result', (data) => {
        if (data.jwk) {
          const oldKey = this._dmPublicKeys[data.userId];
          const keyChanged = oldKey && (oldKey.x !== data.jwk.x || oldKey.y !== data.jwk.y);
          this._dmPublicKeys[data.userId] = data.jwk;
          if (keyChanged) {
            // Partner's key changed — invalidate the cached shared secret
            // so ECDH re-derives with the new public key
            this.e2e._sharedKeys = Object.fromEntries(
              Object.entries(this.e2e._sharedKeys).filter(([k]) => !k.startsWith(data.userId + ':'))
            );
            console.warn(`[E2E] Partner ${data.userId} key changed — shared secret invalidated`);
          }
          // Key arrived or updated — if we're viewing a DM with this user,
          // re-fetch messages so they decrypt with the current key.
          this._retryDecryptForUser(data.userId);
        }
      });
      // Handle public key conflict — our IndexedDB key doesn't match server's
      // Force-publish since we actually have the private key (server's is stale)
      this.socket.on('public-key-conflict', () => {
        console.warn('[E2E] Public key conflict — force-publishing our key');
        this.socket.emit('publish-public-key', { jwk: this.e2e.publicKeyJwk, force: true });
      });
    }
    console.log('[E2E] Initialized, public key published');
  }

  /** Show a banner prompting the user to re-enter their password to unlock E2E */
  _showE2EPasswordRecovery() {
    const existing = document.getElementById('e2e-recovery-banner');
    if (existing) existing.remove();

    const isLost = this.e2e && this.e2e.keyBackupLost;
    const message = isLost
      ? '🔒 Encryption backup was lost. Enter your password to generate new keys (old encrypted messages will be unreadable).'
      : '🔒 Enter your password to unlock end-to-end encryption';
    const buttonText = isLost ? 'Reset Keys' : 'Unlock';

    const banner = document.createElement('div');
    banner.id = 'e2e-recovery-banner';
    banner.innerHTML = `
      <div class="e2e-recovery-inner">
        <span>${message}</span>
        <input type="password" id="e2e-recovery-pw" placeholder="Password" autocomplete="current-password">
        <button class="btn-sm btn-accent" id="e2e-recovery-btn">${buttonText}</button>
        <button class="btn-sm" id="e2e-recovery-dismiss">✕</button>
      </div>
    `;
    const chatArea = document.getElementById('messages');
    if (chatArea && chatArea.parentElement) {
      chatArea.parentElement.insertBefore(banner, chatArea);
    }
    banner.querySelector('#e2e-recovery-btn').addEventListener('click', async () => {
      const pw = banner.querySelector('#e2e-recovery-pw').value;
      if (!pw) return;
      const btn = banner.querySelector('#e2e-recovery-btn');
      btn.textContent = isLost ? 'Resetting…' : 'Unlocking…';
      btn.disabled = true;
      const e2eSecret = this.user.e2eSecret || null;
      const ok = await this.e2e.recoverWithPassword(this.socket, pw, e2eSecret);
      if (ok) {
        banner.remove();
        // If keys were reset, force-publish the new public key
        if (this.e2e._forcePublish) {
          this._e2eForcePublish = true;
          this.e2e._forcePublish = false;
        }
        this._e2eSetupListeners();
        this._showToast(isLost ? 'Encryption keys reset ✓' : 'Encryption keys recovered ✓', 'success');
        // Re-fetch current DM messages to decrypt them
        if (this.currentChannel) {
          this._oldestMsgId = null;
          this._noMoreHistory = false;
          this._loadingHistory = false;
          this._historyBefore = null;
          this.socket.emit('get-messages', { code: this.currentChannel });
        }
      } else {
        btn.textContent = buttonText;
        btn.disabled = false;
        this._showToast('Wrong password — try again', 'error');
      }
    });
    banner.querySelector('#e2e-recovery-pw').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') banner.querySelector('#e2e-recovery-btn').click();
    });
    banner.querySelector('#e2e-recovery-dismiss').addEventListener('click', () => {
      banner.remove();
    });
  }

  /**
   * Get the E2E partner user ID for the current channel (if it's a DM).
   * Returns { userId, publicKeyJwk } or null.
   */
  _getE2EPartner() {
    if (!this.e2e || !this.e2e.ready) return null;
    const ch = this.channels.find(c => c.code === this.currentChannel);
    if (!ch || !ch.is_dm || !ch.dm_target) return null;
    const partnerId = ch.dm_target.id;
    const jwk = this._dmPublicKeys[partnerId];
    return jwk ? { userId: partnerId, publicKeyJwk: jwk } : null;
  }

  /**
   * Re-decrypt visible messages when a DM partner's public key arrives late.
   * Called from the public-key-result handler to fix the key/messages race.
   */
  _retryDecryptForUser(userId) {
    const ch = this.channels.find(c => c.code === this.currentChannel);
    if (!ch || !ch.is_dm || !ch.dm_target) return;
    if (ch.dm_target.id !== userId) return;
    // Re-fetch messages — key is now cached so _decryptMessages will succeed
    this._oldestMsgId = null;
    this._noMoreHistory = false;
    this._loadingHistory = false;
    this._historyBefore = null;
    this.socket.emit('get-messages', { code: this.currentChannel });
  }

  /**
   * Fetch the DM partner's public key when entering a DM channel.
   * Always re-fetches from the server to detect key changes (e.g. partner
   * cleared browser data or switched devices, causing key regeneration).
   */
  _fetchDMPartnerKey(channel) {
    if (!this.e2e || !this.e2e.ready) return;
    if (!channel || !channel.is_dm || !channel.dm_target) return;
    const partnerId = channel.dm_target.id;
    this.socket.emit('get-public-key', { userId: partnerId });
  }

  /**
   * Show E2E verification code modal for the current DM.
   * Both users see the same code — they can compare out-of-band.
   */
  async _showE2EVerification() {
    const partner = this._getE2EPartner();
    if (!partner || !this.e2e?.ready) {
      this._showToast('E2E not available for this conversation', 'error');
      return;
    }
    try {
      const code = await this.e2e.getVerificationCode(this.e2e.publicKeyJwk, partner.publicKeyJwk);
      const ch = this.channels.find(c => c.code === this.currentChannel);
      const partnerName = ch?.dm_target?.username || 'Partner';

      // Create a simple modal overlay
      let overlay = document.getElementById('e2e-verify-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'e2e-verify-overlay';
        overlay.className = 'modal-overlay';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) overlay.style.display = 'none';
        });
      }
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px;text-align:center">
          <h3 style="margin-bottom:8px">🔐 Verify Encryption</h3>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
            Compare this safety number with <strong>${this._escapeHtml(partnerName)}</strong> using another channel (in person, phone call, text, etc.). If they match, your conversation is end-to-end encrypted and no one is intercepting.
          </p>
          <div class="e2e-safety-number" style="font-family:monospace;font-size:18px;letter-spacing:2px;line-height:2;padding:16px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--border);user-select:all;word-break:break-all">${code}</div>
          <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
            <button class="btn-sm btn-accent" id="e2e-copy-code-btn">Copy Code</button>
            <button class="btn-sm" id="e2e-close-verify-btn">Close</button>
          </div>
        </div>
      `;
      // Attach listeners via JS (inline onclick is blocked by CSP)
      overlay.querySelector('#e2e-copy-code-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(code);
        overlay.querySelector('#e2e-copy-code-btn').textContent = 'Copied!';
      });
      overlay.querySelector('#e2e-close-verify-btn').addEventListener('click', () => {
        overlay.style.display = 'none';
      });
      overlay.style.display = 'flex';
    } catch (err) {
      this._showToast('Could not generate verification code', 'error');
      console.error('[E2E] Verification error:', err);
    }
  }

  /**
   * Decrypt any E2E-encrypted messages in an array (mutates in place).
   * For messages the current user sent, uses the partner's public key.
   * For messages the partner sent, also uses the partner's public key.
   * Both sides derive the same shared secret (ECDH is symmetric).
   */
  async _decryptMessages(messages) {
    if (!this.e2e || !this.e2e.ready || !messages || !messages.length) return;
    const ch = this.channels.find(c => c.code === this.currentChannel);
    if (!ch || !ch.is_dm || !ch.dm_target) return;

    const partnerId = ch.dm_target.id;
    const partnerJwk = this._dmPublicKeys[partnerId];

    for (const msg of messages) {
      if (HavenE2E.isEncrypted(msg.content)) {
        if (!partnerJwk) {
          // Key not yet available — show placeholder (will retry when key arrives)
          msg.content = '[Encrypted message — waiting for key...]';
          msg._e2e = true;
          continue;
        }
        const plain = await this.e2e.decrypt(msg.content, partnerId, partnerJwk);
        if (plain !== null) {
          msg.content = plain;
          msg._e2e = true; // flag for UI indicator
        } else {
          msg.content = '[Encrypted message — unable to decrypt]';
          msg._e2e = true;
        }
      }
    }
  }
}

// ── Boot ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => new HavenApp());
