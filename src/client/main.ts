import './styles.css';
import gsap from 'gsap';
import { HalfFloatType, LoadingManager, WebGLRenderTarget, type Object3D } from 'three';
import { AudioManager } from './audio/AudioManager';
import { GameClient } from './GameClient';
import { ManualPanel } from './manual/ManualPanel';
import { Connection } from './net/Connection';
import { CardFactory } from './scene/CardFactory';
import { CardRoom } from './scene/CardRoom';
import { ChipFactory } from './scene/ChipFactory';
import { Dealer } from './scene/Dealer';
import { Stage } from './scene/Stage';
import { loadTableModel, type TableModelResult } from './scene/TableModel';
import { TableView } from './scene/TableView';
import { MAX_SEATS, type TableView as TableState } from '../shared/protocol';
import { DealerBubble } from './ui/DealerBubble';
import { Hud, type HudCallbacks } from './ui/Hud';
import { LoadingScreen } from './ui/LoadingScreen';
import { Lobby, type LobbyProfile } from './ui/Lobby';
import { SeatPlates } from './ui/SeatPlates';

// The server paces the hand in wall-clock time; on slow devices GSAP's lag smoothing would stretch every
// animation past that pacing, so timelines must always track real time.
gsap.ticker.lagSmoothing(0);

const ASSET_PROGRESS_SHARE = 0.9;

const WEBGL_UNAVAILABLE_MESSAGE =
  'Seu navegador não conseguiu iniciar o WebGL, necessário para desenhar a mesa 3D. ' +
  'Ative a aceleração de hardware nas configurações do navegador, atualize-o ou use o Chrome, Edge ou Firefox, e recarregue a página.';

class StartupError extends Error {}

interface LoadedWorld {
  stage: Stage;
  table: TableModelResult;
  cards: CardFactory;
  chips: ChipFactory;
  /** Null when the character model could not be loaded: the table still plays, only without the 3D croupier. */
  dealer: Dealer | null;
  /** Null when the room's assets could not be loaded: the table then stands in the dark studio as before. */
  room: CardRoom | null;
}

interface UiRoots {
  hud: HTMLElement;
  lobby: HTMLElement;
  overlay: HTMLElement;
}

interface JoinOutcome {
  ok: boolean;
  error?: string;
}

class TableApp {
  private readonly stage: Stage;
  private readonly audio = new AudioManager();
  private readonly connection: Connection;
  private readonly hud: Hud;
  private readonly lobby: Lobby;
  private readonly manual: ManualPanel;
  private readonly gameClient: GameClient;
  private showingJoinScreen = true;
  private hasConnectedBefore = false;
  private lanUrlsKey = '';
  // Identifies the intro that is allowed to finish its work; leaving the table or joining again supersedes it.
  private introGeneration = 0;

  constructor(world: LoadedWorld, roots: UiRoots) {
    this.stage = world.stage;
    this.stage.tableRoot.add(world.table.root);
    if (world.room) {
      this.addRoomToStage(world.room, world.table.lamp);
    }
    this.stage.registerLamp(world.table.lamp);

    const dealer = world.dealer;
    const bubble = dealer ? this.addDealerToStage(dealer) : undefined;

    const plates = new SeatPlates(this.stage);
    const view = new TableView({
      stage: this.stage,
      table: world.table,
      cards: world.cards,
      chips: world.chips,
      audio: this.audio,
      plates,
      dealer: dealer ?? undefined,
    });
    followReducedMotionPreference(view, dealer, world.room);
    // The socket starts connecting here, so every listener is attached in the same synchronous run.
    this.connection = new Connection();
    // One manual for the whole app: it lives in its own layer, above both the lobby and the table.
    this.manual = new ManualPanel(roots.overlay);
    this.manual.bindShortcut();
    this.hud = new Hud(roots.hud, this.createHudCallbacks(world), this.audio, this.manual);
    this.gameClient = new GameClient({ view, hud: this.hud, plates, audio: this.audio, stage: this.stage, bubble });
    this.lobby = new Lobby(roots.lobby, (profile) => this.handleJoin(profile));
    this.lobby.setManual(this.manual);
    this.bindConnection();
    this.bindRendererEvents();
  }

