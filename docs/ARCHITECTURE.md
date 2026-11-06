# Mesa Real — Texas Hold'em LAN · Architecture & module contracts

This document is the single source of truth for every module. Implement exactly the public APIs below
(names, signatures, units). Private helpers are free. If a contract is impossible, keep the closest
compatible API and explain the deviation in your final report.

## 0. Ground rules

- Project root: `C:\Users\admin\Desktop\poker-lan`. Node 24, TypeScript `strict`, ESM, **imports without file
  extensions** (bundler resolution; the server runs through `tsx`).
- Shell: in Git Bash always prefix commands with
  `export PATH="/c/Program Files/nodejs:/usr/bin:/c/Windows/system32:/c/Windows" &&` (the default PATH is too
  long for cmd.exe and `npx` fails without this).
  - Typecheck: `npx tsc --noEmit -p tsconfig.json` (other agents write files in parallel: only fix errors in
    the files you own; "Cannot find module" for a module owned by someone else is expected while they work).
  - Tests: `npx vitest run tests/<file>.test.ts`.
- Edit **only the files you own** (section 1). Never edit `src/shared/*` — read them:
  `src/shared/cards.ts`, `src/shared/handEvaluator.ts`, `src/shared/protocol.ts`, `src/shared/format.ts`.
- Dependencies available (do not add others): `three@0.170` (+ `three/examples/jsm/...`), `gsap@3`,
  `socket.io@4`, `socket.io-client@4`, `express@4`, `vitest@3`.
- Complete, working code. No `TODO`, no placeholders, no stubbed branches. UI text in **PT-BR**, code in English.
  Comment only the non-obvious "why".
- Never build DOM from untrusted strings with `innerHTML` (player names come from other players): use
  `textContent` / `document.createElement`.
- Do not start servers on port 3000 and do not use the browser pane (the orchestrator does visual QA).
  Server smoke tests, if any, use `PORT=3100` and must be stopped afterwards.
- Money values are integer chips. Format with `formatChips()` from `src/shared/format.ts` ("2.400").

## 1. File ownership

| Owner | Files |
|---|---|
| engine | `src/server/game/Deck.ts`, `src/server/game/pots.ts`, `src/server/game/TableEngine.ts`, `tests/pots.test.ts`, `tests/tableEngine.test.ts` |
| bot | `src/server/game/BotBrain.ts`, `tests/botBrain.test.ts` |
| controller | `src/server/game/GameController.ts`, `src/server/game/narration.ts`, `src/server/index.ts`, `src/server/lan.ts`, `tests/narration.test.ts` |
| evaluator-tests | `tests/handEvaluator.test.ts` (may fix bugs in `src/shared/handEvaluator.ts` — the only exception to the shared rule) |
| scene | `src/client/scene/Stage.ts`, `src/client/scene/SeatLayout.ts`, `src/client/scene/TableModel.ts`, `src/client/scene/FeltTexture.ts`, `src/client/scene/proceduralTextures.ts` |
| props | `src/client/scene/CardFactory.ts`, `src/client/scene/ChipFactory.ts`, `src/client/scene/TableButtons.ts` |
| animator | `src/client/scene/TableView.ts` |
| audio | `src/client/audio/AudioManager.ts`, `src/client/audio/synth.ts` |
| ui | `src/client/ui/*.ts`, `src/client/styles.css` |
| app | `src/client/main.ts`, `src/client/net/Connection.ts`, `src/client/GameClient.ts` |
| docs | `README.md`, `start-windows.bat` |

## 2. Shared contracts (already written — read them)

- `cards.ts`: `Card` = `"As" | "Td" | ...` (rank chars `23456789TJQKA`, suits `c d h s`), `rankValue`, `suitOf`,
  `createOrderedDeck`, `cardLabel` ("A♠"), `cardSpeech` ("Ás de Espadas"), `rankName`, `isCard`.
- `handEvaluator.ts`: `evaluateHand(cards 5..7) → HandResult {category, score, bestFive, name}`,
  `compareHands`, `describeStartingHand`, `HandCategory`, `CATEGORY_NAMES`.
- `protocol.ts`: wire types (`TableView`, `SeatView`, `GameEvent`, `TableUpdate`, `Narration`, `LegalActions`,
  `PlayerActionRequest`, socket event maps, `MAX_SEATS = 8`, `DEFAULT_CONFIG`, `PLAYER_COLORS`, `PLAYER_AVATARS`).

Seat indices are `0..7`, **clockwise** = increasing index. Action always moves to the next higher seat index
(wrapping). The client rotates the view so the viewer's seat is drawn at the bottom-center slot.

## 3. Server

### 3.1 `Deck.ts`

```ts
export function shuffledDeck(randomInt?: (maxExclusive: number) => number): Card[];
```
Fisher–Yates over `createOrderedDeck()`. Default `randomInt` = `crypto.randomInt` (node:crypto).

### 3.2 `pots.ts`

```ts
export interface ContributionEntry { seat: number; contribution: number; folded: boolean }
export interface Pot { amount: number; eligibleSeats: number[] } // eligibleSeats sorted ascending
export function buildPots(entries: ContributionEntry[]): Pot[];
export function splitPot(amount: number, winnersInPayoutOrder: number[]): Map<number, number>;
```
`buildPots`: levels = sorted distinct contributions of non-folded players (>0); if the max contribution of
anyone exceeds the top live level, add it as a final level (dead money). For each level, pot amount =
Σ over ALL entries of `max(0, min(contribution, level) - previousLevel)`; eligible = non-folded with
`contribution >= level`. A slice with no eligible player merges into the previous pot. Consecutive pots with
identical eligible sets merge. Zero-amount pots are dropped.
`splitPot`: equal integer shares; the odd chips go one by one to winners in the given order.

### 3.3 `TableEngine.ts` — pure No-Limit Hold'em rules (no timers, no I/O)

