// Extension relay: a local WebSocket server that the browser extension connects to.
// The extension speaks CDP JSON and emulates Target.*, so CDPBrowser works on top of it unchanged.
//
// Pairing: a shared secret (BBM_RELAY_TOKEN, or generated once into ~/.config/better-browser-mcp/relay-token, mode 0600)
// is pasted into the extension options page. On connect both sides prove they know it with HMAC challenge-response;
// the secret never crosses the wire. The extension runs no command before the server has proved itself, so a rogue
// local process listening on the port cannot drive the browser.
import { WebSocketServer, type WebSocket } from 'ws';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CDPConnection } from './cdp/connection.ts';
import { CDPBrowser } from './cdp/browser.ts';

// ws gives a Buffer for text frames, but its type also allows ArrayBuffer and fragment lists.
const rawText = (d: Buffer | ArrayBuffer | Buffer[]) => (Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d)).toString();

export const TOKEN_FILE = join(homedir(), '.config', 'better-browser-mcp', 'relay-token');

/** BBM_RELAY_TOKEN, or the token file (made once). */
export function relayToken(): string {
  if (process.env.BBM_RELAY_TOKEN) return process.env.BBM_RELAY_TOKEN;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const t = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return t;
}

const proof = (token: string, role: string, nonce: string) => createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex');
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface RelayOptions {
  port?: number;
  token?: string;
  extensionId?: string;
  timeoutMs?: number;
  log?: (m: string) => void;
}

export const DEFAULT_PORT = 9333;
export const SLOTS = 30; // parallel sessions: ports DEFAULT_PORT .. DEFAULT_PORT + SLOTS - 1 (the extension tries the same range)

/** A relay port that stays open for the life of the server. The extension may connect, drop (reload, Chrome or
 *  service-worker restart, sleep) and connect again: each pairing gives a new CDPBrowser. One live link at a time. */
export class RelayServer {
  readonly port: number;
  #wss: WebSocketServer;
  #current: CDPBrowser | null = null;
  #waiters = new Set<(b: CDPBrowser) => void>();
  #pairings = 0;
  #log: (m: string) => void;

  private constructor(wss: WebSocketServer, port: number, log: (m: string) => void) {
    this.#wss = wss;
    this.port = port;
    this.#log = log;
  }

  static async listen({
    port = DEFAULT_PORT,
    token,
    extensionId = process.env.BBM_RELAY_EXT_ID,
    log = (m: string) => {
      process.stderr.write(m + '\n');
    },
  }: RelayOptions = {}) {
    const tokenSource = token ? 'the given token' : process.env.BBM_RELAY_TOKEN ? 'BBM_RELAY_TOKEN' : TOKEN_FILE;
    const secret = token || relayToken();
    if (secret.length < 16) throw new Error('relay token must be at least 16 chars');
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    const relay = new RelayServer(wss, port, log);
    // Register the connection handler before awaiting 'listening': Bun accepts connections before that
    // event reaches us, and a connection with no handler is never paired (the extension then hangs on it).
    wss.on('connection', (ws, req) => relay.#onConnection(ws, req.headers.origin || '', secret, extensionId));
    await new Promise((res, rej) => {
      wss.once('listening', res);
      wss.once('error', rej);
    });
    wss.on('error', (e) => log(`[bbm] relay error: ${e.message}`));
    log(`[bbm] waiting for the browser extension on ws://127.0.0.1:${port} (pair it with ${tokenSource})`);
    return relay;
  }

  /** How many times the extension has paired with this relay. */
  pairings() {
    return this.#pairings;
  }

  /** The live browser link, or the next one to pair (rejects after timeoutMs). */
  browser({ timeoutMs = 120000 } = {}): Promise<CDPBrowser> {
    if (this.#current && !this.#current.conn.closed) return Promise.resolve(this.#current);
    return new Promise((resolve, reject) => {
      const done = (b: CDPBrowser) => {
        clearTimeout(timer);
        resolve(b);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        reject(new Error(`the browser extension is not connected on port ${this.port} (Chrome open, extension enabled, token set?)`));
      }, timeoutMs);
      this.#waiters.add(done);
    });
  }

  close(): Promise<void> {
    this.#current?.conn.close();
    for (const ws of this.#wss.clients) ws.terminate(); // Bun's server waits for open clients before 'close'
    return new Promise((r) => {
      this.#wss.close(() => r());
    });
  }

  #onConnection(ws: WebSocket, origin: string, token: string, extensionId?: string) {
    const okOrigin = extensionId ? origin === `chrome-extension://${extensionId}` : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (!okOrigin) {
      this.#log(`[bbm] rejected connection from origin ${JSON.stringify(origin)}`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    const serverNonce = randomBytes(16).toString('hex');
    let stage = 'hello';
    let build = 'unreported'; // Older extensions do not send build metadata.
    const fail = () => {
      this.#log(`[bbm] pairing failed (stage ${stage})`);
      ws.close(1008, 'pairing failed');
    };
    const authTimer = setTimeout(fail, 5000);
    const onAuth = (d: Buffer | ArrayBuffer | Buffer[]) => {
      let m;
      try {
        m = JSON.parse(rawText(d));
      } catch {
        return fail();
      }
      if (stage === 'hello' && m.type === 'hello' && typeof m.nonce === 'string' && m.nonce.length >= 16) {
        if (typeof m.build === 'string') build = m.build.slice(0, 200);
        stage = 'auth';
        ws.send(JSON.stringify({ type: 'hello', proof: proof(token, 'server', m.nonce), nonce: serverNonce }));
      } else if (stage === 'auth' && m.type === 'auth' && same(m.proof, proof(token, 'ext', serverNonce))) {
        clearTimeout(authTimer);
        ws.off('message', onAuth);
        this.#accept(ws, build).catch((e: Error) => {
          this.#log(`[bbm] relay setup failed: ${e.message}`);
          ws.close();
        });
      } else fail();
    };
    ws.on('message', onAuth);
  }

