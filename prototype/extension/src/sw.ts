// better-browser-mcp relay (MV3 service worker).
// Connects to local MCP servers over ws://127.0.0.1:<port> and speaks raw CDP JSON.
// It emulates the browser-level Target.* domain with chrome.tabs + chrome.debugger, so the
// server's CDP adapter works unchanged. Each server is one session on its own port (base port
// + 0..SLOTS-1): a session sees only the tabs it created (its Agent group). No cloud path.

const DEFAULT_PORT = 9333;
const SLOTS = 30; // parallel sessions (the server's SLOTS too)
const PROTOCOL = '1.3';
// A port with no server is retried after 1 s, 2 s, 4 s … up to max: Chrome logs every refused WebSocket as an extension
// error. max is also the longest a newly started server waits to pair. Tests shorten it (globalThis.bbmBackoff).
// Servers take the first free port, so live ones sit at the low slots: we try only up to 2 slots past the highest
// live one. Every `sweep` ms (also after a service-worker restart, which forgets what was live) we also try the
// other slots, one per tick.
const backoff = { min: 1000, max: 10000, sweep: 5 * 60_000 };

// CDP params and results pass through untouched.
type Json = any;

const tabSession = (tabId: number) => `tab-${tabId}`;

// ---- pairing: mutual HMAC challenge-response; the token never crosses the wire ----
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(token: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

type GroupColor = `${chrome.tabGroups.Color}`; // 'purple', 'green', ...

class Session {
  slot: number;
  ws: WebSocket | null;
  ready: boolean;
  agentTabs: Set<number>;
  attached: Set<number>;
  childSession: Map<string, number>;
  discover: boolean;
  agentWindowId: number | null;
  keepTabs: boolean;
  label: string;
  color: GroupColor;
  lastAgentInput: number;
  touched: Set<number>;
  groupByWindow: Map<number, number>;
  retryDelay = backoff.min;
  nextTry = 0; // no connect attempt before this time
  attemptTimes: number[] = []; // recent attempts, for tests

  constructor(slot: number) {
    this.slot = slot;
    this.ws = null;
    this.ready = false;
    this.agentTabs = new Set(); // tab ids this session created or adopted
    this.attached = new Set(); // tab ids with chrome.debugger attached
    this.childSession = new Map(); // OOPIF child sessionId -> tabId
    this.discover = false;
    this.agentWindowId = null; // opt-in agent window (Target.createTarget newWindow)
    this.keepTabs = false; // Bbm.configure: keep agent tabs when the session ends
    this.lastAgentInput = 0; // popups are adopted only right after the agent's own input
    this.touched = new Set(); // agent tabs the user activated: kept (ungrouped) at session end
    this.groupByWindow = new Map(); // windowId -> groupId (one group per window: grouping moves tabs)
    this.label = ''; // Bbm.setLabel: group title "Agent:<label>" instead of "Agent N"
    this.color = 'purple'; // Bbm.setLabel: the agent's group color
  }

  get title() {
    if (this.label) return `Agent:${this.label}`;
    return this.slot === 0 ? 'Agent' : `Agent ${this.slot + 1}`;
  }

  send(msg: Json) {
    if (this.ws?.readyState === 1 && this.ready) this.ws.send(JSON.stringify(msg));
  }

  tabOf(sessionId: string | undefined) {
    if (!sessionId) return undefined;
    return sessionId.startsWith('tab-') ? +sessionId.slice(4) : this.childSession.get(sessionId);
  }

  targetInfo(tab: chrome.tabs.Tab) {
    return {
      targetId: String(tab.id),
      type: 'page',
      title: tab.title || '',
      url: tab.url || tab.pendingUrl || 'about:blank',
      attached: this.attached.has(tab.id!),
      openerId: tab.openerTabId != null && this.agentTabs.has(tab.openerTabId) ? String(tab.openerTabId) : undefined,
      browserContextId: 'default',
    };
  }

  async addToGroup(tabId: number) {
    try {
      const { windowId } = await chrome.tabs.get(tabId);
      const existing = this.groupByWindow.get(windowId);
      if (existing != null) {
        try {
          await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
          return;
        } catch {
          this.groupByWindow.delete(windowId);
        }
      }
      // After a service-worker restart we forget our groups: join this window's group with our title and color
      // (not another live session's) instead of making a second "Agent:CT2".
      const live = new Set(sessions.flatMap((x) => [...x.groupByWindow.values()]));
      const same = (await chrome.tabGroups.query({ windowId, color: this.color, title: this.title })).find((g) => !live.has(g.id));
      if (same) {
        await chrome.tabs.group({ groupId: same.id, tabIds: [tabId] });
        this.groupByWindow.set(windowId, same.id);
        return;
      }
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      this.groupByWindow.set(windowId, groupId);
      await chrome.tabGroups.update(groupId, { title: this.title, color: this.color });
      await rememberColored(this.title, this.color);
    } catch {
      /* groups unsupported (e.g. headless): ignore */
    }
  }

  // A plain agent tab goes to the user's window, never the agent window (Chrome's default is the last focused one,
  // which is the agent window when the user clicked it, or in a headless browser that has no focus).
  async userWindow(): Promise<number | undefined> {
    if (this.agentWindowId == null) return undefined;
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const others = wins.filter((w) => w.id !== this.agentWindowId);
    return (others.find((w) => w.focused) ?? others.at(-1))?.id;
  }

  // The opt-in agent window: created unfocused once, reused while open. The user's window and active tab stay as they are.
  async openInAgentWindow(url: string): Promise<chrome.tabs.Tab> {
    const win = this.agentWindowId != null && (await chrome.windows.get(this.agentWindowId).catch(() => null));
    if (win) return chrome.tabs.create({ windowId: this.agentWindowId!, url, active: true });
    const w = (await chrome.windows.create({ url, focused: false }))!;
    this.agentWindowId = w.id ?? null;
    return w.tabs![0];
  }

  adopt(tab: chrome.tabs.Tab) {
    this.agentTabs.add(tab.id!);
    owner.set(tab.id!, this);
    if (this.discover) this.send({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo(tab) } });
  }

  // Every targetId must be a tab this session created (or a popup of one). User tabs are never touched.
  own(targetId: string) {
    const tabId = +targetId;
    if (!this.agentTabs.has(tabId)) throw new Error('not an agent tab');
    return tabId;
  }

  async browserCommand(method: string, params: Json = {}): Promise<Json> {
    switch (method) {
      case 'Target.setDiscoverTargets':
        this.discover = !!params.discover;
        return {};
      case 'Bbm.configure':
        this.keepTabs = !!params.keepTabs;
        return {};
      case 'Bbm.setLabel': {
        const [previous, previousColor] = [this.label, this.color];
        this.label = String(params.label || '').slice(0, 40); // checked by the server (1-5 graphemes)
        this.color = params.color || 'purple'; // checked by the server (one of Chrome's colors)
        try {
          for (const groupId of this.groupByWindow.values()) {
            const group = await chrome.tabGroups.update(groupId, { title: this.title, color: this.color });
            if (group?.title !== this.title) throw new Error('Chrome did not apply the tab group title');
          }
          if (this.groupByWindow.size) await rememberColored(this.title, this.color);
        } catch (e) {
          [this.label, this.color] = [previous, previousColor];
          throw e;
        }
        return { groupsUpdated: this.groupByWindow.size, color: this.color };
      }
      case 'Bbm.clearForeignFrames':
        await clearForeignFrames(this.own(params.targetId));
        return {};
      case 'Bbm.resizeWindow': {
        // Only the agent's own window (BBM_WINDOW=agent): never resize the user's window.
        const tab = await chrome.tabs.get(this.own(params.targetId));
        if (tab.windowId !== this.agentWindowId) throw new Error('window resize works only for the agent window (BBM_WINDOW=agent); use responsive emulation');
        await chrome.windows.update(tab.windowId, { width: params.width, height: params.height, state: 'normal' });
        return {};
      }
      case 'Target.getTargets': {
        const tabs = await chrome.tabs.query({});
        return { targetInfos: tabs.filter((t) => this.agentTabs.has(t.id!)).map((t) => this.targetInfo(t)) };
      }
      case 'Target.createTarget': {
        const url = params.url || 'about:blank';
        const tab = params.newWindow
          ? await this.openInAgentWindow(url)
          : await chrome.tabs.create({ url, active: !params.background, windowId: await this.userWindow() });
        if (params.newWindow || !params.background) selfActivated.set(tab.id!, Date.now());
        await this.addToGroup(tab.id!);
        this.adopt(tab);
        return { targetId: String(tab.id) };
      }
      case 'Bbm.duplicateTarget': {
        // Chrome's Duplicate copies sessionStorage. It activates the copy: give the user's window its active tab back.
        const src = await chrome.tabs.get(this.own(params.targetId));
        const [prev] = await chrome.tabs.query({ active: true, windowId: src.windowId });
        const tab = await chrome.tabs.duplicate(src.id!);
        if (!tab?.id) throw new Error('duplicate failed');
        selfActivated.set(tab.id, Date.now());
        if (params.background && prev?.id != null && prev.id !== tab.id) await chrome.tabs.update(prev.id, { active: true });
        await this.addToGroup(tab.id);
        this.adopt(tab);
        return { targetId: String(tab.id) };
      }
      case 'Target.closeTarget':
        this.own(params.targetId);
        await chrome.tabs.remove(+params.targetId);
        return { success: true };
      case 'Target.activateTarget': {
        this.own(params.targetId);
        // Switches the active tab inside its window only; never focuses a window (that steals the user's focus).
        selfActivated.set(+params.targetId, Date.now());
        await chrome.tabs.update(+params.targetId, { active: true });
        return {};
      }
      case 'Target.attachToTarget': {
        const tabId = this.own(params.targetId);
        // Always attach: our 'attached' set can lag behind a detach Chrome has not reported yet.
        const attach = () =>
          chrome.debugger.attach({ tabId }, PROTOCOL).catch((e: Error) => {
            if (!/already attached/i.test(e.message)) throw e;
          });
        try {
          await attach();
        } catch (e: any) {
          // Chrome refuses the debugger while another extension's frame (a password manager menu) is in the page.
          if (!/chrome-extension/.test(e.message)) throw e;
          await clearForeignFrames(tabId);
          await attach();
        }
        this.attached.add(tabId);
        return { sessionId: tabSession(tabId) };
      }
      default:
        throw new Error(`${method} is not supported by the extension relay`);
    }
  }

  async onMessage(raw: string) {
    const { id, method, params, sessionId } = JSON.parse(raw);
    try {
      let result;
      if (/^(Input\.|Runtime\.(evaluate|callFunctionOn))/.test(method)) this.lastAgentInput = Date.now();
      if (!sessionId) result = await this.browserCommand(method, params);
      else {
        const tabId = this.tabOf(sessionId);
        if (tabId == null || !this.agentTabs.has(tabId)) throw new Error(`unknown session ${sessionId}`);
        const target: chrome.debugger.DebuggerSession = sessionId.startsWith('tab-') ? { tabId } : { tabId, sessionId };
        result = await chrome.debugger.sendCommand(target, method, params || {});
      }
      this.send({ id, result: result || {} });
    } catch (e: any) {
      this.send({ id, error: { code: -32000, message: e.message || String(e) } });
    }
  }

  // A failed connect doubles the wait before the next attempt; a pairing (or a new token/port) resets it.
  backOff() {
    this.nextTry = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, backoff.max);
  }
  resetBackoff(delay = 0) {
    this.retryDelay = backoff.min;
    this.nextTry = Date.now() + delay;
  }

  async connect(basePort: number, token: string) {
    if (this.ws && this.ws.readyState <= 1) return;
    if (Date.now() < this.nextTry) return;
    this.attemptTimes = [...this.attemptTimes.slice(-49), Date.now()];
    let sock: WebSocket;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${basePort + this.slot}/extension`);
    } catch {
      return;
    }
    this.ws = sock;
    this.ready = false;
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    let stage = 'hello';
    sock.onopen = () => {
      const manifest = chrome.runtime.getManifest();
      sock.send(JSON.stringify({ type: 'hello', nonce, build: manifest.version_name || manifest.version }));
    };
    sock.onmessage = async (e) => {
      if (this.ready) return this.onMessage(e.data);
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return sock.close();
      }
      if (stage === 'hello' && m.type === 'hello') {
        // The server must prove it knows the token before we run anything.
        if (m.proof !== (await hmac(token, `server:${nonce}`))) return sock.close();
        stage = 'auth';
        sock.send(JSON.stringify({ type: 'auth', proof: await hmac(token, `ext:${m.nonce}`) }));
      } else if (stage === 'auth' && m.type === 'ready') {
        this.ready = true;
        this.resetBackoff();
      } else sock.close();
    };
    sock.onclose = () => {
      if (this.ws !== sock) return;
      const wasReady = this.ready;
      this.ws = null;
      this.ready = false;
      if (wasReady) {
        this.resetBackoff(backoff.min); // the server left (e.g. /mcp restarts it): its next one comes soon
        void this.end();
      } else this.backOff();
    };
    sock.onerror = () => {};
  }

  // Session end: release the debugger (the yellow infobar goes away); close the untouched agent tabs,
  // keep (ungrouped) the ones the user looked at or pinned.
  async end() {
    for (const tabId of this.attached) chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.clear();
    this.childSession.clear();
    if (this.keepTabs) return; // tabs stay open and stay this slot's agent tabs for its next session
    const ids = [...this.agentTabs];
    this.agentTabs.clear();
    this.groupByWindow.clear();
    this.agentWindowId = null;
    this.label = '';
    this.color = 'purple';
    for (const id of ids) {
      owner.delete(id);
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) continue;
      if (this.touched.has(id) || tab.pinned) await chrome.tabs.ungroup(id).catch(() => {});
      else await chrome.tabs.remove(id).catch(() => {});
    }
    this.touched.clear();
  }
}

// Agent tabs only: blur the focused field (managers close their menu on blur) and remove other extensions' iframes.
async function clearForeignFrames(tabId: number) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: (own) => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        for (const f of document.querySelectorAll('iframe')) if (f.src.startsWith('chrome-extension://') && !f.src.startsWith(own)) f.remove();
      },
      args: [chrome.runtime.getURL('')],
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
}

const sessions = Array.from({ length: SLOTS }, (_, i) => new Session(i));
const owner = new Map<number, Session>(); // tabId -> Session
const selfActivated = new Map<number, number>(); // tabId -> time an agent activated it (not the user)

chrome.debugger.onEvent.addListener((source, method, params: Json) => {
  const s = owner.get(source.tabId!);
  if (!s) return;
  if (method === 'Target.attachedToTarget') s.childSession.set(params.sessionId, source.tabId!);
  if (method === 'Target.detachedFromTarget') s.childSession.delete(params.sessionId);
  s.send({ method, params, sessionId: source.sessionId || tabSession(source.tabId!) });
});

chrome.debugger.onDetach.addListener((source) => {
  const s = owner.get(source.tabId!);
  if (!s) return;
  s.attached.delete(source.tabId!);
  s.send({ method: 'Target.detachedFromTarget', params: { sessionId: tabSession(source.tabId!), targetId: String(source.tabId) } });
});

// Popups opened by agent tabs join the opener's session, but only right after that session's own input:
// a tab the user (or another extension) opens from an agent tab later stays the user's.
chrome.tabs.onCreated.addListener((tab) => {
  const s = tab.openerTabId != null && owner.get(tab.openerTabId);
  if (!s || Date.now() - s.lastAgentInput > 3000) return;
  void s.addToGroup(tab.id!).then(() => s.adopt(tab));
});
chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  const s = owner.get(tabId);
  if (s?.discover) s.send({ method: 'Target.targetInfoChanged', params: { targetInfo: s.targetInfo(tab) } });
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  const s = owner.get(tabId);
  if (!s) return;
  if (Date.now() - (selfActivated.get(tabId) || 0) < 1500) return; // an agent's own activation
  s.touched.add(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  selfActivated.delete(tabId);
  const s = owner.get(tabId);
  if (!s) return;
  owner.delete(tabId);
  s.touched.delete(tabId);
  s.agentTabs.delete(tabId);
  s.attached.delete(tabId);
  if (s.discover) s.send({ method: 'Target.targetDestroyed', params: { targetId: String(tabId) } });
});

let sweepCursor = SLOTS; // next slot of the running sweep (SLOTS = no sweep running)
async function connectAll() {
  const { port = DEFAULT_PORT, token = '' } = await chrome.storage.local.get<{ port?: number; token?: string }>(['port', 'token']);
  if (!token) return; // not paired: never connect
  // storage.session outlives a service-worker restart, so a worker that Chrome restarts every 30 s does not sweep each time.
  // A sweep tries one slot outside the window per tick, never all at once: Chrome queues connects to one host,
  // and a burst of refused ones would delay the pairing of a real server.
  const { lastSweep = 0 } = await chrome.storage.session.get<{ lastSweep?: number }>('lastSweep');
  if (Date.now() - lastSweep >= backoff.sweep) {
    sweepCursor = 0;
    await chrome.storage.session.set({ lastSweep: Date.now() });
  }
  const lastInWindow = sessions.reduce((m, s) => (s.ready ? Math.max(m, s.slot) : m), -1) + 2;
  for (const s of sessions) if (s.slot <= lastInWindow) void s.connect(+port, token);
  if (sweepCursor <= lastInWindow) sweepCursor = lastInWindow + 1; // the window is tried anyway
  if (sweepCursor < SLOTS) void sessions[sweepCursor++].connect(+port, token);
}

// ---- cleanup: agent groups no live session owns (left by a Chrome or service worker restart, or BBM_KEEP_TABS)
// are closed once no tab in them was used for cleanupDays (options page; default 7, 0 = off). Closing a group's
// last tab removes the group. Only groups with an agent title are candidates, and only purple ones or ones an
// agent colored (title + color remembered in storage, one key per pair so sessions never overwrite each other):
// never the user's groups.
const AGENT_TITLE = /^Agent( \d+)?(:\S{1,40})?$/u; // Agent, Agent 2, Agent:CT2, Agent:🧪
const DAY = 864e5;
const coloredKey = (title: string | undefined, color: string) => `colored:${title}|${color}`;

async function rememberColored(title: string, color: GroupColor) {
  if (color !== 'purple') await chrome.storage.local.set({ [coloredKey(title, color)]: 1 });
}

async function bbmCleanup({ now = Date.now() } = {}) {
  const { cleanupDays = 7 } = await chrome.storage.local.get<{ cleanupDays?: number }>('cleanupDays');
  if (!(cleanupDays > 0)) return 0;
  const live = new Set(sessions.flatMap((s) => [...s.groupByWindow.values()]));
  const colored = new Set(Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('colored:')));
  const stale: number[] = [];
  for (const g of await chrome.tabGroups.query({})) {
    if (live.has(g.id) || !AGENT_TITLE.test(g.title || '') || (g.color !== 'purple' && !colored.has(coloredKey(g.title, g.color)))) continue;
    const tabs = await chrome.tabs.query({ groupId: g.id });
    // lastAccessed is missing on very old Chrome: keep the group then.
    if (tabs.every((t) => t.lastAccessed && now - t.lastAccessed > cleanupDays * DAY)) stale.push(...tabs.map((t) => t.id!));
  }
  if (stale.length) await chrome.tabs.remove(stale).catch(() => {});
  // Forget the pairs no group has any more (closed here or by the user); keep those another group still uses.
  const left = new Set((await chrome.tabGroups.query({})).map((g) => coloredKey(g.title, g.color)));
  const gone = [...colored].filter((k) => !left.has(k));
  if (gone.length) await chrome.storage.local.remove(gone);
  return stale.length;
}
// Test hooks: bbmCleanup with a future `now`; bbmRemember = rememberColored; bbmBackoff to shorten the waits; bbmAttempts = connect times per slot.
// bbmDisconnect drops every server link, as an extension reload or a Chrome restart would; bbmSweep starts/stops a sweep.
Object.assign(globalThis, {
  bbmCleanup,
  bbmRemember: rememberColored,
  bbmBackoff: backoff,
  bbmAttempts: () => sessions.map((s) => s.attemptTimes),
  bbmDisconnect: () => {
    for (const s of sessions) s.ws?.close();
  },
  // bbmForget: lose what a service-worker restart loses (our groups), keep the tabs.
  bbmForget: () => {
    for (const x of sessions) x.groupByWindow.clear();
  },
  bbmSweep: (start: boolean) => {
    sweepCursor = start ? 0 : SLOTS;
  },
});
void chrome.alarms.create('bbm-cleanup', { periodInMinutes: 60 });

// Reconnect loop. Active WebSocket traffic keeps the MV3 service worker alive (Chrome 116+).
void chrome.alarms.create('bbm-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  void (a.name === 'bbm-cleanup' ? bbmCleanup() : connectAll());
});
// Pair at once when the token or port is saved (options page).
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.token && !changes.port) return;
  for (const s of sessions) {
    s.ws?.close();
    s.ws = null;
    s.resetBackoff();
  }
  void connectAll();
});
setInterval(() => {
  void connectAll();
  for (const s of sessions) s.send({ method: 'Relay.ping', params: {} });
}, 1000);
void connectAll();
