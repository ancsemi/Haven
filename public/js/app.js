// ═══════════════════════════════════════════════════════════
// Haven — Main Client Application
// Features: chat, voice, themes, images, multi-server,
//           notifications, volume sliders, status bar
// ═══════════════════════════════════════════════════════════

import SocketMethods   from './modules/app-socket.js?v=3.17.1';
import UIBindMethods   from './modules/app-ui.js?v=3.16.12';
import MediaMethods    from './modules/app-media.js?v=3.16.12';
import ContextMethods  from './modules/app-context.js?v=3.16.12';
import ChannelMethods  from './modules/app-channels.js?v=3.16.12';
import MessageMethods  from './modules/app-messages.js?v=3.16.12';
import UserMethods     from './modules/app-users.js?v=3.25.3';
import VoiceMethods    from './modules/app-voice.js?v=3.25.3';
import UtilityMethods  from './modules/app-utilities.js?v=3.30.1';
import AdminMethods    from './modules/app-admin.js?v=3.30.1';
import PlatformMethods from './modules/app-platform.js?v=3.16.12';

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
    // Per-channel thread @mention list, persisted to localStorage
    try { this._threadMentions = JSON.parse(localStorage.getItem('haven_thread_mentions') || '{}'); }
    catch { this._threadMentions = {}; }
    this.onlineCount = 0;
    this.pingInterval = null;
    this.serverManager = new ServerManager();
    this.notifications = new NotificationManager();
    this.replyingTo = null;        // message object being replied to
    this._threadReplyingTo = null; // thread message being replied to
    this._activeThreadParent = null; // currently open thread parent message ID
    this._lastMoveSelectedEl = null; // last clicked message in move-selection mode
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
      { cmd: 'break',      args: '<message>', desc: 'Force a new message group (no compacting with previous)' },
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
      { cmd: 'poll',       args: '[question]',       desc: 'Open the poll creator' },
    ];

    // Load bot-registered slash commands for autocomplete
    this._loadBotCommands();

    // Emoji palette organized by category
    this.emojiCategories = {
      'Smileys':  ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🙂','🤗','🤩','🤔','😐','🙄','😏','😣','😥','😮','😯','😴','😛','😜','😝','😒','😔','🙃','😲','😤','😭','😢','😱','🥺','😠','😡','🤬','😈','💀','💩','🤡','👻','😺','😸','🫠','🫣','🫢','🫥','🫤','🥹','🥲','😶‍🌫️','🤭','🫡','🤫','🤥','😬','🫨','😵','😵‍💫','🥴','😮‍💨','😤','🥱','😇','🤠','🤑','🤓','😈','👿','🫶','🤧','😷','🤒','🤕','💅'],
      'People':   ['👋','🤚','✋','🖖','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🤝','🙏','💪','🫡','🫶','💅','💃','🕺','🤳','🖕','🫰','🫳','🫴','👐','🤲','🫱','🫲','🤷','🤦','🙇','💁','🙆','🙅','🤷‍♂️','🤷‍♀️','🙋','🙋‍♂️','🙋‍♀️','🧏','🧑‍🤝‍🧑','👫','👬','👭'],
      'Monkeys':  ['🙈','🙉','🙊','🐵','🐒','🦍','🦧'],
      'Animals':  ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐔','🐧','🐦','🦆','🦅','🦉','🐺','🐴','🦄','🐝','🦋','🐌','🐞','🐢','🐍','🐙','🐬','🐳','🦈','🐊','🦖','🦕','🐋','🦭','🦦','🦫','🦥','🐿️','🦔','🦇','🐓','🦃','🦚','🦜','🦢','🦩','🐕','🐈','🐈‍⬛'],
      'Faces':    ['👀','👁️','👁️‍🗨️','👅','👄','🫦','💋','🧠','🦷','🦴','👃','👂','🦻','🦶','🦵','💀','☠️','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'],
      'Food':     ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🌶️','🫑','🥦','🧄','🧅','🥕','🍕','🍔','🍟','🌭','🍿','🧁','🍩','🍪','🍰','🎂','🧀','🥚','🥓','🥩','🍗','🌮','🌯','🫔','🥙','🍜','🍝','🍣','🍱','☕','🍺','🍻','🍷','🥤','🧊','🧋','🍵','🥂','🍾','🥃','🍶','🫗','🍸','🍹'],
      'Activities':['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🎮','🕹️','🎲','🧩','🎯','🎳','🎭','🎨','🎼','🎵','🎶','🎸','🥁','🎹','🏆','🥇','🏅','🎪','🎬','🎤','🎧','🎺','🪘','🎻','🪗','🎉','🎊','🎈','🎀','🎗️','🏋️','🤸','🧗','🏄','🏊','🚴','⛷️','🏂','🤺'],
      'Travel':   ['🚗','🚕','🚀','✈️','🚁','🛸','🚢','🏠','🏢','🏰','🗼','🗽','⛩️','🌋','🏔️','🌊','🌅','🌄','🌉','🎡','🎢','🗺️','🧭','🏖️','🏕️','🌍','🌎','🌏','🛳️','⛵','🚂','🚇','🏎️','🏍️','🛵','🛶'],
      'Objects':  ['⌚','📱','💻','⌨️','🖥️','💾','📷','🔭','🔬','💡','🔦','📚','📝','✏️','📎','📌','🔑','🔒','🔓','🛡️','⚔️','🔧','💰','💎','📦','🎁','✉️','🔔','🪙','💸','🏷️','🔨','🪛','🧲','🧪','🧫','💊','🩺','🩹','🧬','💬','💭','🗨️','🗯️','📣','📢','🔊','🔇','📰','🗞️','📋','📁','📂','🗂️','📅','📆','🗓️','🖊️','🖋️','✒️','📏','📐','🗑️','👑','💍','👒','🎩','🧢','👓','🕶️','🧳','🌂','☂️'],
      'Symbols':  ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💝','✨','⭐','🌟','💫','🔥','💯','✅','❌','❗','❓','❕','❔','‼️','⁉️','!','?',',','.','💤','🚫','⚠️','♻️','🏳️','🏴','🎵','➕','➖','➗','💲','♾️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔺','🔻','💠','🔘','🏳️‍🌈','🏴‍☠️','⚡','☀️','🌙','🌈','☁️','❄️','💨','🌪️','☮️','✝️','☪️','🕉️','☯️','✡️','🔯','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🆔','⚛️','🈶','🈚','🈸','🈺','🈷️','🆚','🉐','🈹','🈲','🉑','🈴','🈳','㊗️','㊙️','🈵','🔅','🔆','🔱','📛','♻️','🔰','⭕','✳️','❇️','🔟','🔠','🔡','🔢','🔣','🔤','🆎','🆑','🆒','🆓','ℹ️','🆕','🆖','🅾️','🆗','🅿️','🆘','🆙','🆚','🈁','🈂️','💱','💲','#️⃣','*️⃣','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','©️','®️','™️'],
      'Flags':    [':flag_us:',':us_betsy_ross:',':gadsden:',':flag_gb:',':flag_ca:',':flag_au:',':flag_nz:',':flag_ie:',':flag_fr:',':flag_de:',':flag_it:',':flag_es:',':flag_pt:',':flag_nl:',':flag_be:',':flag_lu:',':flag_ch:',':flag_at:',':flag_dk:',':flag_no:',':flag_se:',':flag_fi:',':flag_is:',':flag_pl:',':flag_ee:',':flag_lv:',':flag_lt:',':flag_cz:',':flag_sk:',':flag_hu:',':flag_ro:',':flag_bg:',':flag_si:',':flag_hr:',':flag_gr:',':flag_al:',':flag_me:',':flag_mk:',':flag_ua:',':flag_tr:',':flag_jp:',':flag_kr:',':flag_tw:',':flag_ph:',':flag_th:',':flag_sg:',':flag_in:',':flag_id:',':flag_my:',':flag_vn:',':flag_mn:',':flag_bd:',':flag_lk:',':flag_np:',':flag_il:',':flag_sa:',':flag_ae:',':flag_qa:',':flag_bh:',':flag_kw:',':flag_om:',':flag_jo:',':flag_eg:',':flag_ma:',':flag_tn:',':flag_mx:',':flag_br:',':flag_ar:',':flag_cl:',':flag_co:',':flag_pe:',':flag_uy:',':flag_ec:',':flag_cr:',':flag_pa:',':flag_gt:',':flag_do:',':flag_jm:',':flag_bs:',':flag_tt:',':flag_za:',':flag_ke:',':flag_ng:',':flag_gh:',':flag_sn:',':flag_rw:',':flag_bw:',':flag_ci:',':flag_tz:']
    };

    // Flat list for quick access (used by search)
    this.emojis = Object.values(this.emojiCategories).flat();

    // Emoji name map for search (emoji → keywords)
    this.emojiNames = {
      '😀':'grinning happy','😁':'beaming grin','😂':'joy tears laughing lol','🤣':'rofl rolling laughing','😃':'smiley happy','😄':'smile happy','😅':'sweat nervous','😆':'laughing satisfied','😉':'wink','😊':'blush happy shy','😋':'yummy delicious','😎':'cool sunglasses','😍':'heart eyes love','🥰':'loving smiling hearts','😘':'kiss blowing','🙂':'slight smile','🤗':'hug hugging open hands','🤩':'starstruck star eyes','🤔':'thinking hmm','😐':'neutral expressionless','🙄':'eye roll','😏':'smirk','😣':'persevere','😥':'sad relieved disappointed','😮':'open mouth wow surprised','😯':'hushed surprised','😴':'sleeping zzz','😛':'tongue playful','😜':'wink tongue crazy','😝':'squinting tongue','😒':'unamused','😔':'pensive sad','🙃':'upside down','😲':'astonished shocked','😤':'triumph huff angry steam','😭':'crying sob loudly','😢':'cry sad tear','😱':'scream fear horrified','🥺':'pleading puppy eyes please','😠':'angry mad','😡':'rage pouting furious','🤬':'cursing swearing angry','😈':'devil smiling imp','💀':'skull dead','💩':'poop poo','🤡':'clown','👻':'ghost boo','😺':'cat smile','😸':'cat grin','🫠':'melting face','🫣':'peeking eye','🫢':'hand over mouth','🫥':'dotted line face','🫤':'diagonal mouth','🥹':'holding back tears','🥲':'smile tear','😶‍🌫️':'face in clouds','🤭':'giggling hand over mouth','🫡':'salute','🤫':'shush quiet secret','🤥':'lying pinocchio','😬':'grimace awkward','🫨':'shaking face','😵':'dizzy','😵‍💫':'face spiral eyes','🥴':'woozy drunk','😮‍💨':'exhale sigh relief','🥱':'yawn tired boring','😇':'angel innocent halo','🤠':'cowboy yeehaw','🤑':'money face rich','🤓':'nerd glasses','👿':'devil angry imp','🫶':'heart hands','🤧':'sneeze sick','😷':'mask sick','🤒':'thermometer sick','🤕':'bandage hurt','💅':'nail polish sassy',
      '👋':'wave hello hi bye','🤚':'raised back hand','✋':'hand stop high five','🖖':'vulcan spock','👌':'ok okay perfect','🤌':'pinched italian','✌️':'peace victory','🤞':'crossed fingers luck','🤟':'love you hand','🤘':'rock on metal','🤙':'call me shaka hang loose','👈':'point left','👉':'point right','👆':'point up','👇':'point down','☝️':'index up','👍':'thumbs up like good yes','👎':'thumbs down dislike bad no','✊':'fist bump','👊':'punch fist bump','🤛':'left fist bump','🤜':'right fist bump','👏':'clap applause','🙌':'raising hands celebrate','🤝':'handshake deal','🙏':'pray please thank you namaste','💪':'strong muscle flex bicep','💃':'dancer dancing woman','🕺':'man dancing','🤳':'selfie','🖕':'middle finger','🫰':'pinch','🫳':'palm down','🫴':'palm up','👐':'open hands','🤲':'palms up','🫱':'right hand','🫲':'left hand','🤷':'shrug idk','🤦':'facepalm','🙇':'bow','💁':'info','🙆':'ok gesture','🙅':'no gesture','🙋':'raising hand hi','🧏':'deaf',
      '🐶':'dog puppy','🐱':'cat kitty','🐭':'mouse','🐹':'hamster','🐰':'rabbit bunny','🦊':'fox','🐻':'bear','🐼':'panda','🐨':'koala','🐯':'tiger','🦁':'lion','🐮':'cow','🐷':'pig','🐸':'frog','🐔':'chicken','🐧':'penguin','🐦':'bird','🦆':'duck','🦅':'eagle','🦉':'owl','🐺':'wolf','🐴':'horse','🦄':'unicorn','🐝':'bee','🦋':'butterfly','🐌':'snail','🐞':'ladybug','🐢':'turtle','🐍':'snake','🐙':'octopus','🐬':'dolphin','🐳':'whale','🦈':'shark','🐊':'crocodile alligator','🦖':'trex dinosaur','🦕':'dinosaur brontosaurus',
      '🍎':'apple red','🍐':'pear','🍊':'orange tangerine','🍋':'lemon','🍌':'banana','🍉':'watermelon','🍇':'grapes','🍓':'strawberry','🍒':'cherry','🍑':'peach','🍍':'pineapple','🍕':'pizza','🍔':'burger hamburger','🍟':'fries french','🌭':'hotdog','🍿':'popcorn','🧁':'cupcake','🍩':'donut','🍪':'cookie','🍰':'cake','🎂':'birthday cake','🧀':'cheese','🥚':'egg','🥓':'bacon','🌮':'taco','🍜':'noodles ramen','🍝':'spaghetti pasta','🍣':'sushi','☕':'coffee','🍺':'beer','🍻':'clinking beers cheers toast','🍷':'wine','🍾':'champagne','🥂':'clinking glasses cheers toast','🥃':'tumbler whiskey bourbon','🍶':'sake','🫗':'pouring liquid','🍸':'cocktail martini','🍹':'tropical drink',
      '⚽':'soccer football','🏀':'basketball','🏈':'football american','🎮':'gaming controller video game','🕹️':'joystick arcade','🎲':'dice','🧩':'puzzle jigsaw','🎯':'bullseye target dart','🎨':'art palette paint','🎵':'music note','🎶':'music notes melody song','🎸':'guitar','🏆':'trophy winner','🎧':'headphones music','🎤':'microphone karaoke sing','🎉':'party popper celebration tada','🎊':'confetti ball celebrate','🎈':'balloon party','🎀':'ribbon bow','🎗️':'reminder ribbon',
      '🚗':'car automobile','🚀':'rocket space launch','✈️':'airplane plane travel','🏠':'house home','🏰':'castle','🌊':'wave ocean water','🌅':'sunrise','🌍':'globe earth world','🌈':'rainbow',
      '❤️':'red heart love','🧡':'orange heart','💛':'yellow heart','💚':'green heart','💙':'blue heart','💜':'purple heart','🖤':'black heart','🤍':'white heart','💔':'broken heart','✨':'sparkles stars','⭐':'star','🔥':'fire hot lit','💯':'hundred perfect','✅':'check mark yes','❌':'cross mark no wrong','❗':'exclamation mark bang','❓':'question mark','❕':'white exclamation','❔':'white question','‼️':'double exclamation bangbang','⁉️':'exclamation question interrobang','!':'exclamation punctuation bang','?':'question punctuation mark',',':'comma punctuation','.':'period punctuation dot','💤':'sleep zzz','⚠️':'warning caution','⚡':'lightning bolt zap','☀️':'sun sunny','🌙':'moon crescent night','❄️':'snowflake cold winter','🌪️':'tornado','🔴':'red circle','🔵':'blue circle','🟢':'green circle','🟡':'yellow circle','🟠':'orange circle','🟣':'purple circle','⚫':'black circle','⚪':'white circle','©️':'copyright','®️':'registered','™️':'trademark','#️⃣':'hash number sign','*️⃣':'asterisk star keycap',
      '🙈':'see no evil monkey','🙉':'hear no evil monkey','🙊':'speak no evil monkey',
      '👀':'eyes looking','👅':'tongue','👄':'mouth lips','💋':'kiss lips','🧠':'brain smart','🦷':'tooth','🦴':'bone','💀':'skull dead','☠️':'skull crossbones','👽':'alien','🤖':'robot','🎃':'jack o lantern pumpkin halloween',
      '📱':'phone mobile','💻':'laptop computer','📷':'camera photo','📚':'books reading','📝':'memo note write','🔑':'key','🔒':'lock locked','💎':'gem diamond jewel','🎁':'gift present','🔔':'bell notification','💰':'money bag rich','🔨':'hammer tool','💬':'speech bubble chat','💭':'thought bubble thinking','🗨️':'speech balloon','🗯️':'anger bubble','📣':'megaphone announcement','📢':'loudspeaker','👑':'crown king queen royal','💍':'ring diamond wedding','🕶️':'sunglasses cool'
    };

    if (!this.token || !this.user) {
      // Preserve invite param so it survives the redirect to the auth page
      const _inv = new URLSearchParams(window.location.search).get('invite');
      if (_inv) sessionStorage.setItem('haven_pending_invite', _inv);
      window.location.href = '/';
      return;
    }

    // Permission helper — true if user is admin or has mod role
    this._canModerate = () => this.user.isAdmin || (this.user.effectiveLevel || 0) >= 25;
    this._isServerMod = () => this.user.isAdmin || (this.user.effectiveLevel || 0) >= 50;
    this._hasPerm = (p) => this.user.isAdmin || (this.user.permissions || []).includes('*') || (this.user.permissions || []).includes(p);

    this.customEmojis = []; // [{name, url}] — loaded from server
    // Bundled image emoji shipped with Haven (rendered like custom emoji but
    // built into the app, so every client on this version resolves them).
    // Country flags are image-based on purpose: Windows browsers refuse to
    // render Unicode regional-indicator flags and fall back to the bare
    // two-letter code ("US", "GB", ...), so SVGs keep them consistent
    // everywhere. Flag artwork: flag-icons (MIT). See emoji/flags/ATTRIBUTION.txt.
    this.builtinEmojis = [
      { name: 'flag_us', url: '/emoji/flags/us.svg', keywords: 'united states america usa flag' },
      { name: 'flag_gb', url: '/emoji/flags/gb.svg', keywords: 'united kingdom britain uk british england flag' },
      { name: 'flag_ca', url: '/emoji/flags/ca.svg', keywords: 'canada canadian flag' },
      { name: 'flag_au', url: '/emoji/flags/au.svg', keywords: 'australia australian flag' },
      { name: 'flag_nz', url: '/emoji/flags/nz.svg', keywords: 'new zealand flag' },
      { name: 'flag_ie', url: '/emoji/flags/ie.svg', keywords: 'ireland irish flag' },
      { name: 'flag_fr', url: '/emoji/flags/fr.svg', keywords: 'france french flag' },
      { name: 'flag_de', url: '/emoji/flags/de.svg', keywords: 'germany german flag' },
      { name: 'flag_it', url: '/emoji/flags/it.svg', keywords: 'italy italian flag' },
      { name: 'flag_es', url: '/emoji/flags/es.svg', keywords: 'spain spanish flag' },
      { name: 'flag_pt', url: '/emoji/flags/pt.svg', keywords: 'portugal portuguese flag' },
      { name: 'flag_nl', url: '/emoji/flags/nl.svg', keywords: 'netherlands dutch holland flag' },
      { name: 'flag_be', url: '/emoji/flags/be.svg', keywords: 'belgium belgian flag' },
      { name: 'flag_lu', url: '/emoji/flags/lu.svg', keywords: 'luxembourg flag' },
      { name: 'flag_ch', url: '/emoji/flags/ch.svg', keywords: 'switzerland swiss flag' },
      { name: 'flag_at', url: '/emoji/flags/at.svg', keywords: 'austria austrian flag' },
      { name: 'flag_dk', url: '/emoji/flags/dk.svg', keywords: 'denmark danish flag' },
      { name: 'flag_no', url: '/emoji/flags/no.svg', keywords: 'norway norwegian flag' },
      { name: 'flag_se', url: '/emoji/flags/se.svg', keywords: 'sweden swedish flag' },
      { name: 'flag_fi', url: '/emoji/flags/fi.svg', keywords: 'finland finnish flag' },
      { name: 'flag_is', url: '/emoji/flags/is.svg', keywords: 'iceland flag' },
      { name: 'flag_pl', url: '/emoji/flags/pl.svg', keywords: 'poland polish flag' },
      { name: 'flag_ee', url: '/emoji/flags/ee.svg', keywords: 'estonia flag' },
      { name: 'flag_lv', url: '/emoji/flags/lv.svg', keywords: 'latvia flag' },
      { name: 'flag_lt', url: '/emoji/flags/lt.svg', keywords: 'lithuania flag' },
      { name: 'flag_cz', url: '/emoji/flags/cz.svg', keywords: 'czech czechia republic flag' },
      { name: 'flag_sk', url: '/emoji/flags/sk.svg', keywords: 'slovakia flag' },
      { name: 'flag_hu', url: '/emoji/flags/hu.svg', keywords: 'hungary flag' },
      { name: 'flag_ro', url: '/emoji/flags/ro.svg', keywords: 'romania flag' },
      { name: 'flag_bg', url: '/emoji/flags/bg.svg', keywords: 'bulgaria flag' },
      { name: 'flag_si', url: '/emoji/flags/si.svg', keywords: 'slovenia flag' },
      { name: 'flag_hr', url: '/emoji/flags/hr.svg', keywords: 'croatia flag' },
      { name: 'flag_gr', url: '/emoji/flags/gr.svg', keywords: 'greece greek flag' },
      { name: 'flag_al', url: '/emoji/flags/al.svg', keywords: 'albania flag' },
      { name: 'flag_me', url: '/emoji/flags/me.svg', keywords: 'montenegro flag' },
      { name: 'flag_mk', url: '/emoji/flags/mk.svg', keywords: 'north macedonia flag' },
      { name: 'flag_ua', url: '/emoji/flags/ua.svg', keywords: 'ukraine ukrainian flag' },
      { name: 'flag_tr', url: '/emoji/flags/tr.svg', keywords: 'turkey turkish flag' },
      { name: 'flag_jp', url: '/emoji/flags/jp.svg', keywords: 'japan japanese flag' },
      { name: 'flag_kr', url: '/emoji/flags/kr.svg', keywords: 'south korea korean flag' },
      { name: 'flag_tw', url: '/emoji/flags/tw.svg', keywords: 'taiwan flag' },
      { name: 'flag_ph', url: '/emoji/flags/ph.svg', keywords: 'philippines filipino flag' },
      { name: 'flag_th', url: '/emoji/flags/th.svg', keywords: 'thailand thai flag' },
      { name: 'flag_sg', url: '/emoji/flags/sg.svg', keywords: 'singapore flag' },
      { name: 'flag_in', url: '/emoji/flags/in.svg', keywords: 'india indian flag' },
      { name: 'flag_id', url: '/emoji/flags/id.svg', keywords: 'indonesia flag' },
      { name: 'flag_my', url: '/emoji/flags/my.svg', keywords: 'malaysia flag' },
      { name: 'flag_vn', url: '/emoji/flags/vn.svg', keywords: 'vietnam flag' },
      { name: 'flag_mn', url: '/emoji/flags/mn.svg', keywords: 'mongolia flag' },
      { name: 'flag_bd', url: '/emoji/flags/bd.svg', keywords: 'bangladesh flag' },
      { name: 'flag_lk', url: '/emoji/flags/lk.svg', keywords: 'sri lanka flag' },
      { name: 'flag_np', url: '/emoji/flags/np.svg', keywords: 'nepal flag' },
      { name: 'flag_il', url: '/emoji/flags/il.svg', keywords: 'israel israeli flag' },
      { name: 'flag_sa', url: '/emoji/flags/sa.svg', keywords: 'saudi arabia flag' },
      { name: 'flag_ae', url: '/emoji/flags/ae.svg', keywords: 'united arab emirates uae flag' },
      { name: 'flag_qa', url: '/emoji/flags/qa.svg', keywords: 'qatar flag' },
      { name: 'flag_bh', url: '/emoji/flags/bh.svg', keywords: 'bahrain flag' },
      { name: 'flag_kw', url: '/emoji/flags/kw.svg', keywords: 'kuwait flag' },
      { name: 'flag_om', url: '/emoji/flags/om.svg', keywords: 'oman flag' },
      { name: 'flag_jo', url: '/emoji/flags/jo.svg', keywords: 'jordan flag' },
      { name: 'flag_eg', url: '/emoji/flags/eg.svg', keywords: 'egypt egyptian flag' },
      { name: 'flag_ma', url: '/emoji/flags/ma.svg', keywords: 'morocco flag' },
      { name: 'flag_tn', url: '/emoji/flags/tn.svg', keywords: 'tunisia flag' },
      { name: 'flag_mx', url: '/emoji/flags/mx.svg', keywords: 'mexico mexican flag' },
      { name: 'flag_br', url: '/emoji/flags/br.svg', keywords: 'brazil brazilian flag' },
      { name: 'flag_ar', url: '/emoji/flags/ar.svg', keywords: 'argentina flag' },
      { name: 'flag_cl', url: '/emoji/flags/cl.svg', keywords: 'chile flag' },
      { name: 'flag_co', url: '/emoji/flags/co.svg', keywords: 'colombia flag' },
      { name: 'flag_pe', url: '/emoji/flags/pe.svg', keywords: 'peru flag' },
      { name: 'flag_uy', url: '/emoji/flags/uy.svg', keywords: 'uruguay flag' },
      { name: 'flag_ec', url: '/emoji/flags/ec.svg', keywords: 'ecuador flag' },
      { name: 'flag_cr', url: '/emoji/flags/cr.svg', keywords: 'costa rica flag' },
      { name: 'flag_pa', url: '/emoji/flags/pa.svg', keywords: 'panama flag' },
      { name: 'flag_gt', url: '/emoji/flags/gt.svg', keywords: 'guatemala flag' },
      { name: 'flag_do', url: '/emoji/flags/do.svg', keywords: 'dominican republic flag' },
      { name: 'flag_jm', url: '/emoji/flags/jm.svg', keywords: 'jamaica flag' },
      { name: 'flag_bs', url: '/emoji/flags/bs.svg', keywords: 'bahamas flag' },
      { name: 'flag_tt', url: '/emoji/flags/tt.svg', keywords: 'trinidad tobago flag' },
      { name: 'flag_za', url: '/emoji/flags/za.svg', keywords: 'south africa flag' },
      { name: 'flag_ke', url: '/emoji/flags/ke.svg', keywords: 'kenya flag' },
      { name: 'flag_ng', url: '/emoji/flags/ng.svg', keywords: 'nigeria flag' },
      { name: 'flag_gh', url: '/emoji/flags/gh.svg', keywords: 'ghana flag' },
      { name: 'flag_sn', url: '/emoji/flags/sn.svg', keywords: 'senegal flag' },
      { name: 'flag_rw', url: '/emoji/flags/rw.svg', keywords: 'rwanda flag' },
      { name: 'flag_bw', url: '/emoji/flags/bw.svg', keywords: 'botswana flag' },
      { name: 'flag_ci', url: '/emoji/flags/ci.svg', keywords: 'ivory coast cote divoire flag' },
      { name: 'flag_tz', url: '/emoji/flags/tz.svg', keywords: 'tanzania flag' },
      { name: 'us_betsy_ross', url: '/emoji/us-betsy-ross.svg', keywords: 'betsy ross flag united states america usa stars stripes colonies historical patriotic' },
      { name: 'gadsden', url: '/emoji/us-gadsden.svg', keywords: 'gadsden dont tread on me snake rattlesnake flag united states america usa liberty patriotic' },
    ];
    this.stickers = []; // [{id, name, pack_name, url}] — loaded from server
    this._emojiPickerContext = 'main'; // 'main' | 'thread' | 'dmpip' — set by emoji button handlers
    this._emojiPickerSection = 'emoji'; // 'emoji' | 'sticker' — last-used picker tab

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
    // Expose socket globally so plugin-loader can emit set-preference
    // when the user activates a published file theme (#5359)
    window.havenSocket = this.socket;
    this.voice = new VoiceManager(this.socket);
    if (this.user && this.user.id) this.voice.localUserId = this.user.id;
    
    // CRITICAL FIX: Run avatar setup first and use delegation to ensure listeners work
    this._setupAvatarUpload();

    this._setupSocketListeners();
    this._setupUI();
    this._setupThemes();
    this._setupServerBar();
    this._applyGuestMode(); // (#5381) hide DM UI / lock down features for guests
    this._setupNotifications();
    this._setupPushNotifications();
    this._resyncDesktopBadgeOnFocus?.();
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
    this._setupStickerManagement();
    this._setupWebhookManagement();
    this._setupDiscordImport();
    this._setupAuditLog();
    this._initRoleManagement();
    this._initServerBranding();
    this._setupResizableSidebars();
    this.modMode = typeof ModMode === 'function' ? new ModMode() : null;
    this.modMode?.init();
    this._setupDensityPicker();
    this._setupFontSizePicker();
    this._setupEmojiSizePicker();
    this._setupImageModePicker();
    this._setupEmbedSizePicker();
    this._setupRoleDisplayPicker();
    this._setupToolbarIconPicker();
    this._setupDebugSection();
    this._setupLightbox();
    this._setupOnlineOverlay();
    this._setupModalExpand();
    this._checkForUpdates();
    this._initDesktopAppBanner();
    this._initAndroidBetaBanner();
    this._initWelcomePopups();
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
    const organizeBtn = document.getElementById('organize-channels-btn');
    if (organizeBtn) organizeBtn.style.display = '';

    document.getElementById('mod-mode-settings-toggle')?.addEventListener('click', () => this.modMode?.toggle());
  }

  async _loadBotCommands() {
    try {
      const res = await fetch('/api/bot-commands');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.commands || !data.commands.length) return;
      const knownCmds = new Set(this.slashCommands.map(c => String(c.cmd || '').toLowerCase()));
      for (const bc of data.commands) {
        const cmd = String(bc.command || '').trim();
        if (!cmd) continue;
        const key = cmd.toLowerCase();
        if (knownCmds.has(key)) continue;
        knownCmds.add(key);
        this.slashCommands.push({
          cmd,
          // Bot commands can have arbitrary args; a hardcoded "<...>" makes
          // subcommand entries look broken and encourages base-command clicks.
          args: '',
          desc: `${bc.description || 'Bot command'}  [${bc.bot_name || 'Bot'}]`
        });
      }
    } catch { /* non-critical */ }
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