  // One live link at a time. A new authenticated link while one is live: if the old one still answers (a second
  // Chrome profile), refuse the new one; if it does not (half-open after a sleep), the new one replaces it.
  async #accept(ws: WebSocket, build: string) {
    const old = this.#current;
    if (old && !old.conn.closed) {
      if (await answers(old)) {
        ws.close(1013, 'a browser is already connected');
        return;
      }
      this.#log('[bbm] the old browser link does not answer: the new one replaces it');
      this.#current = null; // browser() now waits for the new link, not the closing one
      old.conn.close();
    }
    ws.send(JSON.stringify({ type: 'ready' }));
    await this.#paired(ws, build);
  }

  async #paired(socket: WebSocket, build: string) {
    const msgCbs: ((raw: string) => void)[] = [],
      closeCbs: (() => void)[] = [];
    socket.on('message', (d) => {
      for (const cb of msgCbs) cb(rawText(d));
    });
    socket.on('close', () => {
      for (const cb of closeCbs) cb();
    });
    const conn = new CDPConnection({
      send: (s) => socket.send(s),
      onMessage: (cb) => msgCbs.push(cb),
      onClose: (cb) => closeCbs.push(cb),
      close: () => socket.close(),
    });
    // Closing a browser link ends only that link; RelayServer.close() ends the relay.
    const browser = new CDPBrowser(conn);
    await browser.init();
    browser.port = this.port;
    browser.mode = 'extension';
    browser.relay = this;
    this.#current = browser;
    this.#pairings++;
    this.#log(this.#pairings === 1 ? '[bbm] extension paired and connected' : '[bbm] extension connected again');
    this.#log(`[bbm] extension build: ${JSON.stringify(build)}`);
    for (const w of this.#waiters) w(browser);
    this.#waiters.clear();
  }
}

/** Does this browser link still answer a command within ms? */
const answers = (b: CDPBrowser, ms = 2000) =>
  Promise.race([
    b.conn.send('Target.getTargets').then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref()),
  ]);

export const listenRelay = (opts: RelayOptions = {}) => RelayServer.listen(opts);

/** Parallel sessions: listen on the first free port in [basePort, basePort + slots). */
export async function listenRelayAuto({ basePort = DEFAULT_PORT, slots = SLOTS, ...opts }: RelayOptions & { basePort?: number; slots?: number } = {}) {
  for (let port = basePort; port < basePort + slots; port++) {
    try {
      return await RelayServer.listen({ ...opts, port });
    } catch (e: any) {
      if (e.code !== 'EADDRINUSE' && !/EADDRINUSE|in use/i.test(e.message)) throw e;
    }
  }
  throw new Error(`all ${slots} bbm slots are taken (ports ${basePort}-${basePort + slots - 1}): close a bbm session you do not use`);
}

/** One pairing, the old way: the returned browser's close() also closes the relay. Tests and scripts use it. */
async function firstBrowser(relay: RelayServer, timeoutMs: number) {
  try {
    const b = await relay.browser({ timeoutMs });
    b._onClose = () => relay.close();
    return b;
  } catch {
    await relay.close();
    throw new Error('extension did not connect/pair (installed, enabled, token set?)');
  }
}

export async function startRelay({ timeoutMs = 120000, ...opts }: RelayOptions = {}) {
  return firstBrowser(await RelayServer.listen(opts), timeoutMs);
}

export async function startRelayAuto({ timeoutMs = 120000, ...opts }: RelayOptions & { basePort?: number; slots?: number } = {}) {
  return firstBrowser(await listenRelayAuto(opts), timeoutMs);
}