  private addDealerToStage(dealer: Dealer): DealerBubble {
    this.stage.tableRoot.add(dealer.root);
    dealer.setViewpoint(this.stage.camera);
    this.stage.onFrame((deltaSeconds, elapsedSeconds) => dealer.update(deltaSeconds, elapsedSeconds));
    return new DealerBubble(dealer.speechAnchor);
  }

  /** Before registerLamp: the room hangs the lamp from its ceiling with rods that must fade with the lamp. */
  private addRoomToStage(room: CardRoom, lamp: Object3D | null): void {
    this.stage.scene.add(room.root);
    if (lamp) {
      room.hangLampFromCeiling(lamp);
    }
    this.stage.setEnvironment(room.environment);
    this.stage.onFrame((deltaSeconds, elapsedSeconds) => room.update(deltaSeconds, elapsedSeconds, this.stage.camera));
  }

  start(): void {
    this.hud.hide();
    this.lobby.show();
    if (!this.connection.connected) {
      this.lobby.setStatus('Conectando ao servidor…', 'info');
    }
    this.stage.setLobbyMode(true);
    this.stage.setLampVisible(true);
    this.stage.start();
  }

  private createHudCallbacks(world: LoadedWorld): HudCallbacks {
    return {
      onAction: (request) => this.connection.sendAction(request),
      onAddBot: () => this.connection.addBot(),
      onRemoveBot: () => this.connection.removeBot(),
      onStart: (config) => this.connection.start(config),
      onRebuy: () => this.connection.rebuy(),
      onLeave: () => this.leaveTable(),
      onQualityChange: (quality) => {
        world.stage.setQuality(quality);
        world.chips.setDetail(quality);
      },
      onFeltThemeChange: (theme) => world.table.setFeltTheme(theme),
      onToggleZoom: () => world.stage.toggleCloseView(),
    };
  }

  private bindConnection(): void {
    this.connection.onUpdate((update) => {
      this.refreshLanUrls(update.state.lanUrls);
      if (this.showingJoinScreen) {
        this.lobby.setTableInfo(describeTable(update.state));
      }
      this.gameClient.enqueue(update);
    });
    this.connection.onBacklog((backlog) => this.gameClient.setBacklog(backlog));
    this.connection.onError((message) => this.notifyTableError(message));
    this.connection.onStatus((connected) => this.handleConnectionChange(connected));
    this.connection.socket.on('connect_error', () => {
      if (!this.hasConnectedBefore) {
        this.notify('Não foi possível conectar ao servidor. Tentando novamente…', 'error');
      }
    });
  }

  private bindRendererEvents(): void {
    this.stage.renderer.domElement.addEventListener('webglcontextlost', (event: Event) => {
      event.preventDefault();
      this.notify('A placa de vídeo interrompeu o desenho da mesa. Aguarde alguns segundos ou recarregue a página.', 'error');
    });
  }

  private refreshLanUrls(urls: string[]): void {
    const key = urls.join('|');
    if (key === this.lanUrlsKey) {
      return;
    }
    this.lanUrlsKey = key;
    this.lobby.setLanUrls(urls);
  }

  private handleConnectionChange(connected: boolean): void {
    if (!connected) {
      this.notify('Reconectando…', 'error');
      return;
    }
    this.gameClient.resetSequence();
    this.notify(this.hasConnectedBefore ? 'Conectado' : 'Conectado ao servidor.', 'info');
    this.hasConnectedBefore = true;
  }

  /** Errors answering something the player sent (a refused action, or none sent for lack of a connection). */
  private notifyTableError(message: string): void {
    if (this.showingJoinScreen) {
      this.lobby.setStatus(message, 'error');
    } else {
      this.hud.reportTableError(message);
    }
  }

  private notify(text: string, tone: 'info' | 'error'): void {
    if (this.showingJoinScreen) {
      this.lobby.setStatus(text, tone);
    } else {
      this.hud.toast(text, tone);
    }
  }

  private async handleJoin(profile: LobbyProfile): Promise<JoinOutcome> {
    // Must run before the first await: browsers only start audio inside the click that triggered the join.
    this.unlockAudio();
    const response = await this.connection.join(profile);
    if (!response.ok) {
      return { ok: false, error: response.error ?? 'Não foi possível entrar na mesa.' };
    }
    this.enterTable(response.spectator === true);
    return { ok: true };
  }

