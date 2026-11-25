# Arcade (Pool, Minigolf, Shippy Container)

Source for the page in `public/games/arcade/`. The games are written in [Helium](https://github.com/Amnibro/helium); `src/arcade.he` is the entry point.

| Files | What they hold |
| --- | --- |
| `pool.he`, `pool_ai.he`, `pool_look.he`, `pool_play.he` | eight-ball rules and physics, the computer player, the 3D table, the screen |
| `golf.he`, `golf_ai.he`, `golf_look.he`, `golf_play.he` | minigolf physics, holes and the course generator, the computer player, the 3D course, the screen |
| `shippy.he`, `shippy_look.he`, `shippy_play.he` | Shippy Container rules (the original game's numbers), the 3D harbor, the screen |
| `kit.he`, `sfx.he` | buttons, panels and text; sounds made in code |
| `test_*.he` | simulation tests: whole games between computer players, every hole of generated courses, sound lengths |

## Build

The page needs Helium branch [`haven-arcade`](https://github.com/Amnibro/helium/tree/haven-arcade) (commit `9adeadfe`). Build Helium's compiler with `hc/bootstrap.sh` (it writes `build/hcn`), then, with that checkout as `helium` next to this folder's `src` as `arcade`:

    HC_LIB=helium/hc/lib helium/build/hcn build --web -DGS_WEB_MOVE=1 arcade/arcade.he -o out/arcade.wasm

That writes `out/arcade.wasm` and `out/helium.js`; copy both into `public/games/arcade/`. `-DGS_WEB_MOVE=1` is required: without it the wasm runs out of address space at startup. A relative `HC_LIB` keeps local folder names out of the wasm's error messages.

The same sources build a desktop program (`hcn build arcade/arcade.he -o arcade`), and `hcn build arcade/test_golf.he` and the other tests run natively.

## Page

- `index.html?game=pool`, `minigolf` or `shippy` opens one game; add `&gl` to force WebGL2. WebGPU falls back to WebGL2 when it does not answer within 4 seconds.
- Scores go to the host as `window.HavenArcade.score(game, score)` (Android), `webkit.messageHandlers.havenArcade` (iOS), a `game-score` message to the parent window or opener (web), or a POST to `/api/high-scores`. Ids: `flappy` (Shippy Container), `arcade-pool`, `arcade-minigolf`.