```ts
import type { ActionType, LegalActions, PlayerActionRequest, Street } from '../../shared/protocol';
export class EngineError extends Error {}
export interface EngineConfig { smallBlind: number; bigBlind: number }
export interface EnginePlayerState {
  seat: number; playerId: string; chips: number; streetBet: number; contribution: number;
  holeCards: Card[]; inHand: boolean; folded: boolean; allIn: boolean; sittingOut: boolean;
}
export interface HandStartResult {
  handNumber: number; dealerSeat: number; smallBlindSeat: number; bigBlindSeat: number;
  blinds: { seat: number; amount: number; blind: 'small' | 'big' }[];
  dealOrder: number[]; // seats receiving cards, starting left of the dealer; each gets 2 cards (2 rounds)
}
export interface ActionResult {
  seat: number; action: ActionType; amount: number; totalBet: number; allIn: boolean;
  roundComplete: boolean; handComplete: boolean; nextActor: number | null;
}
export interface CollectResult { returned: { seat: number; amount: number }[]; pots: Pot[]; collected: number }
export interface AwardWinner { seat: number; amount: number; hand: HandResult | null }
export interface Award { potIndex: number; amount: number; winners: AwardWinner[] }
export interface SettleResult { showdown: boolean; awards: Award[]; hands: Map<number, HandResult> }

export class TableEngine {
  constructor(config: EngineConfig, deckFactory?: () => Card[]);
  setConfig(config: EngineConfig): void;            // throws if a hand is in progress
  seatPlayer(seat: number, playerId: string, chips: number): void;
  removePlayer(seat: number): void;                 // throws if seat is in the hand and not folded
  addChips(seat: number, amount: number): void;     // rebuys; throws during a hand for that seat
  setSittingOut(seat: number, sittingOut: boolean): void;
  getPlayer(seat: number): EnginePlayerState | null;  // defensive copies
  getPlayers(): EnginePlayerState[];
  get handNumber(): number; get street(): Street; get dealerSeat(): number | null;
  get smallBlindSeat(): number | null; get bigBlindSeat(): number | null;
  get community(): Card[]; get currentBet(): number; get actingSeat(): number | null;
  get pots(): Pot[];                                 // collected pots only
  isHandInProgress(): boolean;
  eligibleSeats(): number[];                        // seated, chips > 0, not sitting out
  canStartHand(): boolean;                          // >= 2 eligible and no hand in progress
  startHand(): HandStartResult;                     // posts blinds, deals, sets actingSeat (may be null)
  getLegalActions(seat: number): LegalActions | null; // null unless seat === actingSeat
  act(seat: number, request: PlayerActionRequest): ActionResult; // throws EngineError if illegal
  foldOutOfTurn(seat: number): { handComplete: boolean; roundComplete: boolean; nextActor: number | null };
  beginBettingRound(): number | null;               // after dealNextStreet(): first actor or null
  collectBets(): CollectResult;                     // returns uncalled bet, moves street bets to pots
  dealNextStreet(): { street: 'flop' | 'turn' | 'river'; cards: Card[] };
  nonFoldedSeats(): number[];
  isAllInRunout(): boolean;                         // >= 2 non-folded and <= 1 of them can still act
  totalPot(): number;                               // collected pots + all street bets
  settle(): SettleResult;                           // pays pots (call after collectBets)
  endHand(): number[];                              // street -> 'idle'; returns seats left with 0 chips
}
```

Rules (all must be covered by `tests/tableEngine.test.ts`, using an injected deck for determinism):
- **Button**: first hand → dealer = lowest eligible seat. Next hands: next eligible seat clockwise after the
  previous dealer. **Heads-up**: dealer posts the small blind and acts
  first preflop, last postflop. 3+ players: SB = next eligible after dealer, BB = next eligible after SB.
- **Blinds**: post `min(chips, blind)`; a player reaching 0 chips is all-in. `currentBet` starts at the
  nominal big blind even if the BB is short. `minRaise` (last full raise increment) starts at `bigBlind`.
- **Dealing**: burn cards are not required. Two rounds, one card each, in `dealOrder`.
- **needsToAct(p)** = inHand && !folded && !allIn && (!hasActed || streetBet < currentBet).
- **Preflop first actor**: first seat after the BB that needs to act (heads-up: the dealer). The BB has the
  option (hasActed=false). Postflop: first seat after the dealer that needs to act, only when at least 2
  players can act (not folded, not all-in); otherwise no betting round (`beginBettingRound` → null).
- **Legal actions** for the acting player p (toCall = currentBet − p.streetBet):
  `canFold` true; `canCheck` = toCall == 0; `canCall` = toCall > 0; `callAmount` = min(toCall, chips);
  `maxRaiseTo` = p.streetBet + p.chips; `canRaise` = maxRaiseTo > currentBet && some other non-folded
  player is not all-in && reopen rule passes; `minRaiseTo` = min(currentBet + minRaise, maxRaiseTo)
  (when currentBet is 0: min(bigBlind, maxRaiseTo)); `isOpeningBet` = currentBet == 0.
- **Reopen rule**: p may raise if p has not acted this street, or `currentBet − p.lastActionLevel >= minRaise`
  (a short all-in raise does not reopen the action to players who already acted; they may only call/fold).
- **act()**: `fold`; `check` (only if canCheck); `call` (moves callAmount; all-in if chips hit 0);
  `raise` with `amount` = raise-to total in `[minRaiseTo, maxRaiseTo]` (integer). If `amount - currentBet >=
  minRaise` it is a full raise and `minRaise = amount - currentBet`. Every raise resets `hasActed=false` for
  the other players who can still act. `allIn`: if canRaise and streetBet+chips > currentBet → raise to
  maxRaiseTo (short raises allowed only as all-in); otherwise it is a call of min(toCall, chips).
  The reported `action` is `bet` for a raise when `isOpeningBet`, `raise` otherwise, `allIn` when the player
  ends with 0 chips (even when calling). After acting: hasActed = true, lastActionLevel = currentBet.
  `handComplete` when only one non-folded player remains; `roundComplete` when nobody needs to act.
- **foldOutOfTurn(seat)**: used when a player leaves; folds them immediately and recomputes completion.
- **collectBets()**: if exactly one player has the highest street bet and it exceeds the second highest,
  return the difference to them (uncalled bet; reflected in `returned` and in contribution). Then street
  bets → 0, pots rebuilt with `buildPots` from total contributions, `currentBet = 0`, `minRaise = bigBlind`,
  `hasActed = false`, `lastActionLevel = null`.
- **settle()**: one non-folded player → wins every pot, `showdown=false`, `hand=null`. Otherwise requires 5
  community cards; evaluates each non-folded hand (`evaluateHand(hole + board)`); each pot goes to the best
  eligible score(s); split with `splitPot`, odd chips ordered from the first seat clockwise after the dealer.
  Chips are credited to the players.
- `endHand()` clears per-hand flags (keeps chips), sets street `idle`, returns busted seats.

### 3.4 `BotBrain.ts` and `bots/*` — the bots

```ts
export interface BotPersonality {
  name: string; style: string; // PT-BR, e.g. { name: 'Bia', style: 'Agressiva', ... }
  aggression: number; looseness: number; bluff: number; // 0..1: style
  skill: number;      // 0..1: reading sharpness, simulation depth, how little it drifts from the best play
  adaptation: number; // 0..1: how fast observed habits replace the population prior
}
export const BOT_PERSONALITIES: BotPersonality[]; // 8 entries
export interface BotContext {
  holeCards: Card[]; community: Card[]; street: Street;
  chips: number; streetBet: number; currentBet: number; pot: number; // pot = totalPot() incl. street bets
  legal: LegalActions; bigBlind: number; opponents: number; // non-folded opponents
  personality: BotPersonality;
  table?: PublicHandView; // public view of this hand and of every player's history; absent = no reads
}
export function estimateEquity(holeCards: Card[], community: Card[], opponents: number, iterations: number, random?: () => number): number; // 0..1, Monte Carlo vs random hands
export function chenScore(holeCards: Card[]): number;
export function decideBotAction(context: BotContext, random?: () => number): PlayerActionRequest; // always legal
export function botThinkTimeMs(context: BotContext, random?: () => number): number; // 700..2600, reads only the price
```

Modules in `src/server/game/bots/` (the brain never imports `TableEngine`, the deck or server state):
- `publicInfo.ts` — the only data a bot may see: `PublicHandView`, `PublicSeat`, `PublicAction`,
  `PlayerStatCounts` (counts only; no type here can carry hidden cards). `publicContext.ts` builds a
  `BotContext` from a read-only engine source, copying seats field by field.
