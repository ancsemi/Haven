# AutoMod Quarantine (experimental)

> **Experimental.** Everything below is off by default. Members turn the plugin
> on for themselves in **Settings › Plugins & Themes**, and the server side
> (local AI, the shared verdicts and the cloud relay) only runs after an admin
> turns on **Settings › Safety › Auto-Mod › AI link checks**. With that switch
> off, every `/api/automod/*` endpoint answers 404 and the server never
> contacts Ollama or a cloud AI host.

AutoMod Quarantine is a plugin that holds every unverified link in a chat
message behind a non-clickable capsule until it has been checked. Safe links
unlock in place with a shield badge. Phishing, scams, malware downloads and
other rule-breaking links turn into a red "Link Blocked" card, and moderators
can warn the poster or release the link by hand.

The check can run on the server owner's own hardware. One setup script picks a
model that fits the machine, and from then on the Haven server sweeps every new
link by itself, with nothing to configure in the browser.

## Setting up local AI

Run this once from the Haven folder on the machine that runs the server:

```sh
./scripts/setup-automod-ai.sh --install-ollama --pull
```

The script:

1. Detects the GPU (NVIDIA, AMD or Apple Silicon), its memory, the CPU cores
   and the system RAM.
2. Installs and starts [Ollama](https://ollama.com) if it is missing
   (`--install-ollama`).
3. Picks a model for that hardware and downloads it (`--pull`).
4. Writes `config/automod-local.json`, which the server reads on the fly. No
   restart is needed.

Other flags: `--model=NAME` forces a model, `--dry-run` prints the hardware
profile and the pick without changing anything, and a folder path as the first
argument sets up a Haven install somewhere else.

| Tier | Hardware | Model |
|---|---|---|
| `gpu-ultra-moe` | 20 GB+ VRAM | `qwen3.6:35b-a3b` (MoE, 3B active) |
| `gpu-high` | 10 to 19 GB VRAM | `granite4.2:8b` |
| `gpu-mid-moe` | 5.5 to 9.9 GB VRAM | `granite4:7b-a1b-h` (MoE, 1B active) |
| `gpu-entry` | 2.5 to 5.4 GB VRAM | `granite4.2:3b` |
| `cpu-server-moe` | CPU only, 48 GB+ RAM, 8+ cores | `qwen3.6:35b-a3b` |
| `cpu-moe` | CPU only, 8 to 47 GB RAM | `granite4:7b-a1b-h` |
| `cpu-light` | under 8 GB RAM | `qwen3.5:0.8b` |

Then turn on **AI link checks** in **Settings › Safety › Auto-Mod**, and turn
the plugin on in **Settings › Plugins & Themes**. On startup it asks
the server whether local AI is set up and, if it is, switches to **This Haven
Server (Local AI)**. Moderators on any device, phones included, use the
server's model; nobody needs a key or an open port.

## How a link is checked

1. **Quarantine.** Every link in a rendered message is wrapped in a capsule.
2. **Source trust.** Trusted domains (GitHub, Wikipedia, YouTube, Steam and
   others) are released at once. Raw IP addresses, punycode look-alikes,
   dangerous file types (`.exe`, `.scr`, `.bat` and so on) and blocked domains
   are blocked at once. Neither case reaches the AI.
3. **Server sweep.** When a message is sent, edited or posted in a thread, the
   server queues its other links for the local model straight away. The model
   only ever sees the link, never the message around it, so no message text
   (private channels and DMs included) reaches any AI, local or cloud. The
   plugin's keyword checks still read the message, inside the browser.
4. **Verdict.** The plugin shows the result. A link the AI blocks also puts
   its domain on that moderator's block list, so the rest of a spam burst is
   blocked without another AI call. Keyword fallbacks never block a whole
   domain.

The server keeps one queue for everybody, so only one link reaches the model at
a time however many people are online. A member's posted links can take at
most 10 places a minute and never more than 50 of the 77, and a moderator's own
scan goes to the front, so link spam cannot lock moderators out. Each verdict is cached for a day and
shared, so a link is checked once, not once per viewer. While links are queued
the model stays loaded; when the queue empties the server tells Ollama to
unload it, which frees the GPU between scans.

Thinking models are asked for a direct answer. An empty or malformed answer is
never treated as safe: the server reports the AI as unavailable and the plugin
falls back to its keyword checks. A link that only passed the keyword checks
is released with a grey "not AI-checked" tag instead of the shield.

## Who can do what

| Action | Who |
|---|---|
| See verdicts the server already has | Any signed-in member with the plugin on |
| Start a new local AI scan | Moderators (`delete_message`) and admins |
| Post automatic warnings | Moderators and admins; the server gives each warning to exactly one of them |
| Change the rules the local AI uses | Admins, by saving **Server Rules** in the AutoMod settings |

Server endpoints, all behind a Haven session:

- `GET /api/automod/local-status`: whether local AI is ready and which model.
- `POST /api/automod/scan`: the verdict for one link.
- `POST /api/automod/claim-warn`: claims an automatic warning for one message.
- `PUT /api/automod/rules`: saves the local AI rules (`automod_rules` in
  `server_settings`).
- `POST /api/automod/relay`: forwards a moderator's request to a fixed list of
  cloud AI hosts that refuse browser requests (see below).

## Cloud providers

Instead of local AI, a moderator can pick a cloud provider in the AutoMod
settings and paste their own key: Google Gemini, Anthropic Claude, OpenAI, xAI
Grok, Meta Muse Spark, OpenCode, OpenRouter, Mistral, DeepSeek, a custom
OpenAI-compatible endpoint, or Ollama on the moderator's own device. These
calls go from the moderator's browser with the key stored in that browser.

Some providers refuse requests from a browser. For those, the plugin sends the
request through `POST /api/automod/relay`, which only moderators can use, only
reaches a fixed list of AI hosts over HTTPS, and only passes on the
authentication headers.

The **Bearer token** box takes a token instead of an API key: a Google Cloud
access token for Gemini (`gcloud auth print-access-token`), an OpenCode Go key,
or the token of your own proxy in front of a provider.

## Moderator controls

- **Automatic warnings** are off by default. Turned on, a moderator's browser
  posts the warning template in the channel under that moderator's name.
- **Warn User** records a strike and posts the warning template in the channel.
  At the strike limit (3 by default) moderators are alerted.
- **Override & Release** marks a blocked link safe and takes its domain off the
  block list.

## Known limits (why it is experimental)

- Strikes, the block list the plugin learns, and manual releases are kept in
  each moderator's own browser, not on the server, so two moderators can see
  different counts.
- The plugin only changes what people who turned it on see. Everyone else gets
  ordinary links. Haven's built-in Auto-Mod (domain policy, words, escalation)
  is what actually stops a message from being posted.
