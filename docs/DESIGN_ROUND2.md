# Round 2 — Juiz em 3D, design das jogadas e manual integrado

Binding for the round-2 agents, on top of `docs/ARCHITECTURE.md`. Public APIs below are contracts between agents
working in parallel: implement them exactly.

## 1. Layout: a 9-position ring with the dealer

The seat ring now has **9 evenly spaced positions** `t = p / 9` (same stadium path as before, `t = 0` bottom-centre,
increasing clockwise toward −X). Position **5** (`t = 5/9`, top side, slightly right of centre, x ≈ +0.41 m) belongs
to the **dealer**. The 8 seat slots map to positions `slot < 5 ? slot : slot + 1` (slots 0–4 → positions 0–4,
slots 5–7 → positions 6–8). `slotForSeat` / `seatForSlot` are unchanged (still modulo 8); only the slot → position
mapping changes. Insets (cards 0.23 m, bets 0.40 m, plates 0.07 m) stay.

New exports in `SeatLayout.ts`:

```ts
export const RING_POSITIONS = 9;
export const DEALER_RING_POSITION = 5;
export const DEALER_STAND_POSITION: Vector3;  // on the floor (y = 0), behind the far rail at t = 5/9, ~0.12 m outside the rail
export const DEALER_YAW: number;              // rotation.y so the dealer faces the table centre
export const DEALER_TRAY_POSITION: Vector3;   // on the felt in front of the dealer (the model's chips_box tray)
export const DEALER_TRAY_YAW: number;
```

`DECK_POSITION` moves next to the dealer's right hand (on the felt, between the tray and the community row);
`MUCK_POSITION` next to the tray on the other side. Everything must be verified numerically: no overlap between the
tray, deck, muck, community row, pot and any seat's cards/bet/button anchors (print a table of distances).

## 2. Dealer character — `src/client/scene/Dealer.ts`

Asset: `/assets/dealer/dealer.glb` (Renderpeople "Eric": vest, white shirt, tie — a croupier). Skinned mesh, 20.5 k
triangles, 1 PBR material (color, normal, metallic-roughness), height 1.86 m with feet at y = 0, rig node
`dealer_rig` (scale 0.01, bone translations in cm). The skin has 88 joints (90 nodes with the rig and mesh nodes) with
these names: `root, hip, spine_01, spine_02, spine_03, neck, head, head_end, jaw, eye_l/r, eyelid_l/r, eyebrow_l/r,
shoulder_l/r, upperarm_l/r, lowerarm_l/r, hand_l/r, thumb_01..03_l/r, index_01..03_l/r, middle_…, ring_…, pinky_…,
upperleg_l/r, lowerleg_l/r, foot_l/r, ball_l/r`, plus `*_end` tip joints and `*_twist_*` helpers. The legs are called
`upperleg`/`lowerleg`, not thigh/calf. Bind pose is an A-pose (arms ~45° down).

```ts
export class Dealer {
  static load(manager: THREE.LoadingManager): Promise<Dealer>;
  readonly root: THREE.Object3D;             // placed at DEALER_STAND_POSITION / DEALER_YAW, casts shadows
  readonly speechAnchor: THREE.Object3D;     // ~0.28 m above the head, for the speech bubble
  update(deltaSeconds: number, elapsedSeconds: number): void; // idle + look-at smoothing; call every frame
  lookAt(target: THREE.Vector3 | null): void; // head/neck/eyes turn smoothly (clamped), null = look at the table centre
  handWorldPosition(side: 'left' | 'right', out: THREE.Vector3): THREE.Vector3;
  gestureDeal(target: THREE.Vector3, seconds?: number): Promise<void>;   // right arm flicks a card toward target
  gestureCollect(seconds?: number): Promise<void>;                      // both arms sweep toward the pot
  gesturePush(target: THREE.Vector3, seconds?: number): Promise<void>;  // pushes the pot toward a winner
  gesturePoint(target: THREE.Vector3): void;                            // brief open-palm point to the acting seat
  nod(): void;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}
```

Procedural animation only (no clips): a natural croupier rest pose built from the A-pose (shoulders relaxed, upper
arms down and slightly forward, elbows bent so both hands hover just above the tray/rail), idle breathing on
spine_02/03, subtle weight shift, occasional blinks via eyelid bones, smooth head/neck look-at with yaw/pitch
limits, gestures as GSAP timelines that blend from the rest pose and back. Gestures must never leave the rig in a
non-rest pose (kill/restore on overlap). Material: keep the GLB PBR, `envMapIntensity` ≈ 0.6, receive the key light.
Visual check is mandatory (see §6).