- `TableMemory.ts` (`BotTableMemory`) + `handStats.ts` — per-player statistics kept from public events.
- `opponentModel.ts` — smooths the counts with `POPULATION_PRIORS` into `PlayerTendencies` (VPIP, PFR, 3-bet,
  fold to c-bet / bet / bet after calling / bet with the initiative / raise, barrel, shown bluff shares...).
- `positions.ts` (positions and `STANDARD_OPEN_WIDTH`), `preflopChart.ts`, `preflopStrategy.ts`.
- `handReading.ts` — a weighted range of 1326 combos per opponent, narrowed by each public action. Weak
  combos get the share of a bet that the player's showdowns suggest (c-bets follow the c-bet frequency).
- `rangeEquity.ts` + `fastEvaluator.ts` + `boardStrength.ts` — weighted Monte Carlo against those ranges
  (300 + 400 × skill samples, fewer beyond four players so the cost stays flat).
- `foldModel.ts` — how often each opponent folds to a bet: the share of its range that cannot beat enough of
  the bettor's public image, shifted in log-odds by its observed fold rate for that kind of spot and capped at
  1.15 × that rate. `actionValues.ts` scores fold / call-check / bet-raise in one simulation and picks with a
  softmax whose temperature is the personality's discipline.
- `postflopStrategy.ts`, `sizing.ts` (sizes depend on the spot and opponents, never on the bot's cards),
  `intents.ts` (fits the wanted action to the legal ones), `styles.ts` (personality → habits: open width, call
  slack, aggression bias for honest bets, required edge for pure bluffs, overbet and float appetite...).

`BotTableMemory` contract (fed only by `GameController`, with what the whole table saw):
`beginHand(describeHandStart(...))` at hand start; `recordAction(actionFactsOf(street, result))` after every
applied action and the fold of a player who leaves; `recordShowdown(hands)` only from `revealHands` (showdown or
all-in runout, the hands every client receives in the `reveal` event); `finishHand(board, showdown)` when pots are
awarded; `forgetPlayer(id)` when a profile is discarded; `reset()` on `table:start`. Hands won without a
showdown and folded hands never reach it; revealed cards only become counts (shown bluffs, thin value bets).
`viewFor(heroSeat, seats)` returns the `PublicHandView` placed in `BotContext.table`.

Rules: never folds when it can check; raise amounts are integers clamped to `[minRaiseTo, maxRaiseTo]`; all-in
when the raise would commit > 70 % of the stack; a decision must finish well under 40 ms.

### 3.5 `narration.ts` — PT-BR texts of the Judge

Pure functions returning `Narration` (see protocol). Required builders:
```ts
export function narrateHandStart(handNumber: number, dealerName: string, smallBlind: number, bigBlind: number): Narration;
export function narrateBlind(name: string, amount: number, blind: 'small' | 'big'): Narration;
export function narrateDeal(): Narration;
export function narrateAction(name: string, action: ActionType, amount: number, totalBet: number, timedOut: boolean): Narration;
export function narrateStreet(street: 'flop' | 'turn' | 'river', cards: Card[], board: Card[]): Narration;
export function narrateReveal(allIn: boolean): Narration;
export function narrateAward(award: { amount: number; winners: { name: string; amount: number; handName: string | null }[] }, potLabel: string, showdown: boolean): Narration;
export function narrateJoin(name: string): Narration; export function narrateLeave(name: string): Narration;
export function narrateRebuy(name: string, amount: number): Narration; export function narrateBust(name: string): Narration;
export function narrateWaiting(): Narration; export function narrateGameStart(config: TableConfig): Narration;
```
Examples (text): "Mão #12 — Dealer: Ana · Blinds 10/20", "Ana posta o small blind de 10.",
"Bruno aumenta para 300.", "ALL-IN! Carla empurra 1.540 fichas!", "Tempo esgotado! O Juiz aplica check
automático para Davi.", "Cartas na mesa: Flop! A♠ K♦ 7♣" (speech: "Flop: Ás de Espadas, Rei de Ouros, Sete de
Paus"), "Showdown! Bruno vence o pote de 2.400 com Full House de Ases e Reis!", "Pote dividido! Ana e Bruno
dividem 1.200 com Sequência até o Dez.", "Ana vence o pote de 300 sem showdown.". Tones: action, street,
win, warn (timeouts, busts), alert (all-in), info. Priority 1 for streets/all-ins/results/timeouts/hand start,
2 for checks/calls/folds/blinds/joins.

### 3.6 `GameController.ts`

```ts
export class GameController {
  constructor(io: Server<ClientToServerEvents, ServerToClientEvents>, options: { lanUrls: string[] });
  attach(): void;   // registers io.on('connection')
  shutdown(): void; // clears timers
}
```
Responsibilities (the authoritative "Judge/Dealer"):
- **Profiles**: `{ id, token, name, color, avatar, isBot, personality?, seat, socketId, connected,
  disconnectedAt, leaving }`. Max 8 seated; extra joiners become spectators (receive views, cannot act).
- **Join** (`table:join` with ack): validate & sanitize (name trimmed, 1–16 chars, control chars removed,
  unique — append " 2" etc.; color ∈ PLAYER_COLORS else first; avatar ∈ PLAYER_AVATARS else first;
  token `/^[\w-]{8,64}$/`). Same token → reclaim the existing profile/seat (reconnect). Seat choice: first free
  in order `[0, 4, 2, 6, 1, 5, 3, 7]`. New player chips = `config.startingStack`; seated mid-hand → sits out
  until the next hand. Emit `table:backlog` (last 60 log entries, last 20 hand summaries) to the joiner, then
  broadcast `playerJoined` with `narrateJoin`.
- **Host controls** (any seated human may use them): `table:addBot` (bot with the next unused personality,
  an avatar and colour not in use from PLAYER_AVATARS/PLAYER_COLORS, name = personality name + " (Bot)"),
  `table:removeBot`
  (removes the most recently added bot; if it is in a hand it folds/leaves after the hand), `table:start`
  (only in `lobby` phase; validates config: smallBlind integer 1..10000, bigBlind integer smallBlind..2×10000
  default 2×SB, startingStack 20×BB..1 000 000, turnSeconds 10..120; switches to `running`, narrates game start,
  starts the first hand when ≥2 eligible). `table:rebuy` (busted human, between hands or folded/not in hand:
  adds startingStack). `table:leave` (marks leaving; folds now via `foldOutOfTurn` or immediate fold if acting;
  removed after the hand ends; spectator socket simply detaches).
- **Hand loop** with these pacing constants (ms): `NEXT_HAND_DELAY 1800`, `BLIND_GAP 550`,
  dealing wait `500 + dealOrder.length * 2 * 150 + 500`, `ACTION_GAP 450`, `ROUND_END_DELAY 650`,
  `COLLECT_DURATION 900`, street wait `{flop:1700, turn:1250, river:1250}`, all-in runout: reveal wait 2200 and
  each street 2400, showdown reveal → award 2400, award → handEnd 4800 (uncontested 2600).
  Sequence: `handStart` → `blind` small → `blind` big → `dealHole` → betting rounds (`turn` / `action` …) →
  `collect` → `community` … → showdown (`reveal` → `award`) → `handEnd` (with `HandSummary`) → busted players:
  bots auto-rebuy at the next hand start (`rebuy` event + narration), humans see the rebuy button → next hand
  if ≥2 eligible, else stay idle narrating "Aguardando jogadores…". Uncontested pots: `collect` → `award`
  (showdown=false) → `handEnd`. When betting is impossible (all-in runout): `reveal` (allIn=true) of all
  non-folded hands BEFORE dealing the remaining streets.
- **Turns**: on each actor, emit `turn` with `deadline = now + turnSeconds*1000` (disconnected humans:
  8000 ms; `leaving` players fold immediately). Timeout → auto `check` if legal else `fold`, `timedOut=true`.
  Bots act after `botThinkTimeMs`. Every timer handle is tracked and cleared on transitions (no double acts:
  verify `actingSeat` and a per-turn token before applying delayed actions).
- **Actions** (`table:action`): accept only from the acting seat's socket; validate the shape (`type` in the
  allowed set, `amount` finite integer when present); EngineError → emit `table:error` to that socket only.
