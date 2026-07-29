<GAME>
* **Entrypoint — CRITICAL**: Ensure `index.html` loads the correct entry module. If both `src/main.ts` (demo) and `src/game/main.ts` exist, **REQUIRED** use `src/game/main.ts` as the entry;
* You must confirm `src/game/main.ts` (game boot) and `src/App.tsx` (React root) are wired correctly so the project starts from the intended entry.
* **`index.html` body** — `src/index.css` already sets `overflow:hidden` and Tailwind Preflight zeroes body margin; do NOT add duplicate inline styles to `index.html`.
* **Phaser container div — CRITICAL**: NEVER add `flex`, `justify-center`, or `items-center` to the div passed as Phaser's `parent`. These classes interfere with `Scale.CENTER_BOTH`'s `margin: auto` centering and cause the canvas to render off-center. Use only `className="w-full h-full"` (or `w-full h-screen`).
* **FORBIDDEN packages** (available in package.json but must NOT be used for 2D games): `pixi.js` (use Phaser 3), `framer-motion` / `gsap` (use Phaser Tween system), standalone `import 'matter-js'` (use Phaser's built-in `physics: { default: 'matter' }`).
* ALWAYS use Phaser 3 (+ rot-js for roguelikes). NEVER pure React game loop.
* Make full use of assets in manifest.json.

<GAME_TYPE_SELECTOR>
- Bullet-Hell / Shooter / Twin-Stick / Survivor -> `<CONTINUOUS_PATTERNS>`
- Snake / Bomberman / Roguelike / Sokoban / Maze -> `<GRID_PATTERNS>`
- Tetris / 2048 / Minesweeper / Board game / Whack-a-mole / Jigsaw / Mahjong -> `<GRID_PATTERNS>`
- Auto Battler / TFT-like draft / 自走棋 -> `<AUTOBATTLER_PATTERNS>`
</GAME_TYPE_SELECTOR>

<MOVEMENT_MODEL_SELECTOR>
* **Continuous physics**: use `setVelocity` + Arcade Physics overlap/collider for shooter/survivor games. Reset velocity each frame; normalize diagonal movement (`vx *= 0.707` when both axes are active).
* **Grid/tile movement**: use `{ gridX, gridY }` + `tryMove()` + tween. NEVER use `setVelocity` for grid-aligned entities. Collision and win checks must read the data layer, not sprite positions.
* **Model matching**: if movement is continuous, state lives in physics bodies and stable collision groups; if movement is discrete, state lives in arrays/objects and the render layer only follows it.
</MOVEMENT_MODEL_SELECTOR>

<CONSTANTS_FILE>
```typescript
// Continuous top-down / shooter
export const PLAYER_SPEED = 300;
export const PLAYER_HP = 3;
export const BULLET_SPEED = 500;
export const FIRE_RATE = 150;
export const XP_PER_LEVEL = 100;
export const WAVE_DURATION = 30000;

// Grid / tile games
export const TILE_SIZE = 48;
export const GRID_W = 16;
export const GRID_H = 16;
export const LOCK_DELAY = 500;  // Tetris ms
export const BOARD_COLS = 10;    export const BOARD_ROWS = 20;
export const MINE_COUNT = 40;    export const GRID_SIZE_2048 = 4;
export const SNAKE_TICK = 150;   // ms per step
export const BOMB_FUSE = 2500;   export const BOMB_RANGE = 3;
```
</CONSTANTS_FILE>

<CONTINUOUS_PATTERNS>
* **Player movement**: reset velocity each frame; normalize diagonal (`vx *= 0.707` when both axes active).
* **Hitbox**: `body.setSize(16,16).setOffset(...)` — smaller than sprite to avoid cheap deaths.
* **Bullet pooling**: setup `physics.add.group({ maxSize: 200, runChildUpdate: true, defaultKey: 'texKey' })`; fire `pool.get()` then `bullet.enableBody(true, x, y, true, true)` (never `setActive+setVisible` alone — body stays disabled, velocity is ignored); recycle with `bullet.disableBody(true, true)` on hits AND when bullets leave the playable bounds. Any pooled projectile that can fly off-map needs an out-of-bounds cull every frame (or `setCollideWorldBounds` + `worldbounds` event), otherwise the pool silently exhausts and firing appears to stop working.
* **Default texture fallback (CRITICAL)** — `physics.add.group(...)`/`physics.add.sprite(...)` and `pool.get()` silently fall back to Phaser's built-in `__DEFAULT` texture (a green box with a cross-hatch pattern) whenever no `key`/`defaultKey`/`frame` is supplied or the supplied key doesn't match a loaded texture. This does not throw — the object renders visibly wrong but the game keeps running, and the bug is easy to misdiagnose as a physics/spawn logic issue when it's actually a missing/mistyped texture key. Always pass an explicit `defaultKey` to `physics.add.group()` and an explicit texture key to every `pool.get()`/`enableBody()`/`setTexture()` call; verify the key exists in `manifest.json` and was actually loaded in `Preloader` before spawning.
* **Stable collision targets**: dynamic physics collections that participate in overlap/collider callbacks must be stable `Phaser.Physics.Arcade.Group` instances. Do not reassign arrays after colliders are created.
* **Respawnable single-entity collision (CRITICAL)** — for any entity that is destroyed and recreated during a single play session (player death/respawn, not just full scene restart), bind colliders/overlaps to a dedicated `Phaser.Physics.Arcade.Group` (e.g. `playerGroup`) ONCE in `create()`, and always add the new sprite to that group in the respawn helper (`group.add(newSprite)`). NEVER bind colliders directly to a bare `Sprite` reference (`this.player`) and manually destroy+recreate them on every death — the manual teardown/rebuild is fragile to timing/ordering bugs and can leave the entity with no working body, silently making it disappear. Group membership makes new sprites inherit existing collision rules for free.
* **Texture basis**: the rotation table must match the texture's default facing direction. If the art is drawn with the barrel up, zero-angle must mean up.
* **Invincibility frames**: on hit, set the flag first, then apply knockback, then flash tween (`alpha 0.3, yoyo, repeat:7`), and clear after 1500ms.
* **EventEmitter `.on()` return value — CRITICAL**: `scene.events.on(event, cb)` returns the EventEmitter itself, NOT a removable listener handle. Never call `.off()` on that return value — it silently removes ALL listeners for that event (e.g. wipes every other feature's `update` handler), not just the one just added. Store the callback function in a field and call `scene.events.off(event, callback)` explicitly for precise removal. This is easy to hit in per-entity effects that hook `update` for their own lifetime (shield sprites, DOT ticks, homing behavior) — a shield's cleanup can silently kill an unrelated system's `update` listener if this pattern is misused.
* **`delta` unit — CRITICAL**: `update(time, delta)` receives `delta` in milliseconds, not seconds. For frame-rate-independent movement: `speed * delta / 1000`.
* **Enemy patterns**: circular (`angle = i / N * 2π`), spiral (`baseAngle += 15°`), aimed (`Phaser.Math.Angle.Between`), telegraphed (warning 500ms before fire).
* **Scrolling bg**: `add.tileSprite`; `tilePositionY -= 2` in update.
* Portrait vertical scroller (540×960) or landscape twin-stick (960×540). Gravity: 0.
</CONTINUOUS_PATTERNS>

<PHASE_FSM>
**Wave / boss multi-phase games require an explicit finite state machine.**
* Define a phase enum (`'idle' | 'wave' | 'boss' | 'transition' | 'victory'`) and store it in `this.phase`. All timer callbacks, spawners, and collider callbacks must guard with a phase check at entry.
* Phase transitions must be atomic — update `this.phase` first, then start/stop the relevant timers and groups. Never scatter the same condition check across multiple callbacks.
* Survivor-style wave end: requires BOTH `enemies.countActive(true) === 0` AND the spawn timer finished — missing either condition leaves an empty scene stuck in the `wave` phase.
* **Multiplayer warning** — Realtime APIs are message transports, not game protocols. If the PRD requires multiplayer but no real backend is available, implement a local AI/bot opponent instead of leaving buttons empty or showing connection errors.
* **Overlay scene transition** — if the game uses a React/HTML overlay for menus, call `this.scene.stop()` on the Phaser scene before navigating away; a running scene keeps its timers and physics active behind the overlay, causing ghost events on return.
</PHASE_FSM>

<GRID_PATTERNS>
* **Data/render separation** — grid games must keep a plain data layer for positions, state, and win conditions, and a separate render layer that only mirrors that data.
* **Grid movement** — store `{gridX,gridY}`; convert to world with `gridX * TILE_SIZE + TILE_SIZE / 2`. Collision via array lookup, NOT physics.
* **Keyboard capture** — add `keyboard.addCapture('UP,DOWN,LEFT,RIGHT,SPACE')` to prevent browser scroll.
* **Roguelike map gen**: `new ROT.Map.Digger(w,h)`; after generation, BFS-validate the exit is reachable.
* **Pathfinding**: cache A* path and recompute only when the player moves. NEVER run every frame.
* **FOV**: recompute only on player move; store visible set.
* **Turn system**: player moves -> `processEnemyTurns()` -> `updateFOV()`.
* **Sokoban**: check the box's destination cell before pushing; move box + player together via twin tweens; snapshot state before each move for undo.
* **Minesweeper**: place mines after the first click, protect a 3x3 area, count 8 neighbors, flood fill zero cells, and use right-click or long-press for flags.
* **Tetris**: store rotation arrays; collision checks should validate every occupied cell; use wall kicks, lock delay, line-clear scoring, and a ghost piece.
* **2048**: normalize every move to slide-left, merge once per tile, detect win at 2048, and animate merges/new tiles with a pop tween.
* **Board games**: Gomoku checks 4 directions from the last stone; Reversi flips along 8 directions; AI turns should be delayed briefly for breathing room.
* **Whack-a-mole**: spawn from random holes, tween pop-up and auto-hide, and tighten spawn/visible timing as difficulty rises.
* **Jigsaw**: slice with `RenderTexture.draw`, snap pieces near the target, and raise depth during drag.
* **Mahjong**: a tile is free only if it is not blocked on both left and right; pair matching uses the `type` string and wrong matches shake both tiles.
* **Snake**: model the snake as an array of grid cells, move on a timer tick, block 180° turns, detect self-collision from the data array, and render from the array order.
* **Bomberman**: move tile-by-tile with tweens, place bombs with `delayedCall`, expand explosions in 4 directions, stop on hard walls, destroy soft walls, and chain bomb blasts through the bomb grid.
</GRID_PATTERNS>

<DATA_RENDER_SEPARATION>
**Grid games (Snake, Bomberman, Sokoban, Roguelike, Maze, Board games, Minesweeper, Tetris, 2048, Whack-a-mole, Jigsaw, Mahjong) must strictly separate the data layer from the render layer.**
* **Data layer** — plain JS arrays/objects hold positions, state, and win conditions; no Phaser object references. All rule checks (valid move, win/loss, collision) query only the data layer.
* **Render layer** — Phaser sprites and text read from the data layer and call a single `renderFromData()` method to refresh visuals; they do not participate in logic.
* **Forbidden** — deriving grid positions from sprite `x/y` coordinates for win checks; storing board arrays in Zustand (large object diffs on every state change are expensive).
* **Level solvability** — hand-authored or procedurally generated maps must be validated with BFS/DFS to confirm the goal is reachable. A single wrong cell value silently makes a level unsolvable.
* **Exception — cross-scene shared entities**: this "no board arrays in Zustand" rule assumes a single Scene owns the board for its own lifetime. Auto-battler / multi-scene draft games that must share `board/bench` across separate Scenes follow `<AUTOBATTLER_PATTERNS>` instead.
</DATA_RENDER_SEPARATION>

<MOBILE_CONTROLS>
```javascript
if (!this.game.device.os.desktop) {
  // Shooter/Survivor: rexVirtualJoystick left + fire button right (auto-attack: skip fire btn)
  // Snake: pointermove swipe — if |dx|>|dy| set x-dir else y-dir, threshold 20px
  // Bomberman / Sokoban / Roguelike: 4 rect D-pad buttons or swipe detection
  // Tetris: swipe left/right=move, swipe down=soft drop, tap=rotate
  // Minesweeper/2048: tap-based, no extra controls needed
  // Jigsaw/Mahjong: drag-based, pointer events handle naturally
}
```
</MOBILE_CONTROLS>

<AUDIO>
- Shooter: short punchy fire sound at low volume (0.3) to avoid overlap; explosion variants by enemy size.
- Survivor: gem pickup chime, level-up fanfare.
- Snake: eat sound, death crunch.
- Bomberman: place click, fuse tick, explosion boom, wall crumble.
- Tetris: move click, line clear zap, Tetris fanfare.
- 2048: slide swish, merge pop.
- Minesweeper: reveal click, flag place, explosion.
- Mahjong: tile click, shuffle.
- Trigger only after first interaction (autoplay policy).
</AUDIO>

<ZUSTAND_RULES>
All-Phaser UI is the default — manage all state inside scenes, no Zustand needed. Only add Zustand if React components outside the canvas must reflect game state.

If Zustand is used: call `useGameStore()` once at the top of the component and destructure all needed values — never call it inside JSX conditionals or `.map()` callbacks. Violating this causes a React hooks order crash.

**Exception — cross-scene shared entities**: see `<AUTOBATTLER_PATTERNS>` for the one case where match entity state (`board/bench/combatResult`) belongs in Zustand rather than scene-local properties.
</ZUSTAND_RULES>

<SCENE_LIFECYCLE>
* **`shutdown()` must be a class method** — call `this.time.removeAllEvents()`, mirror every `EventBus.on` with `EventBus.off`, and `group.destroy(true)` / `this.tweens.killAll()` as needed.
* **Re-zero mutable instance fields at the top of `create()`/`init()`** — class fields holding GameObject refs (`baseObj`, `bossRef`, `unitSprites: Map`, `playerUnits/enemyUnits: Sprite[]`, palette/piece caches, etc.) MUST be reset to empty there, not merely initialized in the field declaration. `scene.restart()` / `scene.start(key)` reuse the SAME scene instance and rerun lifecycle methods WITHOUT rebuilding those fields, so stale destroyed-sprite refs accumulate and throw `TypeError` or skip recreation guarded by `if (!field)`. Audit every win/loss branch: if a ref is nulled only in one exit path (e.g. base destroyed) but victory or HP-depletion can also restart the scene, that stale ref survives into the next run.
* **Restart run state explicitly** — any entry point that restarts or resumes gameplay (retry button, back-to-menu then start, next level) must explicitly restore `this.physics.resume()` and unpause relevant `TimerEvent`s. `this.physics.pause()` and `timer.paused = true` set during game-over/menu states can survive `scene.restart()` on the reused Scene instance, leaving newly recreated sprites frozen or spawners disabled.
* **Keep state inside the scene** — all game state lives as scene-local properties; React's role is only to host the canvas container. Exception: multi-scene auto-battler games sharing match entities across scenes follow `<AUTOBATTLER_PATTERNS>` instead.
* **Tween visibility / input — CRITICAL** — `alpha=0` or `setVisible(false)` makes an object invisible but does NOT remove its input hit-area; pointer events still fire on transparent objects, silently intercepting taps intended for elements beneath. Always call `disableInteractive()` when hiding and `setInteractive()` when showing again.
* **Collider ownership** — remove colliders and events before rebuilding on restart; stacking old callbacks causes duplicate damage and score events. This applies to full scene restarts (`scene.restart()`); for same-session single-entity respawn (e.g. player death), use the Group-bound approach in `<CONTINUOUS_PATTERNS>`'s "Respawnable single-entity collision" rule instead — manual per-death rebuild doesn't scale to frequent respawns and is fragile to timing bugs.
* **Physics body sync** — after `setDisplaySize` or `setScale`, call `body.setSize(w, h, true)` or `body.setSize(w, h).setOffset(x, y)` so hitboxes stay aligned to the DISPLAY size, not the original texture size. Reusing pre-scale texture dimensions (for example a 100px body on a 48px displayed tank) makes the visible sprite clip past bounds/walls before physics reacts.
* **Inset hitbox vs world bounds** — when `body.setOffset(x,y)` shrinks the hitbox inside the sprite (common to avoid corner-snagging), `setCollideWorldBounds(true)` + `world.setBounds(...)` only clamps the BODY's position, not the sprite's visible edge — the display sprite can visibly overshoot the boundary by up to the offset amount on each side. If precise visual containment matters (e.g. tanks must never appear to enter a UI sidebar), clamp the sprite's own `x/y` in `preUpdate()` against bounds that account for `displayWidth/displayHeight`, rather than relying on body-only world-bounds collision.
* **Save state completeness** — serialize all mutable state for save/load games: position, HP, inventory, key/switch states, floor index, and any other progress counters.
* **Type-check every deref inside async lifelines** — any callback driving a game loop via `time.delayedCall(cb)` / `tween.onComplete` / `onYoyo` MUST validate before touching a GameObject. Two forbidden unguarded shapes throw mid-tick and prevent the NEXT scheduled timer from ever registering (= permanently frozen screen): (1) calling `.setTint/.clearTint/.play/.stop/.setFrame/.setTexture` directly on a `GameObjects.Container` — those APIs exist ONLY on Image/Sprite/Text; (2) reading/writing `container.list[N].prop` against a bare array index with no length-or-type guard. Guard with existence checks (`if (!targetSprite) { cb(); return; }`) and prefer storing stable child refs over positional indexing.
* **No silent settle behind nullable runtime guards** — never gate critical win/loss/damage settlement behind `if (cond && someResolvedVar)` where `someResolvedVar` comes from a parse that may legitimately yield null (opponent matchup, combat opponent ref, attack target). Either guarantee non-null during setup or branch explicitly into a no-op/draw fallback — else the whole settlement silently no-ops whenever resolution misses, hiding total feature failure from both player and dev console with zero thrown error.
</SCENE_LIFECYCLE>

<AUTOBATTLER_PATTERNS>
**Scope**: applies only to auto-battler / draft games that split gameplay across multiple Scenes (e.g. a prep/bench Scene and a combat Scene) needing to share the same match entities. Single-Scene grid games keep following `<DATA_RENDER_SEPARATION>` and the default `<SCENE_LIFECYCLE>` state-ownership rule instead.
* **Fielded collection with empty-board fallback**: combat units derive from each side's `board`. When `board` is empty because the player forgot to drag bench pieces into play, clone top-N units off `bench` (N = current level cap) as throwaway stand-ins with freshly assigned legal grid coordinates — NEVER write clones back to `player.board/bench`, they pollute next round's layout. Only when BOTH board AND bench are empty should you resolve straight to a draw/no-damage round instead of forcing an instant loss.
* **Pure logic layer emitting event descriptors**: CombatEngine operates solely on plain `{id,typeId,maxHp,hp,x,y,isDead}` records and returns per-tick descriptors `{action:'attack'|'move'|'wait', actorId, targetId?, dmg?}`. Keep ALL Phaser object access out of this class; let the Scene consume descriptors through its own async replay loop so logic stays testable and crash-isolated.
* **Async replay loop drives every frame**: scene advances one tick at a time via `delayedCall(cb)` chaining `nextTurn()→executeTurn()→animateAction(result, onComplete)` then re-loops after `onComplete`. Never run the whole battle synchronously in a single forEach pass — that crashes irrecoverably when any single animation throws mid-loop.
* **Single source of truth for match entities (exception to default state ownership)**: hold `board/bench/combatResult/playerStats/hp` in your central store (Zustand) instead of scene-local properties; scenes read via getter only and NEVER snapshot local copies — diverging local arrays vs store sets produce ghost-state bugs where two scenes disagree about who owns which tile/unit.
* **Guard everything referenced above**: follow `<SCENE_LIFECYCLE>`'s async-lifeline and no-silent-settle rules verbatim here — null-check sprites before tween/tint/setFrame calls, refuse bare `list[N]` indexing, ensure any settlement branch guarded by `&& resolvedVar` cannot be skipped by a legitimately-null resolution result.
</AUTOBATTLER_PATTERNS>
</GAME>