## 3. Jogadas — action design

### 3.1 `ActionBar.ts` + new `src/client/ui/actionBar.css`

Move every `.action-bar*`, `.action-btn*`, `.preset-btn*`, `.amount-field*` rule out of `styles.css` into
`actionBar.css` (imported by `ActionBar.ts`), then redesign:

- Colour system shared with the table callouts (CSS custom properties on `:root` in `actionBar.css`):
  `--act-fold #9aa3ad`, `--act-check #5aa9ff`, `--act-call #35c98a`, `--act-bet #e4b363`, `--act-raise #f0c674`,
  `--act-allin #ff5b3a`, `--act-win #ffd36b`.
- Primary row: **Fold** (outlined, muted), **Check / Pagar X** (solid call colour), **Apostar / Aumentar p/ X**
  (gold, primary, largest), **All-In X** (flame red). Each button: inline SVG icon (built with
  `document.createElementNS`, never innerHTML), verb, big tabular amount, a sub-label with the amount in BB
  (`"= 2,5 BB"`) and, for raises, the share of the pot (`"75% do pote"`).
- Raise drawer: expands above the buttons (stays open while the viewer adjusts): presets as chip tokens coloured
  like real chips — **Mín.**, **2× BB**, **½ Pote**, **¾ Pote**, **Pote**, **All-In** — slider with tick marks at the
  presets, big amount display, −/+ steppers of one big blind, Enter confirms. All values clamped to
  `[minRaiseTo, maxRaiseTo]`, integers.
- Timer: slim bar across the top of the panel + seconds; warning colour under 10 s, pulsing under 5 s.
- **Pre-actions** while it is not the viewer's turn (and the viewer holds cards): mutually exclusive toggles
  "Check/Fold", "Check" and "Pagar qualquer". When the viewer's turn starts, the selected pre-action runs once if
  still meaningful (Check/Fold → check if possible else fold; Check → check only if possible, else just clear;
  Pagar qualquer → call if possible else check). Clear pre-actions at a new street, a new hand, and clear "Check"
  when the bet to call changes. Show which pre-action is armed.
- Accessibility: buttons ≥ 44 px, visible focus, `aria-live="assertive"` announcement "Sua vez" + toast-free
  status, keyboard shortcuts unchanged (F, C, R, A, Enter) and ignored while typing.
- Responsive: bottom sheet on narrow/portrait screens, docked bottom-right panel on wide landscape (keep).

### 3.2 Table callouts — `SeatPlates.ts` + new `src/client/ui/seatPlates.css`

Move the plate/bet-label/pot-label rules out of `styles.css` into `seatPlates.css` (imported by `SeatPlates.ts`).
New API:

```ts
showAction(seat: number, action: ActionType | 'smallBlind' | 'bigBlind', amount: number, totalBet: number): void;
```

A floating, colour-coded speech-badge above the plate (icon + verb + amount: "FOLD", "CHECK", "PAGA 40",
"APOSTA 120", "AUMENTA → 300", "ALL-IN 1.540", "SB 10", "BB 20"), pop-in spring animation, auto-hide after ~2.2 s
(a newer action replaces it). The persistent last-action pill uses the same colours. All-in players keep a glowing
"ALL-IN" badge until the hand ends. Acting plate: conic timer ring (exists) + animated "pensando…" dots for bots.
`flashWin` becomes a gold ribbon "VENCEDOR +2.400" with the hand name. Honour `prefers-reduced-motion`.

### 3.3 Judge panel, speech bubble, HUD

- `JudgePanel.ts`: move it to the **top-left** under the toolbar (compact, max-width ~380 px) so the 3D dealer at
  the top is visible; add a street progress indicator (Pré-flop · Flop · Turn · River · Showdown) and an icon/colour
  per narration tone. Its CSS moves to `src/client/ui/judgePanel.css`. On narrow screens it may stay full-width.
- New `src/client/ui/DealerBubble.ts`: `constructor(anchor: THREE.Object3D)`, `say(narration: Narration): void`,
  `clear(): void`, `dispose(): void` — a CSS2D glass speech bubble with a tail above the dealer's head showing the
  latest narration for ~3.5 s (max 2 lines, ellipsis), tone-coloured border.
- One shared `ManualPanel`: `main.ts` creates it once with `document.getElementById('overlay-root')` (a new layer
  in `index.html` above the lobby; `menuKit.css` gives `#overlay-root` `position: fixed; inset: 0; z-index: 40;
  pointer-events: none`), calls `manual.bindShortcut()`, passes it to the HUD as a 4th constructor argument
  `new Hud(root, callbacks, audio, manual)` and to the lobby with `lobby.setManual(manual)`.