- **Disconnect**: profile.connected=false, disconnectedAt=now. Humans disconnected > 120 s are removed after
  the current hand. At hand start, disconnected humans sit out.
- **Views**: every broadcast sends one `TableUpdate` per socket with a personalised `TableView`
  (`self.legal` only for the acting viewer; `cards` of others only after `reveal`; `self.handName` =
  `evaluateHand(hole+board).name` with ≥3 board cards, else `describeStartingHand(hole)`). `seq` increments
  per broadcast. `SeatView.lastAction` labels (PT-BR): "SB", "BB", "Check", "Pagou 40", "Apostou 100",
  "Aumentou p/ 300", "All-In", "Fold"; cleared on `collect` except Fold/All-In; all cleared at hand start.
  `status`: active/folded/allIn/sittingOut/busted/waiting.
- Keep `log` (last 60 narrations) and `hands` (last 20 summaries) for the backlog.
- Rate-limit each socket to 30 messages / 2 s (drop extra).

### 3.7 `lan.ts` and `index.ts`

- `getLanAddresses(): string[]` — non-internal IPv4, private ranges first (192.168, 10., 172.16–31), adapters
  whose name matches /vEthernet|WSL|VirtualBox|VMware|Docker|Hyper-V|Loopback|Bluetooth/i last.
- `index.ts`: express + `http.createServer` + socket.io (`cors` not needed). `--dev` flag → Vite in middleware
  mode (`createServer({ server: { middlewareMode: true }, appType: 'spa' })`, dynamic import); otherwise
  serve `dist/client` statically with SPA fallback (if `dist/client/index.html` is missing, print a clear error
  telling to run `npm run build`). `GET /api/health` → `{ ok: true }`. Listen on `0.0.0.0:${PORT || 3000}`.
  Banner (PT-BR) listing `http://localhost:PORT` and every LAN URL. SIGINT/SIGTERM → controller.shutdown().

## 4. Client (Three.js + GSAP, no framework)

World units = meters. Floor at y = 0. Felt surface y = `FELT_Y = 0.712`. Rail top ≈ 0.778.
The table's long axis is X (outer 2.88 m), short axis Z (outer 1.38 m). The viewer sits at +Z (bottom of
the screen), the far side is −Z. Visual style: private club at night — near-black room `#07080a`, warm
key light, gold accents `#e4b363`, felt default emerald.

### 4.1 `SeatLayout.ts`

```ts
export const FELT_Y = 0.712; export const RAIL_Y = 0.778; export const SEAT_SLOTS = 8;
export interface SeatAnchor {
  slot: number;
  yaw: number;            // rotation.y so an object's local +Z points from the table center to the seat
  plate: Vector3;         // name plate anchor (outside the rail, y = RAIL_Y + 0.02)
  cards: Vector3;         // hole cards center on the felt (0.20 m inside the felt edge)
  bet: Vector3;           // bet stack position (0.36 m inside the felt edge)
  button: Vector3;        // dealer/blind puck position: in front of the chip stack, 0.39 m inside the felt edge,
                          // 0.15 m along the ring from the cards (0.26 m for the viewer); heads-up the SB rests on the D
  stack: Vector3;         // the player's own chip stack: on the player's left of the cards, 0.225 m along the ring
                          // (0.30 m for the viewer), 0.22 m inside the felt edge — midway between the rail opening
                          // (0.145 m) and the gold betting line (0.295 m), so no chip of it reads as a bet
  stackYaw: number;       // rotation.y of the stack: local +Z along the felt's outward normal at the stack
  inward: Vector3;        // unit vector from the seat toward the table center (xz)
}
export function slotForSeat(seat: number, viewerSeat: number | null): number; // (seat - viewer + 8) % 8
export function seatForSlot(slot: number, viewerSeat: number | null): number;
export function getSeatAnchor(slot: number): SeatAnchor;
export const COMMUNITY_POSITIONS: Vector3[]; // 5, z = -0.08, x = (i - 2) * 0.145
export const POT_POSITION: Vector3;          // (0, FELT_Y, 0.075)
export const SIDE_POT_POSITIONS: Vector3[];  // up to 4 around the main pot: x ±0.2, ±0.4
export const DECK_POSITION: Vector3;         // (0.5, FELT_Y, -0.08)
export const MUCK_POSITION: Vector3;         // (-0.5, FELT_Y, -0.08)
export const HERO_CARD_OFFSETS: number[];    // x offsets of the viewer's two cards (±0.086)
export const HERO_CARD_LIFT = 0.035; export const HERO_CARD_TILT = 0.55; // radians toward the camera
export function stadiumPoint(t: number, halfLength: number, radius: number, centerZ?: number): { point: Vector3; normal: Vector3 }; // t in [0,1): 0 = +Z center, increasing toward -X (clockwise on screen)
```
Shapes: felt stadium halfLength 0.66, radius 0.635, centerZ −0.02; rail stadium halfLength 0.75, radius 0.69.
Current insets: cards 0.23 m, bets 0.40 m, plates 0.07 m outside the rail. The viewer's hand floats just above
rail height (scale 1.35) because the padded rail overhangs the felt near the viewer.
Slots at `t = slot / 8` (slot 0 bottom-center = viewer, slot 4 top-center). Plates: rail point pushed 0.16 m
outward. Card/bet/button points are measured along the inward normal from the felt edge.

### 4.2 `Stage.ts`

