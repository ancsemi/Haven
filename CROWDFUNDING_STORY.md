# Haven — Your Conversations Are Yours

## The Short Version

Haven is a private chat server you run on your own computer. Voice chat, screen sharing, 17+ themes, GIFs, mobile support — everything you'd expect from Discord, except your messages stay on YOUR machine and no corporation ever touches them.

**Haven is already built, already free, and already on GitHub.** This isn't a promise — it's a working product. Your support helps one developer keep improving it.

---

## Why Haven Exists

### Discord changed the deal.

When Discord launched in 2015, the pitch was simple: free voice chat for gamers. No ads, no bullshit. People loved it. Communities migrated from Skype, TeamSpeak, and Mumble by the millions. Discord became *the* place to talk to your friends.

Then things shifted.

In 2018, Discord pivoted from "chat for gamers" to "chat for everyone" — and with that pivot came a new business model. They needed to monetize 150 million users, and the playbook was familiar:

- **Data collection ramped up.** Discord scans every message you send. Their privacy policy explicitly states they collect message content, voice metadata, device information, IP addresses, and usage patterns. In 2023, they updated their policy to allow using this data for machine learning and AI training.

- **Your DMs aren't private.** Discord can and does read private messages. They've handed data to law enforcement without warrants in some cases, and their Trust & Safety team has access to every message on the platform — including "private" ones.

- **They experimented with ads.** In 2023, Discord began testing "Sponsored Quests" — essentially advertisements baked into the app. The backlash was loud, but the trajectory is clear: when you're free, you're the product.

- **Nitro got more aggressive.** Features that used to be free got paywalled. Upload limits shrunk. Emoji restrictions tightened. The free tier keeps getting worse to push you toward $10/month.

- **AI integration without consent.** In late 2024, Discord rolled out AI features trained on user conversations. They made these opt-out rather than opt-in, and the opt-out process was deliberately buried in settings.

The pattern is the same one we've seen with every platform: launch free, build a user base, then gradually extract value from those users. Facebook did it. Google did it. Now Discord is doing it.

### The core problem

Every mainstream chat platform — Discord, Slack, WhatsApp, Telegram — has the same fundamental architecture: **your messages live on someone else's computer.** You're trusting a corporation to:

- Not read your messages (they do)
- Not sell your data (they will, eventually)
- Not get hacked (they have)
- Not shut down or change terms (they can, anytime)
- Keep existing (nothing lasts forever)

This isn't paranoia. It's just how the incentives work. If a company stores your data, they will eventually monetize it. It's a matter of when, not if.

### So I built Haven.

Haven flips the architecture. Your messages live on YOUR computer. Not a cloud server, not a CDN, not a database in Virginia that three letter agencies can subpoena. Your machine. Your hard drive. Period.

When you close Haven, it's off. No background processes phoning home. No analytics. No telemetry. No tracking pixels. The code is open source — you can read every line and verify this yourself.

---

## What Haven Actually Is

Haven is a **fully-featured chat platform** you run on your own computer in about 60 seconds. Here's what's already built and working:

**Communication:**
- Real-time text chat with channels and direct messages
- Peer-to-peer voice chat (audio goes directly between users, not through a server)
- Screen sharing with multi-stream support
- GIF search, file sharing (up to 25 MB), link previews

**Customization:**
- 17+ built-in themes (Haven, Discord, Matrix, Tron, HALO, Lord of the Rings, Cyberpunk, and more)
- Custom themes and RGB mode
- Per-user notification sounds and volume controls

**The key innovation:**
- **Only the host downloads Haven.** Everyone else just opens a link in their browser.
- Works on **desktop AND mobile** — phones and tablets included
- No app store. No account with any company. No email or phone number required.
- Your non-technical friends can join in 30 seconds.

**Administration:**
- Full moderation tools (kick, mute, ban, auto-cleanup)
- Multi-server support (connect to friends' Haven servers)
- Message search, pinned messages, slash commands
- Built-in mini game with server-wide leaderboard

---

## This Isn't Vaporware

I want to be very clear about something: **Haven already exists.** You can download it right now from [GitHub](https://github.com/ancsemi/Haven), unzip it, double-click a file, and be chatting with friends in under a minute.

It's been through multiple major releases (currently v1.4.2), it has active users, and it works. This isn't a concept or a prototype or a roadmap — it's a real application that real people use every day to talk to their friends.

I'm not asking you to fund a dream. I'm asking you to support a thing that already exists and already works.

---

## What Your Support Gets

Haven will always be free. The source code will always be open. That's a promise, not a marketing line.

But building and maintaining software takes time, and time costs money. Right now I build Haven in my spare time around a day job. Your support helps me:

**Keep the lights on:**
- Domain and hosting costs for the website and documentation
- Code signing certificates (so Windows doesn't flag the installer)
- Development tools and testing infrastructure

**Build the roadmap:**
- **End-to-end encryption (E2EE)** — Optional per-channel client-side encryption so even the host machine can't read messages at rest
- **Webhook & bot support** — Let external services post to channels and respond to events
- **Permission system** — Role-based access control (Admin → Moderator → Member → Guest) with per-channel overrides
- **Thread replies** — Branching conversations without cluttering the main chat
- **Video calls** — Face-to-face alongside the existing voice chat

**Spend more time on it:**
- More frequent updates and faster bug fixes
- Better documentation for non-technical users
- Community support and feature requests

---

## Funding Tiers

### ☕ Coffee ($5)
You're a good person and Haven will remain free because of people like you.

### 🧱 Brick Layer ($15)
Your name on the Haven supporters list (if you want). Plus everything above.

### 🔧 Builder ($30)
Priority feature requests — I'll genuinely consider and respond to your suggestions. Plus everything above.

### 🏗️ Architect ($50)
Direct input on the roadmap. I'll personally walk you through setup if you need help. Plus everything above.

### 🏰 Founder ($100+)
Your name (or alias) permanently credited in Haven's About section. Direct line to me for support and feature discussion. You're essentially a co-creator at this point. Plus everything above.

---

## FAQ

**Q: Why don't you just run ads?**
A: Because that would make Haven exactly the thing it was built to replace. The moment ads enter the picture, user tracking follows. I'd rather earn less and keep the project honest.

**Q: If I donate, will Haven stay free for everyone?**
A: Yes. Always. Donations help me develop faster, not gatekeep features. Every feature ships to every user.

**Q: Is my data really private?**
A: Yes. Haven stores messages in a local SQLite database on the host's computer. Nothing is sent anywhere. The code is open source — you can verify this yourself. There's no analytics, no telemetry, no phoning home.

**Q: What if you stop working on it?**
A: The code is open source under MIT-NC license. Even if I got hit by a bus tomorrow, anyone can fork it and keep it going. Your chat server runs locally — it doesn't depend on me being alive.

**Q: I'm not technical. Can I actually use this?**
A: That's literally the point. Download a zip file, double-click "Start Haven.bat," done. Your friends don't download anything — they click a link in their browser. If you can install a game from a zip file, you can run Haven.

---

## The Bottom Line

I'm not building Haven to get rich. I'm building it because I think people deserve to talk to their friends without a corporation listening in.

Every dollar goes directly into making Haven better. No investors. No board of directors. No "pivot to monetization." Just one person building something useful.

**Haven exists today. It works today. Your support makes it better tomorrow.**

[Download Haven](https://github.com/ancsemi/Haven) — it's free, always.

[Support the project](https://ko-fi.com/ancsemi) — if you want to.

---

*Haven — Because your conversations are yours.*