- `Hud.ts`: toolbar gains "📖 Manual" (`manual.createOpenButton()`), calls `manual.highlightHand(state.self.handName)`
  on render; clicking the "Você tem: …" hand chip opens `manual.open('ranking')`.
- `GameClient.ts`: deps gain optional `bubble?: DealerBubble` (call `bubble.say(narration)` with each narration).
- `TableView.ts` deps gain optional `dealer?: Dealer` — when present, hole/community cards fly from
  `dealer.handWorldPosition('right')`, `gestureDeal` per card, `gestureCollect` on collect, `gesturePush` toward the
  winner on award, `lookAt` the acting seat's plate on turn (the viewer's cards when it is the viewer's turn),
  `nod` on checks. TableView also calls `plates.showAction(...)` for every `blind` and `action` event.

### 3.4 Menus — "Clube de cartas" design system (frontend-design skill)

Subject: a private card club opening its table on the home network. Audience: friends on the same Wi-Fi, on
laptops and phones. Primary job of the lobby: choose your name and chip and sit down in seconds, then invite others.

The previous menus used the generic template look (centred letter-spaced serif title, ALL-CAPS labels, near-black
blurred glass + gold). Replace it with materials from the card room itself:

| Token | Hex | Role |
|---|---|---|
| Rail leather | `#1A120D` | panel base (the brown-black leather of the table rail, not a neutral black) |
| Baize | `#155E43` | selection, positive states (the felt) |
| Brass | `#C9A35C` | stitching lines, focus rings, primary CTA |
| Card ivory | `#EEE4CF` | primary text on dark, chip inlays |
| Lacquer red | `#B8402F` | danger, destructive confirmations |
| Smoke | `#8E8577` | secondary text |

- **Type**: `Big Shoulders Display` (700/800, the condensed signage of old card rooms) for the brand, panel titles
  and big numbers; `Barlow` (400/500/600) for all UI text, with tabular figures for chip counts. Both are bundled
  locally through `@fontsource` (the LAN may be offline) and declared once in `menuKit.css` as
  `--font-display` / `--font-ui`; the rest of the HUD inherits `--font-ui`. Sentence-case labels only: no ALL-CAPS
  labels, no letter-spaced eyebrows, no middle-dot meta strings, no em-dash label patterns, no "→" in buttons.
- **Surfaces**: leather panels with a brass stitching line (a dashed inner outline 6 px inside the edge), radius
  that varies with hierarchy (panels 18 px, controls 10 px, chips round), solid colours instead of blur glass, no
  gradient washes. Selected options sit on baize green with an ivory check.
- **Controls** (`menuKit.ts` helpers + `menuKit.css`): chip-token segmented selectors for ≤ 6 options (round tokens
  with edge stripes, the selected one raised on baize), brass toggle switches, range sliders with a brass thumb and
  the live value, primary CTA in brass with dark text, danger buttons in lacquer red with an inline confirm step,
  44 px touch targets, `:focus-visible` brass rings, 8 px spacing grid.
- **Motion**: only in answer to the player (the lobby chip flips when colour/avatar changes, panels open/close);
  no ambient entrance animations; everything off under `prefers-reduced-motion`.
- **Alignment**: left-aligned text everywhere; only the chip preview is centred.

Keep every public constructor/method that `Hud.ts` and `main.ts` already use (additions are fine).

**Lobby layout** — the one bold element is **your chip**: a large 3D-looking casino chip (CSS/SVG) in the chosen
colour with edge stripes, the avatar in the centre inlay and the player's name engraved around the rim (SVG
`textPath`), updating live.