```ts
export type Quality = 'high' | 'low';
export class Stage {
  constructor(container: HTMLElement);
  readonly scene: THREE.Scene; readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer; readonly labelRenderer: CSS2DRenderer; // labels share the container
  readonly tableRoot: THREE.Group;
  setQuality(quality: Quality): void;              // pixel ratio, shadows map size, bloom on/off
  onFrame(callback: (deltaSeconds: number, elapsedSeconds: number) => void): () => void; // returns unsubscribe
  start(): void;
  setLobbyMode(enabled: boolean): void;            // slow cinematic orbit at a low angle (lamp visible)
  playIntro(): Promise<void>;                      // ~3 s GSAP fly from the orbit to the game pose
  shake(intensity?: number, duration?: number): void;           // default 0.015, 0.45 s
  dramaticZoom(target: THREE.Vector3, amount?: number, duration?: number): Promise<void>; // push in then return
  resetCamera(duration?: number): void;
  projectToScreen(point: THREE.Vector3): { x: number; y: number }; // CSS pixels
  setLampVisible(visible: boolean): void;          // forwarded to a registered lamp object
  registerLamp(lamp: THREE.Object3D | null): void;
  setUserZoom(value: number): void;                // 1 = whole table; down to 0.68 = close-up on the viewer's hand (wheel, pinch, dblclick resets)
  getUserZoom(): number;
  toggleCloseView(): void;                         // HUD "🔍 Zoom" button
}
```
Renderer: antialias, `SRGBColorSpace`, `ACESFilmicToneMapping` (exposure 1.05 with the studio environment, 1.5 with
the card room), shadows `PCFSoftShadowMap`, pixel ratio ≤ 2 (low: 1). Environment: `RoomEnvironment` through
`PMREMGenerator` (`scene.environmentIntensity` 0.35) until `setEnvironment(texture, intensity?, exposure?)` swaps in
the card room's prefiltered warm bar HDR (intensity 1.6) and turns the fill and rim neutral (sky `#8c8a86` 0.75,
rim `#ffe8d0` 0.5: the cool studio ones tinted the room's floor and trims blue). Fog follows the camera
(`fogRangeForCamera(distance, elevation)`): looking down from the game camera it is clear up to 1.6 m past the table
centre; from the eye-level lobby orbit up to 6 m past it, beyond the far wall; it then fades over 11.4 m, so the
table is never fogged on any screen shape. Lights: warm key `SpotLight` from the lamp (0, 2.05, 0) aimed at
(0, FELT_Y, 0), angle ≈ 0.75, penumbra 0.55, decay 1.2, castShadow (2048, bias −0.0003, normalBias 0.02);
dim `HemisphereLight` fill (cool in the studio, neutral in the card room); soft rim `DirectionalLight` from behind the far side; a faint warm `PointLight`
near the camera to lift faces of cards. Floor: canvas carpet pattern (receives shadows), background `#07080a`; the
room around it is `CardRoom` (§4.10). The old floating bokeh sprites are gone: every glow now comes from a candle. Post: `EffectComposer` + `RenderPass` +
`UnrealBloomPass` (strength ≈ 0.35, radius 0.55, threshold 0.82) + `OutputPass`; disabled on `low`.
Lobby orbit: seated eye height, about 1.4 m (elevation 0.115 ± 0.01 rad, target y 0.85) at 4.6–4.75 m
(`LOBBY_MAX_DISTANCE` keeps it inside the room and clear of the furniture; narrow screens crop the table instead).
The camera stays at least ~7° below the lamp's rim: seen from just under it, the diffuser's edge aliased into a
jagged white line. Game camera pose: elevation ≈ 66° above the horizon, looking at (0, FELT_Y, 0.06), FOV 38; distance chosen so a
3.3 m × 2.3 m frame (table + plates) fits any aspect ratio (portrait phones zoom out). Leave ~12 % of the
bottom of the screen for the action bar (aim slightly lower so the table sits higher). Resize handling for both
renderers and the composer.

### 4.3 `TableModel.ts`, `FeltTexture.ts`, `proceduralTextures.ts`

```ts
export type FeltTheme = 'emerald' | 'royal' | 'burgundy';
export interface TableModelResult {
  root: THREE.Group; felt: THREE.Mesh; lamp: THREE.Object3D | null;
  setFeltTheme(theme: FeltTheme): void;
}
export async function loadTableModel(manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer): Promise<TableModelResult>;
export function createFeltTexture(theme: FeltTheme, maxAnisotropy: number): THREE.CanvasTexture; // FeltTexture.ts
// proceduralTextures.ts: canvas helpers, e.g. createWoodTexture(), createLeatherNormalMap(), createCarpetTexture(), createNoiseTexture()
```
Model facts (measured): `/assets/table/poker_table.3ds` loads with `TDSLoader` **Z-up in centimeters** →
`root.rotation.x = -Math.PI / 2`, `root.scale.setScalar(0.01)`, then recenter X/Z on the origin (bbox center
≈ (+0.012, ·, +0.003)). Meshes (3DS names are truncated to 10 chars): `poker_tabl` = felt top (259 × 127 cm,
top at 71.1 cm), `Poker_Tabl` = table body/rail/legs (288 × 138 × 78 cm), `Poker_Lamp` = hanging lamp
(z 137–210 cm), `chips_box` = dealer chip tray (hide it: seat slot 4 uses the top-center area). Every mesh has an
array of 7 materials (`Clear, PT_Wood, Crom, leather_black, plastik_grey, table, plastik_black`) with geometry
groups. Replace by material name:
`table` → felt `MeshPhysicalMaterial` (map = felt canvas, roughness 0.92, sheen 1, sheenRoughness 0.75,
sheenColor tinted), `PT_Wood` → lacquered dark walnut (`MeshPhysicalMaterial`, canvas grain map, roughness 0.4,
clearcoat 1, clearcoatRoughness 0.12), `leather_black` → padded black leather (color `#16110e`, roughness 0.55,
procedural leather normal map normalScale 0.35, clearcoat 0.3), `Crom` → chrome (metalness 1, roughness 0.15),
`Clear` → lamp diffuser (warm emissive `#ffcf8a`, emissiveIntensity ≈ 1.6), `plastik_grey` / `plastik_black`
→ satin plastics. The felt mesh gets **new planar UVs** from its local X/Y bounding box so the felt canvas maps
1:1: canvas x ↔ world x (−1.295 → +1.295 m), canvas top ↔ far side (world −Z). Cast shadows on body/lamp;
felt receives shadows. Lamp visible only in lobby/intro (`Stage.registerLamp`).
Felt canvas (2048 × 1024): theme base colors (emerald `#0f5e45`, royal `#123a6b`, burgundy `#5a1622`), radial
light falloff, fibre noise, darker vignette at the rail, thin gold (`#d9b46a`, α≈0.55) betting line along the felt
stadium inset 0.15 m, faint gold rounded-rect outlines for the 5 community slots, a thin gold ring at each seat's
bet anchor, a subtle pot circle, and a large faint watermark logo at the center: "MESA REAL" (serif, letter-spaced)
with "TEXAS HOLD'EM · NO LIMIT" underneath and a small spade emblem. Use `SeatLayout` to place everything.

### 4.4 `CardFactory.ts`

