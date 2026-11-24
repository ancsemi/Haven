# Birch on your server

Birch is a small town your members play together inside Haven. It runs as a separate program, the Birch bot, next to Haven. Haven does not ship it and does not need it.

When you set it up, Birch appears as a card in Activities on web and desktop, and in Games in the mobile apps. When you do not, nothing changes: there is no card, and `/birch` answers 404.

## How it fits together

- The Birch bot listens on its own port, on this machine only.
- Haven forwards `/birch/...` on its own address to the bot. Members never see the bot's port, and no second certificate or domain is needed.
- Members sign in once. The bot checks the same session token Haven issues, so it needs Haven's session key (`JWT_SECRET`).
- Haven shows the card only while the bot answers and accepts that key. If the bot stops, the card disappears within about ten seconds. If it starts again, the card comes back within about thirty.

## Set it up

1. Download the Birch bot bundle (`birch-bot-<version>-linux-x86_64.tar.gz`) and its `.sha256` file from the [Birch bot releases](https://github.com/Amnibro/Haven/releases/tag/birch-bot-v1.0.0), and check it with `sha256sum -c`.
2. Unpack it somewhere the Haven user can run it, for example `~/birch-bot`. Inside are `haven-bot`, `web/`, `.env.example`, a systemd unit and a Dockerfile. The bundle's own README has the details.
3. Copy `.env.example` to `.env`. It already says `GAME_ONLY=true`, `PORT=3002` and `BIND_ADDRESS=127.0.0.1`. Point the bot at Haven's key with one of:
   - `HAVEN_ENV_FILE=/home/you/.haven/.env` (Haven's data folder `.env`; on Docker it is the `.env` inside the `/data` volume).
   - `HAVEN_JWT_SECRET=<the JWT_SECRET value from that file>`.
4. Start the bot: `./haven-bot` from the unpacked folder, or install the systemd unit from the bundle.
5. Tell Haven where the bot is. Add this to the environment Haven starts with (or to its data folder `.env`) and restart Haven:

   ```
   BIRCH_PROXY_URL=http://127.0.0.1:3002
   ```

6. Open Activities. The Birch card is there.

With Docker Compose, unpack the bundle into `./birch-bot` next to `docker-compose.yml` and run `docker compose --profile birch up -d`. Set `BIRCH_PROXY_URL=http://birch:3002` for Haven in your compose `.env`. The `birch` service reads the session key from Haven's `/data` volume by itself.

## Only point it at a Birch you run

`/birch` is served from Haven's own origin. The pages Birch sends run with the same access as Haven's own pages, including the member's session token. Set `BIRCH_PROXY_URL` only to a Birch bot you installed yourself, never to someone else's server or an address you do not control.

Haven passes only the pages and the three game calls (`/api/v1/state`, `/api/v1/action`, `/api/v1/events`) through. The bot's other routes are not reachable through `/birch`. Cookies are not forwarded to the bot, and the bot's own security headers are replaced by Haven's.

## When the card does not show

Admins can see why. While signed in as an admin, `GET /api/birch/status` answers `{ "enabled": false, "reason": "..." }`. Haven also logs one line each time the state changes.

| reason | meaning | fix |
| --- | --- | --- |
| `off` | `BIRCH_PROXY_URL` is not set | set it and restart Haven |
| `unreachable` | nothing answers at that address | start the bot; check the port and `BIND_ADDRESS` |
| `secret` | the bot answered but refused Haven's session key | make the bot's `HAVEN_JWT_SECRET` (or the key in `HAVEN_ENV_FILE`) equal Haven's `JWT_SECRET` |
| `not-birch` | something else answers there | point `BIRCH_PROXY_URL` at the bot |
| `ok` | working | none |

Members who are not admins only see whether Birch is on.

## Notes

- The bot keeps its world in the file named by `STATE_FILE` (default `./data/world.tsv`). Back that file up with your other data.
- Behind a reverse proxy, forward `/birch/` like the rest of Haven. No extra setup is needed.
- `GAME_ONLY=true` runs only the game. The bot's chat commands (`/fish`, `/cat` and so on) need the bot webhook settings in the bundle's README and are optional.
- Mobile apps from Haven 9.2.0 on look for `/birch/api/v1/state` and show Birch when it answers. No app setting is needed.
