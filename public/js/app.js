// ═══════════════════════════════════════════════════════════
// Haven — Main Client Application
// Features: chat, voice, themes, images, multi-server,
//           notifications, volume sliders, status bar
// ═══════════════════════════════════════════════════════════

import SocketMethods   from './modules/app-socket.js?v=2.7.9';
import UIBindMethods   from './modules/app-ui.js?v=2.7.0';
import MediaMethods    from './modules/app-media.js?v=2.7.0';
import ContextMethods  from './modules/app-context.js?v=2.7.2';
import ChannelMethods  from './modules/app-channels.js?v=2.7.8';
import MessageMethods  from './modules/app-messages.js?v=2.7.10';
import UserMethods     from './modules/app-users.js?v=2.7.0';
import VoiceMethods    from './modules/app-voice.js?v=2.7.10';
import UtilityMethods  from './modules/app-utilities.js?v=2.7.9';
import AdminMethods    from './modules/app-admin.js?v=2.7.0';
import PlatformMethods from './modules/app-platform.js?v=2.7.8';

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
    this.voiceChannelUsers = {};   // { channelCode: [{id, username}] } for sidebar voice user lists
    this.e2e = null;               // HavenE2E instance for DM encryption
    this._dmPublicKeys = {};       // { userId → jwk } cache for DM partner public keys
    this._e2eListenersAttached = false;
    this._e2eInitDone = false;
    this._e2eWrappingKey = null;   // wrapping key kept in memory for cross-device sync
    this._pendingKeyReqs = {};     // userId → [resolve] for promise-based partner key fetch
    this._pendingE2ENotice = null; // E2E notice text to re-append after message re-render
    this._oldestMsgId = null;      // oldest message ID in current view (for pagination)
    this._noMoreHistory = false;   // true when all history has been loaded
    this._loadingHistory = false;  // prevent concurrent history requests
    this._historyBefore = null;    // set when requesting older messages
    this._nicknames = JSON.parse(localStorage.getItem('haven_nicknames') || '{}'); // client-side nicknames { oderId: name }

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
      { cmd: 'tts:stop',   args: '',         desc: 'Stop all TTS playback' },
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
      'Symbols':  ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💝','✨','⭐','🌟','💫','🔥','💯','✅','❌','❗','❓','❕','❔','‼️','⁉️','💤','🚫','⚠️','♻️','🏳️','🏴','🎵','➕','➖','➗','💲','♾️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔺','🔻','💠','🔘','🏳️‍🌈','🏴‍☠️','⚡','☀️','🌙','🌈','☁️','❄️','💨','🌪️','☮️','✝️','☪️','🕉️','☯️','✡️','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🆔','⚛️','🈶','🈚','🈸','🈺','🈷️','🆚','🉐','🈹','🈲','🉑','🈴','🈳','㊗️','㊙️','🈵','🔅','🔆','🔱','📛','♻️','🔰','⭕','✳️','❇️','🔟','🔠','🔡','🔢','🔣','🔤','🆎','🆑','🆒','🆓','ℹ️','🆕','🆖','🅾️','🆗','🅿️','🆘','🆙','🆚','🈁','🈂️','💱','💲','#️⃣','*️⃣','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','©️','®️','™️']
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
      '❤️':'red heart love','🧡':'orange heart','💛':'yellow heart','💚':'green heart','💙':'blue heart','💜':'purple heart','🖤':'black heart','🤍':'white heart','💔':'broken heart','✨':'sparkles stars','⭐':'star','🔥':'fire hot lit','💯':'hundred perfect','✅':'check mark yes','❌':'cross mark no wrong','❗':'exclamation mark bang','❓':'question mark','❕':'white exclamation','❔':'white question','‼️':'double exclamation bangbang','⁉️':'exclamation question interrobang','💤':'sleep zzz','⚠️':'warning caution','⚡':'lightning bolt zap','☀️':'sun sunny','🌙':'moon crescent night','❄️':'snowflake cold winter','🌪️':'tornado','🔴':'red circle','🔵':'blue circle','🟢':'green circle','🟡':'yellow circle','🟠':'orange circle','🟣':'purple circle','⚫':'black circle','⚪':'white circle','©️':'copyright','®️':'registered','™️':'trademark','#️⃣':'hash number sign','*️⃣':'asterisk star keycap',
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
    this.socket = io({
      auth: { token: this.token },
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.4,
    });
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
    this._setupMobileSidebarServers();
    this._setupCollapsibleSections();
    this._setupIOSKeyboard();
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
    this._setupFontSizePicker();
    this._setupEmojiSizePicker();
    this._setupImageModePicker();
    this._setupLightbox();
    this._setupOnlineOverlay();
    this._setupModalExpand();
    this._checkForUpdates();
    this._initDesktopAppBanner();
    this._initAndroidBetaBanner();
    this._initMoveMessages();

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

    // ── Auto-start performance diagnostics after startup settles ──
    setTimeout(() => this._startPerfDiagnostics(), 30000);

    // E2E init is deferred to 'session-info' handler to ensure
    // the socket is fully connected and server-side handlers are registered.

    document.getElementById('current-user').textContent = this.user.displayName || this.user.username;
    const loginEl = document.getElementById('login-name');
    if (loginEl) loginEl.textContent = `@${this.user.username}`;

    if (this.user.isAdmin || this._hasPerm('create_channel')) {
      document.getElementById('admin-controls').style.display = 'block';
    }
    if (this.user.isAdmin || this._hasPerm('manage_roles') || this._hasPerm('manage_server')) {
      document.getElementById('admin-mod-panel').style.display = 'block';
    }
    if (this.user.isAdmin) {
      const organizeBtn = document.getElementById('organize-channels-btn');
      if (organizeBtn) organizeBtn.style.display = '';
    }

    document.getElementById('mod-mode-settings-toggle')?.addEventListener('click', () => this.modMode?.toggle());
  }

}

// ── Merge all method groups onto the prototype ────────────
Object.assign(HavenApp.prototype,
  SocketMethods,
  UIBindMethods,
  MediaMethods,
  ContextMethods,
  ChannelMethods,
  MessageMethods,
  UserMethods,
  VoiceMethods,
  UtilityMethods,
  AdminMethods,
  PlatformMethods,
);

// ── Boot ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.i18n?.init();
  window.app = new HavenApp();
});