```ts
export const CARD_WIDTH = 0.13; export const CARD_HEIGHT = 0.182; export const CARD_THICKNESS = 0.0012; // enlarged for top-down readability
export type CardHighlight = 'none' | 'winner' | 'dim';
export class CardObject extends THREE.Group {
  card: Card | null;
  setFace(card: Card | null): void;     // null = unknown card: the front face also shows the back image
  setHighlight(mode: CardHighlight): void; // winner = gold glow outline + emissive lift; dim = darkened
  dispose(): void;
}
export class CardFactory {
  static create(manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer): Promise<CardFactory>;
  createCard(card: Card | null): CardObject;
}
```
Orientation contract: the card's **front face normal is local +Y**; the top edge of the face points to local
**−Z**; lying with rotation (0,0,0) the face reads correctly for the viewer at +Z. Face-down = `rotation.z =
Math.PI` (flip around the long axis). Geometry: rounded rectangle (corner radius ≈ 0.0055) extruded to
CARD_THICKNESS, shared across cards; materials: front (atlas), back (atlas back cell), edge (`#f1ede4`).
Atlas `/assets/cards/cards_atlas.webp` = 3328 × 1800, grid 13 × 5 of 256 × 360 cells; columns A,2,3,…,10,J,Q,K;
rows c, d, h, s; back at column 0, row 4. Inset UVs half a pixel. Texture: sRGB, max anisotropy, mipmaps.
Cards cast shadows. When `card === null`, the front shows the back image too (unknown card).

### 4.5 `ChipFactory.ts`, `TableButtons.ts`

```ts
export const CHIP_DENOMINATIONS = [5000, 1000, 500, 100, 25, 5, 1];
export const CHIP_DIAMETER = 0.058; export const CHIP_HEIGHT = 0.0046;
export function breakdownChips(amount: number, maxChips?: number): { denomination: number; count: number }[];
export interface ChipPlacement { denomination: number; x: number; y: number; z: number; yaw: number } // stack frame
export class ChipStack extends THREE.Group {
  amount: number; readonly topY: number;       // height of the tallest column (local)
  setAmount(amount: number): void;             // rebuilds columns
  showChips(amount: number, chips: readonly ChipPlacement[]): void; // exactly these chips (an all-in pushed forward)
  dispose(): void;
}
export class ChipFactory {
  static create(manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer): Promise<ChipFactory>;
  createStack(amount: number): ChipStack;      // columns of one denomination each, ≤ 12 chips per column, tight cluster
  createChip(denomination: number): THREE.Mesh;
  createInstancedChips(denomination: number, capacity: number): THREE.InstancedMesh; // players' stacks, low-poly chip
  setDetail(level: 'high' | 'low'): void;      // Mid_Poly_Chip vs Low_Poly_Chip geometry; low also stops the
                                               // players' stacks casting shadows
}
```
Players' own stacks (`PlayerStacks.ts`, `playerStackLayout.ts`): every seated player's chips stand on the felt at
`SeatAnchor.stack`, turned by `stackYaw`. One `InstancedMesh` per denomination holds the chips of every seat (at
most 7 draw calls plus their shadow pass, however many players). A stack of `amount` shows
`playerStackChipBudget(amount)` chips — 6 more per doubling, 2 000 → 20, capped at 40 (four columns of ten, 4.6 cm)
from about 22 000 — in the outline `playerStackOutline(budget)`, which only ever grows chip by chip, so a bigger
stack always covers a smaller one. The amount only picks the colours: the two denominations around the average
chip, the larger ones filling the back columns (on top in the one column both share, where the camera sees them),
within half the step between them (10 % from 300 up).
Model: `/assets/chips/chip.obj` (objects `Mid_Poly_Chip`, `Low_Poly_Chip`; diameter 2, thickness 0.1, base at
y=0) → scale XZ 0.022, Y 0.036. Textures `/assets/chips/chip_{1,5,25,100,500,1000,5000}.webp` (512², top-down
chip art; edge stripes are in the outer ring) + `/assets/chips/chip_normal.png`. Draw each texture into a canvas
and print the denomination in the center diamond (bold condensed, white with dark outline) before creating the
`CanvasTexture` ("1K"/"5K" for 1000/5000). Material: `MeshPhysicalMaterial` (roughness 0.42, clearcoat 0.6,
clearcoatRoughness 0.3, normalMap). Small random yaw/offset jitter per chip for realism. Shared geometries and
materials (no per-chip clones). Chips cast shadows.
`TableButtons.ts`: `createDealerButton(): THREE.Mesh` (white puck r 0.03, h 0.009, top texture "DEALER" with a
gold ring) and `createBlindButton(kind: 'SB' | 'BB'): THREE.Mesh` (r 0.022: SB royal blue, BB gold).

### 4.6 `AudioManager.ts` (+ `synth.ts`) — Web Audio synthesis, no audio files

```ts
export type SoundName = 'cardSlide' | 'cardSnap' | 'cardFlip' | 'shuffle' | 'chipClink' | 'chipStack' | 'chipsSlide'
  | 'knock' | 'fold' | 'tick' | 'tickUrgent' | 'yourTurn' | 'allIn' | 'win' | 'potCollect' | 'uiClick';
export type VoiceMode = 'full' | 'essential' | 'off';
export interface AudioSettings { master: number; sfx: boolean; ambience: boolean; voice: VoiceMode; voiceRate: number; voiceURI: string | null }
export class AudioManager {
  constructor();
  unlock(): Promise<void>;                      // create/resume AudioContext on a user gesture; idempotent
  play(name: SoundName, options?: { volume?: number; pan?: number; delay?: number; count?: number }): void;
  speak(text: string, priority: 1 | 2): void;   // speechSynthesis pt-BR, respects VoiceMode, drops stale queue
  getSettings(): AudioSettings; setSettings(partial: Partial<AudioSettings>): void; // persisted in localStorage
  listVoices(): SpeechSynthesisVoice[];          // Portuguese voices first (pt-BR preferred)
}
```
Graph: master gain → compressor → destination; SFX bus with a generated-impulse `ConvolverNode` room reverb
(short, ~0.6 s, low wet); ambience bus: very soft filtered brown noise "room tone" + distant low murmur (off by
default). Sounds: card slide = band-passed noise sweep + soft tail; snap = short high-passed click; flip = two
quick clicks with air; shuffle = rapid series of riffle clicks; chip clink = 2–3 inharmonic sine/triangle
partials 2.5–6.5 kHz with fast exponential decay (`count` repeats with 25–60 ms jitter); chipsSlide = grainy
noise + several clinks; knock = 2 wood knocks (low sine 140–190 Hz pitch drop + noise thump); tick/tickUrgent =
short woodblock ticks (urgent higher & brighter); yourTurn = gentle two-note chime; allIn = low boom + riser;
win = warm major arpeggio fanfare (triangle + soft saw through low-pass) + sparkle; potCollect = clink cascade.
Everything must be silent-safe before unlock (no throws). Speech: pick the chosen voice or the best pt-BR voice
(`voiceschanged`), `lang='pt-BR'`, rate = voiceRate; priority 2 is skipped in `essential` mode; cancel queued
priority-2 utterances when a priority-1 arrives; cap the queue at 3.

### 4.7 UI (`src/client/ui/*`, `src/client/styles.css`)

