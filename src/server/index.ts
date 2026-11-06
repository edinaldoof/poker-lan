import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { hostname as machineHostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type ServerOptions } from 'socket.io';
import { DEFAULT_PORT, type ClientToServerEvents, type ServerToClientEvents } from '../shared/protocol';
import { GameController } from './game/GameController';
import { ConnectionLimiter, getLanAddresses, isHandshakeAllowed, ownHostnamesOf } from './lan';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'client');
const CLIENT_INDEX_FILE = path.join(CLIENT_DIST_DIR, 'index.html');
const SHUTDOWN_GRACE_MS = 1500;
const MAX_SOCKET_PAYLOAD_BYTES = 16 * 1024;
const REFUSAL_LOG_WINDOW_MS = 2000;
const REFUSAL_LOG_BURST = 5;
const MAX_LOGGED_HEADER_LENGTH = 100;
const UNKNOWN_ADDRESS = 'endereço desconhecido';
const LAN_ADDRESS_REFRESH_MS = 5000;

type HandshakeGuard = NonNullable<ServerOptions['allowRequest']>;

interface HandshakePolicy {
  limiter: ConnectionLimiter;
  ownHostnames: ReadonlySet<string>;
}

function parsePort(rawPort: string | undefined): number {
  const port = Number(rawPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function printBanner(port: number, lanUrls: string[], devMode: boolean): void {
  const lines = [
    '',
    '  ♠ ♥  MESA REAL — Texas Hold\'em na rede local  ♦ ♣',
    devMode ? '  Modo de desenvolvimento (Vite com recarga automática)' : '',
    '',
    '  Abra no navegador:',
    `    Neste computador   http://localhost:${port}`,
    ...lanUrls.map((url) => `    Na rede local      ${url}`),
    '',
    lanUrls.length === 0 ? '  Nenhum adaptador de rede local foi encontrado: só este computador consegue entrar.' : '',
    '  Pressione Ctrl+C para encerrar o servidor.',
    '',
  ];
  console.log(lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n'));
}

function serveBuiltClient(app: express.Express): void {
  if (!existsSync(CLIENT_INDEX_FILE)) {
    console.error(
      '[Erro] O cliente ainda não foi compilado (dist/client/index.html não existe).\n' +
        '       Execute "npm run build" para gerar a interface. Os sockets continuam funcionando.',
    );
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/')) return next();
      response
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Cliente não compilado. Execute "npm run build" no servidor e recarregue esta página.');
    });
    return;
  }

  app.use(express.static(CLIENT_DIST_DIR));
  app.get('*', (request, response) => {
    // A missing asset must stay a 404 instead of silently returning the HTML shell.
    if (path.extname(request.path) !== '') {
      response.status(404).end();
      return;
    }
    response.sendFile(CLIENT_INDEX_FILE);
  });
}

async function attachViteMiddleware(
  app: express.Express,
  httpServer: ReturnType<typeof createServer>,
): Promise<{ close: () => Promise<void> }> {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: PROJECT_ROOT,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  app.use(vite.middlewares);
  return { close: () => vite.close() };
}

function quoteForLog(headerValue: string | undefined): string {
  return headerValue === undefined ? 'ausente' : JSON.stringify(headerValue.slice(0, MAX_LOGGED_HEADER_LENGTH));
}

function findHandshakeRefusal(request: IncomingMessage, policy: HandshakePolicy): string | null {
  const { origin, host } = request.headers;
  if (!isHandshakeAllowed(origin, host, policy.ownHostnames)) {
    return `origem ${quoteForLog(origin)} ou host ${quoteForLog(host)} não permitidos`;
  }
  return policy.limiter.refusalFor(request.socket.remoteAddress ?? UNKNOWN_ADDRESS);
}

/** Under a flood every refusal would be a console write, so only a burst per window is printed and the rest counted. */
function createRefusalLogger(): (address: string, reason: string) => void {
  let windowStartedAt = 0;
  let loggedInWindow = 0;
  let omittedSinceLastLog = 0;
  return (address, reason) => {
    const now = Date.now();
    if (now - windowStartedAt >= REFUSAL_LOG_WINDOW_MS) {
      windowStartedAt = now;
      loggedInWindow = 0;
    }
    if (loggedInWindow >= REFUSAL_LOG_BURST) {
      omittedSinceLastLog += 1;
      return;
    }
    loggedInWindow += 1;
    const omittedNote = omittedSinceLastLog > 0 ? ` (mais ${omittedSinceLastLog} recusas omitidas)` : '';
    omittedSinceLastLog = 0;
    console.warn(`[Rede] Conexão recusada de ${address}: ${reason}${omittedNote}.`);
  };
}

function createHandshakeGuard(policy: HandshakePolicy): HandshakeGuard {
  const logRefusal = createRefusalLogger();
  return (request, callback) => {
    const refusal = findHandshakeRefusal(request, policy);
    if (refusal === null) {
      callback(null, true);
      return;
    }
    logRefusal(request.socket.remoteAddress ?? UNKNOWN_ADDRESS, refusal);
    callback(refusal, false);
  };
}

function trackOpenConnections(io: Server<ClientToServerEvents, ServerToClientEvents>, limiter: ConnectionLimiter): void {
  io.engine.on('connection', (connection) => {
    connection.once('close', limiter.track(connection.remoteAddress));
  });
}

function listen(httpServer: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
}

/** Every table update carries the invite addresses, so the adapter scan is cached for a few seconds. */
function createLanUrlSource(port: number): () => string[] {
  let cachedUrls: string[] = [];
  let cachedAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = Date.now();
    if (now - cachedAt >= LAN_ADDRESS_REFRESH_MS) {
      cachedUrls = getLanAddresses().map((address) => `http://${address}:${port}`);
      cachedAt = now;
    }
    return cachedUrls;
  };
}

async function main(): Promise<void> {
  const devMode = process.argv.includes('--dev');
  const port = parsePort(process.env.PORT);
  const lanUrls = createLanUrlSource(port);

  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  const httpServer = createServer(app);
  const handshakePolicy: HandshakePolicy = {
    limiter: new ConnectionLimiter(),
    ownHostnames: ownHostnamesOf(machineHostname()),
  };
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
    pingInterval: 10_000,
    pingTimeout: 10_000,
    allowRequest: createHandshakeGuard(handshakePolicy),
  });
  trackOpenConnections(io, handshakePolicy.limiter);
  const controller = new GameController(io, { lanUrls });
  controller.attach();

  const vite = devMode ? await attachViteMiddleware(app, httpServer) : null;
  if (!devMode) serveBuiltClient(app);

  try {
    await listen(httpServer, port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? `[Erro] A porta ${port} já está em uso. Feche o outro servidor ou defina outra porta (PORT=3100).`
        : `[Erro] Não foi possível iniciar o servidor: ${(error as Error).message}`,
    );
    controller.shutdown();
    await vite?.close();
    process.exit(1);
  }
  printBanner(port, lanUrls(), devMode);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nEncerrando o servidor…');
    controller.shutdown();
    void vite?.close();
    io.close();
    httpServer.closeAllConnections();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('[Erro] Falha ao iniciar o servidor:', error);
  process.exit(1);
});