  private unlockAudio(): void {
    this.audio.unlock().catch((error: unknown) => console.warn('[Mesa Real] áudio não pôde ser iniciado', error));
  }

  private enterTable(asSpectator: boolean): void {
    this.showingJoinScreen = false;
    this.gameClient.setInGame(true);
    this.lobby.hide();
    this.hud.show();
    this.stage.setLobbyMode(false);
    this.introGeneration += 1;
    void this.playIntro(this.introGeneration);
    if (asSpectator) {
      this.hud.toast('A mesa está cheia. Você está assistindo como espectador.', 'info');
    }
  }

  private async playIntro(generation: number): Promise<void> {
    try {
      await this.stage.playIntro();
    } catch (error) {
      console.error('[Mesa Real] a abertura da câmera falhou', error);
    }
    // The hanging lamp would sit between the camera and the felt during play, but a superseded
    // intro must not hide it again once the player is back in the lobby.
    if (generation === this.introGeneration) {
      this.stage.setLampVisible(false);
    }
  }

  private leaveTable(): void {
    this.introGeneration += 1;
    this.connection.leave();
    this.showingJoinScreen = true;
    this.gameClient.setInGame(false);
    this.hud.hide();
    this.stage.setLobbyMode(true);
    this.stage.setLampVisible(true);
    this.lobby.show();
    this.lobby.setStatus('Você saiu da mesa.', 'info');
  }
}

function describeTable(state: TableState): { seated: number; maxSeats: number; running: boolean; handNumber: number } {
  return {
    seated: state.seats.filter((seat) => seat !== null).length,
    maxSeats: MAX_SEATS,
    running: state.phase === 'running',
    handNumber: state.handNumber,
  };
}

function followReducedMotionPreference(view: TableView, dealer: Dealer | null, room: CardRoom | null): void {
  if (typeof window.matchMedia !== 'function') {
    return;
  }
  const apply = (reduced: boolean): void => {
    view.setReducedMotion(reduced);
    dealer?.setReducedMotion(reduced);
    room?.setReducedMotion(reduced);
  };
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  apply(query.matches);
  // The setting can be toggled in the OS while the game is open.
  query.addEventListener('change', (event) => apply(event.matches));
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new StartupError(`O elemento #${id} não foi encontrado na página. Reinstale ou refaça o build do jogo.`);
  }
  return element;
}

function isWebGlAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

function describeAsset(url: string): string {
  if (url.includes('/table/')) return 'Carregando a mesa…';
  if (url.includes('/cards/')) return 'Carregando as cartas…';
  if (url.includes('/chips/')) return 'Carregando as fichas…';
  if (url.includes('/dealer/')) return 'Chamando o Juiz…';
  if (url.includes('/room/')) return 'Decorando a sala…';
  return 'Carregando recursos…';
}