Dark mode, 8 px grid, high contrast, system font stack (no external fonts — LAN may be offline), gold accent
`#e4b363`, surfaces `rgba(12,14,18,0.82)` with blur, radius 12 px, focus rings, `prefers-reduced-motion`
respected, responsive down to 360 px wide (action bar wraps; side log collapses into a toggle).
```ts
// LoadingScreen.ts
export class LoadingScreen { constructor(root: HTMLElement); setProgress(ratio: number, label?: string): void; hide(): void; showError(message: string): void }
// Lobby.ts
export interface LobbyProfile { name: string; color: string; avatar: string }
export class Lobby {
  constructor(root: HTMLElement, onJoin: (profile: LobbyProfile) => Promise<{ ok: boolean; error?: string }>);
  show(): void; hide(): void; setLanUrls(urls: string[]): void; setStatus(text: string, tone?: 'info' | 'error'): void;
}
// Hud.ts
export interface HudCallbacks {
  onAction(request: PlayerActionRequest): void;
  onAddBot(): void; onRemoveBot(): void; onStart(config: Partial<TableConfig>): void; onRebuy(): void; onLeave(): void;
  onQualityChange(quality: 'high' | 'low'): void; onFeltThemeChange(theme: 'emerald' | 'royal' | 'burgundy'): void;
}
export class Hud {
  constructor(root: HTMLElement, callbacks: HudCallbacks, audio: AudioManager);
  show(): void; hide(): void;
  render(state: TableView, serverOffsetMs: number): void; // idempotent, cheap; called after every update
  announce(narration: Narration): void;                  // judge headline + log line only (GameClient does the speech)
  setBacklog(backlog: Backlog): void; addHandSummary(summary: HandSummary): void;
  toast(text: string, tone?: 'info' | 'error'): void;
}
// SeatPlates.ts — CSS2D name plates anchored with SeatLayout.getSeatAnchor(slot).plate
export class SeatPlates {
  constructor(stage: Stage);
  update(state: TableView, serverOffsetMs: number): void;  // create/update/remove per seat; viewer slot = 0
  setHandLabel(seat: number, text: string | null): void;   // showdown hand names
  flashWin(seat: number, amount: number): void;
  setBetLabel(seat: number, amount: number | null): void;  // small chip-count pill near the bet anchor
  setPotLabel(text: string | null): void;                  // above POT_POSITION
}
```
Components inside Hud: **JudgePanel** (top center: "JUIZ" badge with a gavel/scale glyph, hand #, street
pill, blinds, pot total, animated headline of the last narration), **ActionBar** (bottom: Fold, Check/Pagar X,
Apostar/Aumentar with slider + number input + presets "2× BB", "½ Pote", "Pote", "All-In"; turn timer bar with
color shift and seconds; keyboard shortcuts F / C / R / A, Enter confirms; disabled & dimmed when it is not
the viewer's turn, showing "Aguardando <nome>…"; plays `tick`/`tickUrgent` via audio once per second in the
last 10 s of the viewer's turn and `uiClick` on buttons), **LogPanel** (right side; tabs "Juiz" and "Mãos";
colored by tone; newest on top; collapsible), **HostPanel** (lobby phase: config selects — blinds 5/10, 10/20,
25/50, 50/100; stack 1.000/2.000/5.000/10.000; tempo 15/30/45/60 s — buttons "Adicionar Bot", "Remover Bot",
"Iniciar Partida" (enabled with ≥2 players); while running keep a compact "+ Bot / − Bot" menu), **SettingsPanel**
(gear button: volume, efeitos on/off, ambiente on/off, narração Completa/Essencial/Desligada, voz select,
velocidade, qualidade Alta/Baixa, cor do feltro Esmeralda/Azul Royal/Bordô, "Sair da mesa"), **status banners**
("Você está assistindo", "Sem fichas — Recomprar", "Aguardando jogadores…"), hand strength chip near the action
bar ("Você tem: Par de Reis"). Raise presets: potAfterCall = totalPot + callAmount; "½ Pote" → currentBet +
0.5 × potAfterCall, "Pote" → currentBet + potAfterCall, "2× BB" → max(minRaiseTo, 2 × bigBlind) when opening else
currentBet × 2; all clamped to [minRaiseTo, maxRaiseTo]; the slider steps by smallBlind.
Totals: totalPot = Σ pots + Σ seat bets.

### 4.8 `TableView.ts` — 3D state + GSAP animations (the visible Dealer)

```ts
export interface TableViewDeps {
  stage: Stage; table: TableModelResult; cards: CardFactory; chips: ChipFactory;
  audio: AudioManager; plates: SeatPlates;
}
export class TableView {
  constructor(deps: TableViewDeps);
  sync(state: TableView, viewerSeat: number | null): void; // instant rebuild (join/reconnect/resync/snapshot)
  play(event: GameEvent, previous: TableView, next: TableView, speed: number): Promise<void>; // resolves when done
  setReducedMotion(reduced: boolean): void;
}
```
(Import the protocol type as `TableView as TableState` to avoid the name clash.) Owns all 3D objects for the
current hand: hole cards per seat, community cards, bet stacks per seat, pot stacks, dealer/SB/BB pucks, a deck
object (small stack of face-down cards at `DECK_POSITION`). Uses `slotForSeat(seat, viewerSeat)` for positions.
Animations (GSAP timelines; durations divided by `speed`):
- `handStart`: sweep leftover cards to the muck and fade, clear stacks; slide the dealer puck to the dealer's
  `button` anchor and SB/BB pucks to their seats; `shuffle` sound; `stage.resetCamera()`.
- `blind` / `action` with chips: the player's stack shrinks to the chips left as a chip stack lifts off its top
  and arcs to the `bet` anchor, merging into the seat's bet stack (set amount = totalBet);
  `chipStack`/`chipClink` (count by size); `check` → `knock`; `fold` → the player's cards slide/fade to the muck
  + `fold`; `allIn` → the whole stack, chip for chip, slides onto the bet anchor and stays there as the bet for the
  rest of the street (an earlier bet of the street joins it), leaving an empty spot; `allIn` sound,
  `stage.shake()` and a short `dramaticZoom` toward the seat's bet anchor.
- `dealHole`: two rounds in `seats` order, 150 ms stagger: cards fly from the deck in an arc with spin (1–2
  turns around Y) to the seat's `cards` anchor (two cards slightly fanned, face-down, `yaw` facing the seat),
  `cardSlide` + `cardSnap` on landing. The viewer's own cards then lift and flip face-up near the bottom
  (HERO offsets, LIFT, TILT toward the camera, slightly larger ×1.15) — the "peek".
- `turn`: no 3D change besides a subtle pulse of the acting player's cards (plates handle the timer ring).
- `collect`: every bet stack slides to the pot (main/side pots at `POT_POSITION`/`SIDE_POT_POSITIONS`), merges,
  `chipsSlide`; returned uncalled chips fly back onto that player's stack, which grows as they land.
- `community`: cards slide face-down from the deck to their slots then flip in sequence (lift arc +
  `rotation.z` π→0), `cardFlip` each; the river gets a slower dramatic flip.
- `reveal`: flip the other players' cards face-up in place (raised slightly); `plates.setHandLabel`; with
  `allIn` → `stage.dramaticZoom(POT_POSITION)` + `shake`.
- `award`: highlight `bestFive` (community + hole) as `winner`, dim the rest; pot stacks split and slide to each
  winner's `bet` anchor then drop onto the winner's own stack, which grows by the share as it lands; `potCollect`
  + `win`; `plates.flashWin`; pot label cleared.
