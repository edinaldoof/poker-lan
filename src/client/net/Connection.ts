import { io, type Socket } from 'socket.io-client';
import type {
  Backlog,
  ClientToServerEvents,
  JoinRequest,
  JoinResponse,
  PlayerActionRequest,
  ServerToClientEvents,
  TableConfig,
  TableUpdate,
} from '../../shared/protocol';
import type { LobbyProfile } from '../ui/Lobby';

const TOKEN_STORAGE_KEY = 'poker-lan.token';
const TOKEN_PATTERN = /^[\w-]{8,64}$/;
const CONNECT_WAIT_MS = 8000;
const JOIN_ACK_TIMEOUT_MS = 8000;

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type StatusListener = (connected: boolean) => void;
type ErrorListener = (message: string) => void;
type UpdateListener = (update: TableUpdate) => void;

function readStoredToken(): string | null {
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    return stored !== null && TOKEN_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Private mode or blocked storage: the token then lives only until the page is closed.
  }
}

function createToken(): string {
  // crypto.randomUUID only exists in secure contexts, and a LAN page served over http is not one.
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class Connection {
  readonly socket: GameSocket;

  private token: string | null = null;
  private activeProfile: LobbyProfile | null = null;
  private readonly statusListeners: StatusListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];
  private readonly updateListeners: UpdateListener[] = [];
  // The server greets every new socket with a snapshot personalised for an anonymous viewer. While the player
  // is reclaiming their seat that snapshot would flip the table to the spectator view and back, so it waits here.
  private pendingRejoin: Promise<JoinResponse> | null = null;
  private heldSnapshot: TableUpdate | null = null;

  constructor() {
    this.socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: CONNECT_WAIT_MS,
    });
    this.socket.on('connect', () => this.handleConnect());
    this.socket.on('disconnect', (reason) => this.handleDisconnect(reason));
    this.socket.on('table:update', (update) => this.handleUpdate(update));
    this.socket.on('table:error', (message) => this.notifyError(message));
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  getToken(): string {
    if (this.token === null) {
      this.token = readStoredToken() ?? createToken();
      storeToken(this.token);
    }
    return this.token;
  }

  async join(profile: LobbyProfile): Promise<JoinResponse> {
    const connected = await this.waitUntilConnected(CONNECT_WAIT_MS);
    if (!connected) {
      return { ok: false, error: 'Não foi possível conectar ao servidor. Verifique a rede e tente novamente.' };
    }
    const response = await this.requestJoin(profile);
    if (response.ok) {
      this.activeProfile = profile;
    }
    return response;
  }

  onUpdate(callback: UpdateListener): void {
    this.updateListeners.push(callback);
  }

  onBacklog(callback: (backlog: Backlog) => void): void {
    this.socket.on('table:backlog', callback);
  }

  onError(callback: ErrorListener): void {
    this.errorListeners.push(callback);
  }

  onStatus(callback: StatusListener): void {
    this.statusListeners.push(callback);
  }

  sendAction(request: PlayerActionRequest): void {
    this.emitWhenConnected(() => this.socket.emit('table:action', request));
  }

  addBot(): void {
    this.emitWhenConnected(() => this.socket.emit('table:addBot'));
  }

  removeBot(): void {
    this.emitWhenConnected(() => this.socket.emit('table:removeBot'));
  }

  start(config: Partial<TableConfig>): void {
    this.emitWhenConnected(() => this.socket.emit('table:start', config));
  }

  rebuy(): void {
    this.emitWhenConnected(() => this.socket.emit('table:rebuy'));
  }

  leave(): void {
    // Forget the profile first so a reconnect never drags the player back to the table.
    this.activeProfile = null;
    this.abandonRejoin(true);
    if (this.socket.connected) {
      this.socket.emit('table:leave');
    }
  }

  private handleConnect(): void {
    this.statusListeners.forEach((listener) => listener(true));
    this.rejoinAfterReconnect();
  }

  private handleDisconnect(reason: string): void {
    this.abandonRejoin(false);
    this.statusListeners.forEach((listener) => listener(false));
    // Socket.io does not retry when the server itself closed the connection.
    if (reason === 'io server disconnect') {
      this.socket.connect();
    }
  }

  private rejoinAfterReconnect(): void {
    if (this.activeProfile === null) {
      return;
    }
    const rejoin = this.requestJoin(this.activeProfile);
    this.pendingRejoin = rejoin;
    void rejoin.then((response) => {
      // A newer connection (or leaving the table) already settled this attempt.
      if (this.pendingRejoin !== rejoin) {
        return;
      }
      this.abandonRejoin(!response.ok);
      if (!response.ok) {
        this.notifyError(response.error ?? 'Não foi possível voltar para a mesa.');
      }
    });
  }

  private handleUpdate(update: TableUpdate): void {
    if (this.pendingRejoin !== null && update.event.kind === 'snapshot') {
      this.heldSnapshot = update;
      return;
    }
    this.dispatchUpdate(update);
  }

  private dispatchUpdate(update: TableUpdate): void {
    this.updateListeners.forEach((listener) => listener(update));
  }

  /**
   * Ends the wait for the seat to be reclaimed. The held snapshot is dropped when the rejoin worked (the `info`
   * update that follows carries the personalised state) and shown otherwise, so the table never goes blank.
   */
  private abandonRejoin(showHeldSnapshot: boolean): void {
    const snapshot = this.heldSnapshot;
    this.pendingRejoin = null;
    this.heldSnapshot = null;
    if (showHeldSnapshot && snapshot !== null) {
      this.dispatchUpdate(snapshot);
    }
  }

  private requestJoin(profile: LobbyProfile): Promise<JoinResponse> {
    const request: JoinRequest = {
      name: profile.name,
      color: profile.color,
      avatar: profile.avatar,
      token: this.getToken(),
    };
    return new Promise((resolve) => {
      this.socket.timeout(JOIN_ACK_TIMEOUT_MS).emit('table:join', request, (error, response) => {
        if (error || !response) {
          resolve({ ok: false, error: 'O servidor não respondeu. Tente novamente.' });
          return;
        }
        resolve(response);
      });
    });
  }

  private waitUntilConnected(timeoutMs: number): Promise<boolean> {
    if (this.socket.connected) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const finish = (connected: boolean): void => {
        clearTimeout(timer);
        this.socket.off('connect', onConnect);
        resolve(connected);
      };
      const onConnect = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.socket.on('connect', onConnect);
    });
  }

  // Socket.io would buffer an offline emit and replay it after reconnecting, which could apply a stale fold.
  private emitWhenConnected(send: () => void): void {
    if (!this.socket.connected) {
      this.notifyError('Sem conexão com o servidor. Aguarde a reconexão.');
      return;
    }
    send();
  }

  private notifyError(message: string): void {
    this.errorListeners.forEach((listener) => listener(message));
  }
}