function fileNameOf(url: string): string {
  return url.split(/[?#]/)[0].split('/').pop() || url;
}

function createLoadingManager(loading: LoadingScreen, failedAssets: string[]): LoadingManager {
  const manager = new LoadingManager();
  // The manager's total grows as loaders start, so the raw ratio can step backwards; the bar must not.
  let highestRatio = 0;
  manager.onProgress = (url, loaded, total) => {
    highestRatio = Math.max(highestRatio, total > 0 ? loaded / total : 0);
    loading.setProgress(highestRatio * ASSET_PROGRESS_SHARE, describeAsset(url));
  };
  manager.onError = (url) => {
    failedAssets.push(url);
  };
  return manager;
}

function describeStartupError(error: unknown, failedAssets: readonly string[]): string {
  if (error instanceof StartupError) {
    return error.message;
  }
  if (failedAssets.length > 0) {
    const names = [...new Set(failedAssets.map(fileNameOf))].join(', ');
    return `Não foi possível carregar os arquivos da mesa (${names}). Confira se a pasta public/assets está completa e recarregue a página.`;
  }
  const detail = error instanceof Error ? error.message : '';
  if (/webgl/i.test(detail)) {
    return WEBGL_UNAVAILABLE_MESSAGE;
  }
  return `Algo deu errado ao iniciar o jogo${detail ? ` (${detail})` : ''}. Recarregue a página para tentar de novo.`;
}

async function loadDealer(manager: LoadingManager): Promise<Dealer | null> {
  try {
    return await Dealer.load(manager);
  } catch (error) {
    // The croupier is scenery and a presenter: the game is fully playable without him.
    console.warn('[Mesa Real] o modelo do Juiz não pôde ser carregado; a mesa segue sem ele', error);
    return null;
  }
}

async function loadRoom(manager: LoadingManager, stage: Stage): Promise<CardRoom | null> {
  try {
    return await CardRoom.load(manager, stage.renderer);
  } catch (error) {
    // The room is scenery: without it the table still plays in the dark studio.
    console.warn('[Mesa Real] a sala não pôde ser carregada; a mesa segue sem ela', error);
    return null;
  }
}

async function loadWorld(stage: Stage, manager: LoadingManager): Promise<LoadedWorld> {
  const [table, cards, chips, dealer, room] = await Promise.all([
    loadTableModel(manager, stage.renderer),
    CardFactory.create(manager, stage.renderer),
    ChipFactory.create(manager, stage.renderer),
    loadDealer(manager),
    loadRoom(manager, stage),
  ]);
  return { stage, table, cards, chips, dealer, room };
}

/**
 * Compiles every material of the assembled scene behind the loading screen (in parallel where the browser
 * supports it), instead of hitching through the first seconds of the lobby orbit or the flight to the table.
 * The bloom composer draws the scene into an offscreen target and tones it in its output pass; compiled for the
 * screen, every shader would differ (tone mapping, colour space) and compile again on first use.
 */
async function compileShaders(stage: Stage): Promise<void> {
  const renderer = stage.renderer;
  const offscreen = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  const previousTarget = renderer.getRenderTarget();
  try {
    // compileAsync picks the shader variants synchronously, so the real target can be restored before waiting.
    renderer.setRenderTarget(offscreen);
    const compiled = renderer.compileAsync(stage.scene, stage.camera);
    renderer.setRenderTarget(previousTarget);
    await compiled;
  } catch (error) {
    console.warn('[Mesa Real] pré-compilação dos shaders falhou; eles compilam no primeiro quadro', error);
  } finally {
    renderer.setRenderTarget(previousTarget);
    offscreen.dispose();
  }
}

/** Handles for the headless visual QA (close-up cameras, forcing gestures); stripped from production builds. */
function exposeDevHandles(world: LoadedWorld): void {
  if (import.meta.env.DEV) {
    (window as unknown as { __mesa?: unknown }).__mesa = { stage: world.stage, dealer: world.dealer, table: world.table, room: world.room };
  }
}

async function startGame(): Promise<void> {
  const loading = new LoadingScreen(requireElement('loading-root'));
  const failedAssets: string[] = [];
  try {
    loading.setProgress(0, 'Preparando a mesa…');
    if (!isWebGlAvailable()) {
      throw new StartupError(WEBGL_UNAVAILABLE_MESSAGE);
    }
    const stage = new Stage(requireElement('stage-root'));
    const world = await loadWorld(stage, createLoadingManager(loading, failedAssets));
    loading.setProgress(0.95, 'Montando a mesa…');

    const app = new TableApp(world, {
      hud: requireElement('hud-root'),
      lobby: requireElement('lobby-root'),
      overlay: requireElement('overlay-root'),
    });
    await compileShaders(stage);
    app.start();
    exposeDevHandles(world);
    loading.setProgress(1, 'Pronto');
    loading.hide();
  } catch (error) {
    console.error('[Mesa Real] falha na inicialização', error);
    loading.showError(describeStartupError(error, failedAssets));
  }
}

// There is deliberately no beforeunload handler: closing or refreshing the page must not send
// table:leave, because the server keeps the seat so the same token can reclaim it.
startGame().catch((error: unknown) => {
  console.error('[Mesa Real] falha fatal', error);
  const message = document.createElement('p');
  message.style.cssText = 'color:#f2f2f2;font:16px system-ui,sans-serif;padding:24px;max-width:40em';
  message.textContent = describeStartupError(error, []);
  document.body.replaceChildren(message);
});