```
≥ 1024 px (the orbiting 3D table stays visible on the right)
┌───────────────────────────────┐
│ MESA REAL (condensed, left)   │
│ Texas Hold'em entre amigos…   │
│ ┌ leather panel 440 px ─────┐ │        3D table (lobby orbit)
│ │ [ YOUR CHIP ]  name field │ │
│ │ colour chips              │ │
│ │ avatar grid 6×2           │ │
│ │ [ Sentar à mesa ]         │ │
│ │ table status line         │ │
│ └───────────────────────────┘ │
│ invite card (compact)         │
└───────────────────────────────┘

< 640 px or short screens
┌──────────────────────┐
│ MESA REAL            │
│   [ chip 112 px ]    │
│ name / colour / 6×2  │
│ ▸ Chamar amigos (2)  │  ← disclosure, collapsed
├──────────────────────┤
│ [ Sentar à mesa ]    │  ← sticky bottom bar with safe-area padding
└──────────────────────┘
```
The lobby never needs page scrolling on a 1366 × 768 screen; on phones only the form scrolls while the CTA stays
visible. Heights < 700 px shrink the chip and spacing. Copy (PT-BR, plain): title "Mesa Real", subtitle "Texas
Hold'em entre amigos, na sua rede", field "Seu nome na mesa", CTA "Sentar à mesa", status e.g. "3 de 8 lugares
ocupados, partida em andamento", invite "Chamar amigos" with "Abra este endereço em outro aparelho no mesmo Wi-Fi".

**Manual** (`src/client/manual/manual.css`, already built with `ManualPanel`): restyle it with the same tokens and
fonts (leather sheet with brass stitching, baize tabs) without changing its class names or behaviour. It must be
open above the lobby: it lives in `#overlay-root` (see §3.3).

**Sala de espera**: a mini top-down oval table drawn in SVG with 8 seat dots in the players' colours (empty seats
dim) as the header visual, then the roster, chip-token selectors for blinds / fichas / tempo, + Bot / − Bot and the
brass "Iniciar partida" CTA. **Configurações**: a leather tray popover with grouped rows (Som, Narração do Juiz,
Imagem, Mesa). **Registro do Juiz**: a dealer's ledger — hand separators, tone-coloured markers, results with mini
cards; restrained, no newspaper-style rules.

- **Sala de espera (`HostPanel.ts`)**: header "Sala de Espera" with 8 seat dots filled in the players' colours and
  a mini roster (avatar, name, "BOT" tag); config as chip selectors — Blinds (5/10, 10/20, 25/50, 50/100 drawn as
  two mini chips), Fichas iniciais (1K, 2K, 5K, 10K with an "= N BB" hint), Tempo (15/30/45/60 s with a stopwatch
  icon); combinations the server's `resolveStartConfig` rejects are disabled with an explanation; "+ Bot" / "− Bot"
  with avatars; big "Iniciar Partida" CTA with a helper line when fewer than 2 players. Running mode keeps a compact
  pill with + Bot / − Bot.
- **Configurações (`SettingsPanel.ts`)**: popover from the gear (Esc / outside click close, focus management),
  sections Áudio (volume slider with value, Efeitos / Ambiente toggles), Narração do Juiz (Completa / Essencial /
  Desligada segmented, voice select with a "Testar voz" button that speaks a short sample, speed slider), Visual
  (Qualidade Alta / Baixa segmented, felt colour swatches with names), Mesa ("Sair da mesa" danger button with an
  inline confirm).
- **Lobby (`Lobby.ts`)**: brand header with a crest, live preview card of the player's seat (avatar in the chosen
  colour ring + name), name input with counter, colour swatches with check marks, avatar grid with hover lift,
  primary CTA, table status line from `setTableInfo`, LAN invite box with copy buttons and "Copiado!" feedback, a
  "Como jogar?" link opening the manual. New methods: `setManual(manual: ManualPanel): void` and
  `setTableInfo(info: { seated: number; maxSeats: number; running: boolean; handNumber: number }): void`.