- `handEnd`, `rebuy`, `playerJoined`, `playerLeft`, `info`, `snapshot`: `sync()` (no animation).
- Players' stacks follow `SeatView.chips`: `sync()` rebuilds them at once, every timeline reconciles them with the
  state at its end (a timeline killed by a `sync()` never does), and reduced motion hands refunds and pots over
  without a flight.
Also maintain `plates.setBetLabel` and `plates.setPotLabel` after each event. `sync()` must reproduce any state
exactly (cards face-up/down as visible, stacks with amounts, pucks).

### 4.9 `Connection.ts`, `GameClient.ts`, `main.ts`

```ts
// Connection.ts
export class Connection {
  constructor();                                   // io() same origin, transports websocket+polling
  readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  getToken(): string;                              // localStorage 'poker-lan.token' (crypto.randomUUID fallback)
  join(profile: LobbyProfile): Promise<JoinResponse>; // remembers the profile; auto re-joins after reconnect
  onUpdate(cb): void; onBacklog(cb): void; onError(cb): void; onStatus(cb: (connected: boolean) => void): void;
  sendAction(request): void; addBot(): void; removeBot(): void; start(config): void; rebuy(): void; leave(): void;
}
// GameClient.ts — ordered event queue between the network and the presentation
export class GameClient {
  constructor(deps: { view: TableView; hud: Hud; plates: SeatPlates; audio: AudioManager; stage: Stage });
  enqueue(update: TableUpdate): void;
  setBacklog(backlog: Backlog): void;
  get serverOffsetMs(): number;
}
```
`GameClient`: processes updates strictly in `seq` order, one at a time: narration → `hud.announce` and
`audio.speak(narration.speech ?? narration.text, narration.priority)`; then
`await view.play(event, previous, next, speed)` (speed 1; ×2.5 when ≥3 queued; when ≥8 queued or after a
`seq` gap, skip animations and `view.sync(latest)`); then `hud.render(next, offset)` and `plates.update(next,
offset)`. `turn` events and the first update after joining render immediately. Clock offset = smoothed
`serverTime − Date.now()` (median of last 10). `handEnd` → `hud.addHandSummary`.
`main.ts`: create `LoadingScreen`, `Stage` (`#stage-root`), one `THREE.LoadingManager` feeding the progress bar;
load table/cards/chips in parallel; create `AudioManager`, `SeatPlates`, `TableView`, `Hud` (`#hud-root`),
`Lobby` (`#lobby-root`), `Connection`, `GameClient`. Start in lobby mode (orbit, lamp visible, empty seats
synced from the first update). On join success: `audio.unlock()`, hide lobby, `stage.setLobbyMode(false)`,
`stage.playIntro()`, `hud.show()`. Lobby also fetches LAN URLs from the first `TableUpdate.state.lanUrls`.
Settings callbacks: quality → `stage.setQuality` + `chips.setDetail`; felt → `table.setFeltTheme`.
Import `./styles.css` from `main.ts`.

### 4.10 `CardRoom.ts` + `src/client/scene/room/*` — the private card room

```ts
export class CardRoom {
  static load(manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer): Promise<CardRoom>;
  readonly root: THREE.Group;            // add to stage.scene (not tableRoot)
  readonly environment: THREE.Texture;   // prefiltered warm bar HDR → stage.setEnvironment(room.environment)
  hangLampFromCeiling(lamp: THREE.Object3D): void; // before stage.registerLamp: drop rods fade with the lamp
  update(deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera): void; // every frame
  setReducedMotion(reduced: boolean): void; // candle flicker off
  dispose(): void;
}
```
Assets: Poly Haven CC0 models and textures in `public/assets/room` (see `docs/ASSETS.md`), loaded through the
shared `LoadingManager` ("Decorando a sala…"). `main.ts` loads the room in parallel with the table and the dealer;
it is optional like the dealer (a failure leaves the table in the dark studio). Textures are uploaded and every
shader compiled (`renderer.compileAsync`) behind the loading screen, for an offscreen render target: the bloom
composer renders the scene into one, and shaders compiled for the screen differ (tone mapping and colour space)
and would compile again on first use. With bloom off (`low` quality) the screen variants compile on first use.

- `room/roomLayout.ts` (pure): room 12.8 × 11.6 m, ceiling 3.5 m (walls at x = ±6.4, z = ±5.8), wainscot to 1.02 m,
  5 × 5 coffered ceiling, rug 8.6 × 7.4 m on a plank floor. Furniture against the walls (`PROP_SPECS`: console under
  the big painting behind the dealer, sofa + painting west, gothic cabinet east, grandfather clock + painting south),
  two chandeliers in the coffer bays at x = ±2.56, eight candle sconces. `chairPlacements()`: one chair per seat slot
  (none at the dealer), 0.43 m behind the rail, turned halfway from square-to-the-rail toward the table centre.
  `isCeilingVisibleFrom(y)`: the game camera looks down from above the ceiling, so the ceiling group (ceiling,
  beams, cornice, roses, chandeliers) is hidden there.
- `room/chairFade.ts` (pure): `chairOpacityForCamera(outward, cameraPosition)` fades the chairs on the camera's side
  as the camera climbs (bearing cosine 0.5 → 0.8, elevation 0.45 → 0.8 rad): in the game view slots 7, 0, 1 are
  hidden, in the lobby orbit every chair stays. Tested against every game framing (tests/cardRoom.test.ts).
- `room/roomChairs.ts`: every fully drawn chair is one instance of a single `InstancedMesh` (shared material, front
  faces only); a chair part-way through its fade is drawn by its own mesh, whose material is transparent from the
  start. Those meshes sit hidden in the scene, so the shader pre-compilation covers them and the lobby → game flight
  never compiles a shader. The eight contact shadows are one mesh whose vertex alpha follows each chair.
- `room/roomShell.ts`: walls, panelling, trims, ceiling and floor as one merged mesh per material (tints close to
  white: the colour maps are already dark walnut, burgundy damask and stained boards; no normal map on the
  wallpaper); `room/roomGlow.ts`
  bakes the candle light into light maps (UV channel 1): sconce scallops and picture-light pools on the walls,
  chandelier glow on the ceiling. No real lights are added (a point light would add a loop to every lit shader).
- `room/candleLights.ts`: flames as one `Points` per chandelier / for the sconces (HDR colour → bloom), soft halo
  sprites, flicker by vertex colour.
- `room/roomProps.ts`, `room/grandfatherClock.ts` (hands show the device's local time; the
  model has no separate pendulum), `room/lampDrop.ts`, `room/roomAssets.ts` (HDR bulbs capped at luminance 3 before
  PMREM so chrome and brass do not bloom), `room/disposeTree.ts`.
- Shadows: only the key SpotLight casts; room meshes neither cast nor receive (chairs receive the table's shadow
  and get a soft contact-shadow decal). Texture budget: 1k only for the chair colour/normal maps, the painting and
  the wall wood; everything else 512 px or less (≈ 73 MB of VRAM with mipmaps and the prefiltered HDR, against ≈ 180 MB
with every map at 1k). Measured cost on an integrated GPU (Intel Arc, 1366 × 768 at device scale 2, render scale 1.5,
timer queries): ≈ 1.9 ms GPU and 0.35 ms CPU per lobby frame, ≈ 0.8 ms GPU in the game view; the chairs are half of it.