- **Registro do Juiz (`LogPanel.ts`)**: segmented tabs Juiz / Mãos; Juiz = timeline with tone-coloured dots and
  icons, monospace times, separators per hand ("Mão #12"), filter chips Tudo / Jogadas / Resultados; Mãos = cards
  with hand number, board as mini cards from the card atlas (shared helper `src/client/ui/miniCard.ts`, reuse the
  manual's renderer if it exports one), winners with colour dot, amount and hand name; unread badge; smooth
  collapse.

## 4. File ownership (round 2)

| Agent | Files |
|---|---|
| dealer | `src/client/scene/Dealer.ts` (new), `SeatLayout.ts`, `TableModel.ts`, `Stage.ts`, `FeltTexture.ts`, `TableView.ts`, `src/client/main.ts` |
| actions | `src/client/ui/ActionBar.ts`, `src/client/ui/actionBar.css` (new), the action-bar rules in `styles.css` |
| hud | `src/client/ui/SeatPlates.ts`, `seatPlates.css` (new), `JudgePanel.ts`, `judgePanel.css` (new), `Hud.ts`, `DealerBubble.ts` (new), `src/client/GameClient.ts`, the plate/judge rules in `styles.css` |
| menus | `src/client/manual/manual.css` (restyle only, keep class names), `src/client/ui/HostPanel.ts`, `SettingsPanel.ts`, `Lobby.ts`, `LogPanel.ts`, `menuKit.ts` + `menuKit.css` (new), `miniCard.ts` (new), `hostPanel.css` / `settingsPanel.css` / `lobby.css` / `logPanel.css` (new), the matching rules in `styles.css` |

`styles.css` is shared: re-read it immediately before every edit, use exact-match edits on your own blocks only,
retry after a concurrent-modification failure. `main.ts` (dealer agent) must: load the dealer in parallel with the
other assets (progress bar), add `dealer.root` to `stage.tableRoot`, call `dealer.update` from `stage.onFrame`,
create `new DealerBubble(dealer.speechAnchor)`, pass `dealer` to `TableView` and `bubble` to `GameClient`, call
`lobby.setManual(manual)`, feed `lobby.setTableInfo(...)` from every update while the lobby is visible, and wire
reduced motion to the dealer too.

## 5. Camera

The default game framing must keep the dealer's head and shoulders on screen on wide landscape screens (add the
dealer's head point to the framing constraints) while the table stays as large as possible; reduce the bottom
reserve on wide landscape (the action bar is docked to the right there). User zoom keeps working. Portrait framing
keeps all plates visible; the dealer may be partially cropped in portrait.

## 6. Visual verification (dealer agent mandatory, others optional)

Run an isolated dev server: `PORT=3200 npx tsx src/server/index.ts --dev` (background; stop it when done) and the
headless capture script
`node C:\Users\admin\AppData\Local\Temp\claude\0b4eed0b7a27cf1e\9ba0be0e-06da-4cc3-9754-c6fa20ff59df\scratchpad\qa\visual-qa.mjs http://localhost:3200 <outDir> 1366 768 <shots> <intervalMs> 1`
(it joins as "QA Visual", adds 5 bots, starts, presses C on its turns and saves PNGs you can open with Read). Use
another port (3300/3400) if you are not the dealer agent. Never use port 3000.


## 7. Stable QA hooks (all agents)

The headless QA script drives the UI through these attributes; keep them on the elements whatever the copy says:
`data-qa="name-input"` (lobby name field), `data-qa="join"` (lobby CTA), `data-qa="add-bot"` / `data-qa="remove-bot"`
(both the waiting-room and the compact running-mode buttons), `data-qa="start"` (start-game CTA),
`data-qa="manual-open"` (manual buttons). The action bar root keeps the class `action-bar` and the attribute
`data-turn="mine" | "other"`; keyboard shortcuts stay F / C / R / A / Enter on `document` keydown.

## 8. Fonts

`@fontsource/big-shoulders-display` and `@fontsource/barlow` (5.3.0) are installed as dev dependencies. Import only
the weights you use, once, from `menuKit.css` (`@import '@fontsource/barlow/400.css';` etc. — Vite resolves and
bundles the woff2 files, so the game works offline on the LAN). The rest of the HUD switches to `--font-ui`.

## 9. Test ownership (round 2)

dealer: `tests/stageFraming.test.ts`, `tests/tableView.test.ts`, new `tests/dealerLayout.test.ts` (ring positions,
no overlaps). actions: `tests/actionBar.test.ts` (pre-actions, presets, lock/unlock). hud: `tests/gameClient.test.ts`,
new tests for `showAction` labels if pure helpers exist. menus: `tests/hostPanel.test.ts`, `tests/logPanel.test.ts`,
`tests/manualContent.test.ts` (only if a renamed label requires it). Keep every existing test green; run the full
suite (`npx vitest run`) before finishing — failures in another agent's files mid-edit can be ignored if unrelated.

## 10. Open issues from the previous review (fold into your redesign)

- actions: the action lock must be released only by (a) a new decision (turn/legal actions changed), (b) a
  `table:error` that answers the player's own action, or (c) a 3 s safety timeout — never by unrelated error toasts
  such as "Reconectando…". A pressed shortcut must never be applied to a later turn. Cover lock/release with tests
  on extracted pure helpers.
- dealer (Stage framing): the bottom reserve must include `env(safe-area-inset-bottom)` (read the computed value of a
  probe element) and only apply when the action bar is actually shown in that layout; far-side plates (as boxes,
  not table corners) must clear the top HUD band; derive test constants from the exported layout values instead of
  repeating literals in `tests/stageFraming.test.ts`.
- menus: LogPanel currently starts closed on every screen; open it by default only on screens ≥ 1600 px wide where
  it covers no plate.
