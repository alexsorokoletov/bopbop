// One controlled tab over CDP: frames (incl. cross-origin OOPIFs), isolated-world agent,
// trusted input, dialogs, console + network buffers, settle-after-action.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pressKey } from './keys.ts';
import type { CDPSession, Json } from './connection.ts';
import type { CDPBrowser } from './browser.ts';

export type Allow = ((url: string) => boolean) | null;
export interface Deny {
  name(n: string): boolean;
  url(u: string): boolean;
  js(e: string): boolean;
  spec: { name: string; path: string; flags: string };
}
export interface Frame {
  id: string;
  parentId: string | null | undefined;
  session: CDPSession;
  ctx: number | null;
  mainCtx?: number | null;
  prefix: string;
  url: string;
}
export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
  src?: string;
  ts?: number;
}
export interface NetEntry {
  id: string;
  method: string;
  url: string;
  type?: string;
  ts: number;
  wall?: number;
  postData?: string;
  session: CDPSession;
  status: number | null;
  statusText?: string;
  mime?: string;
  timing?: Record<string, number>;
  protocol?: string;
  remote?: string;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  size?: number;
  end?: number;
  failed?: string;
  started?: number;
}
export interface SnapshotOpts {
  mode?: string;
  viewport?: boolean;
  ref?: string;
  scope?: string;
  frames?: boolean;
}
export interface Snapshot {
  lines: string[];
  url?: string;
  title?: string;
  injections: number;
  scroll?: { y: number; h: number; vh: number };
  modal: { ref: string; name: string } | null;
}
export interface LastSnapshot {
  lines: string[];
  url?: string;
  mode?: string;
  scope?: string;
  modal?: string;
}
export interface DialogPolicy {
  accept: boolean;
  text?: string;
  once?: boolean;
}
export interface ClickOpts {
  button?: string;
  count?: number;
  modifiers?: number;
}
export interface ScreenshotOpts {
  ref?: string;
  clip?: { x: number; y: number; width: number; height: number };
  padding?: number;
  fullPage?: boolean;
  marks?: boolean;
  quality?: number;
  scale?: 'fit' | 'full';
  maxWidth?: number;
}
export interface WaitOpts {
  text?: string;
  gone?: string;
  ref?: string;
  url?: string;
  timeout?: number;
}

const AGENT = readFileSync(fileURLToPath(new URL('../page/agent.js', import.meta.url)), 'utf8');
const WORLD = '__bbm';
// Frames of other extensions (password managers, ad blockers): the debugger may not touch them.
// Chrome reports them as chrome-extension:// or with a masked URL (":").
const foreignFrame = (url: string | undefined) => url === ':' || (url || '').startsWith('chrome-extension:');
const RING = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Tab {
  allow: Allow;
  deny: Deny | null;
  agentSrc: string;
  browser: CDPBrowser;
  targetId: string;
  root: CDPSession;
  sessions: Map<string, CDPSession>;
  frames: Map<string, Frame>;
  prefixes: Map<string, string>;
  nextFrame: number;
  mainFrameId: string | null;
  foreign: Set<string>;
  console: ConsoleEntry[];
  network: Map<string, NetEntry>;
  inflight: Set<string>;
  events: string[];
  dialogPolicy: DialogPolicy | null;
  lastSnapshot: LastSnapshot | null;
  closed: boolean;
  loads: number;
  ctxWaiters: (() => void)[];
  emulation: { metrics?: Json } | null = null;

  constructor(
    browser: CDPBrowser,
    targetId: string,
    session: CDPSession,
    { allow = null, deny = null, shield = true }: { allow?: Allow; deny?: Deny | null; shield?: boolean } = {},
  ) {
    this.allow = allow;
    this.deny = deny;
    this.agentSrc = AGENT + (deny ? `\n;globalThis.__bbm.guard(${JSON.stringify(deny.spec)});` : '') + (shield ? '\n;globalThis.__bbm.shield();' : '');
    this.browser = browser;
    this.targetId = targetId;
    this.root = session;
    this.sessions = new Map([[session.id, session]]); // sessionId -> session
    this.frames = new Map(); // frameId -> {id, parentId, session, ctx, prefix, url}
    this.prefixes = new Map(); // prefix -> frameId
    this.nextFrame = 1;
    this.mainFrameId = null;
    this.foreign = new Set(); // frame ids of other extensions' frames
    this.console = [];
    this.network = new Map(); // requestId -> entry
    this.inflight = new Set();
    this.events = []; // pending events for the next act result
    this.dialogPolicy = null; // {accept, text, once}
    this.lastSnapshot = null; // {lines: string[], url}
    this.closed = false;
    this.loads = 0; // DOMContentLoaded counter of the main frame
    this.ctxWaiters = [];
  }

  async init() {
    await this.#setupSession(this.root, true);
  }

  async #setupSession(s: CDPSession, isRoot: boolean): Promise<void> {
    s.on('Runtime.executionContextCreated', ({ context }) => {
      const fid = context.auxData?.frameId;
      if (!fid || this.foreign.has(fid) || foreignFrame(context.origin)) return;
      if (context.auxData.isDefault) {
        this.#frame(fid, s).mainCtx = context.id;
        return;
      }
      if (context.name !== WORLD) return;
      const f = this.#frame(fid, s);
      f.ctx = context.id;
      f.session = s;
      for (const w of this.ctxWaiters.splice(0)) w();
    });
    s.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      for (const f of this.frames.values()) {
        if (f.session !== s) continue;
        if (f.ctx === executionContextId) f.ctx = null;
        if (f.mainCtx === executionContextId) f.mainCtx = null;
      }
    });
    s.on('Runtime.executionContextsCleared', () => {
      for (const f of this.frames.values())
        if (f.session === s) {
          f.ctx = null;
          f.mainCtx = null;
        }
    });
    s.on('Page.frameAttached', ({ frameId, parentFrameId }) => {
      const f = this.#frame(frameId, s);
      f.parentId = parentFrameId;
    });
    s.on('Page.frameNavigated', ({ frame }) => {
      if (foreignFrame(frame.url)) {
        this.foreign.add(frame.id);
        return;
      }
      const f = this.#frame(frame.id, s);
      f.url = frame.url;
      if (!frame.parentId) {
        if (isRoot) {
          this.#setMain(frame.id);
          this.events.push(`navigated ${frame.url}`);
        }
      } else f.parentId = frame.parentId;
    });
    s.on('Page.frameDetached', ({ frameId, reason }) => {
      if (reason === 'swap') return; // moved to an OOPIF session
      const f = this.frames.get(frameId);
      if (f && f.session === s) {
        this.frames.delete(frameId);
        this.prefixes.delete(f.prefix);
      }
    });
    s.on('Page.javascriptDialogOpening', (p) => this.#onDialog(s, p));
    if (isRoot)
      s.on('Page.domContentEventFired', () => {
        this.loads++;
      });
    s.on('Runtime.consoleAPICalled', (p) =>
      this.#pushConsole({
        level: p.type === 'warning' ? 'warn' : p.type,
        text: p.args
          .map((a: Json) => a.value ?? a.unserializableValue ?? a.description ?? a.type)
          .join(' ')
          .slice(0, 2000),
        url: p.stackTrace?.callFrames?.[0]?.url,
        line: p.stackTrace?.callFrames?.[0]?.lineNumber,
      }),
    );
    s.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) =>
      this.#pushConsole({
        level: 'error',
        text: (d.exception?.description || d.text || 'exception').slice(0, 2000),
        url: d.url,
        line: d.lineNumber,
      }),
    );
    s.on('Log.entryAdded', ({ entry }) =>
      this.#pushConsole({ level: entry.level === 'warning' ? 'warn' : entry.level, text: entry.text, url: entry.url, src: entry.source }),
    );
    s.on('Network.requestWillBeSent', (p) => {
      if (p.type === 'WebSocket' || p.type === 'EventSource') return;
      if (p.request.url.startsWith('chrome-extension:')) return; // other extensions' scripts in the page: not the site's traffic
      this.network.set(p.requestId, {
        id: p.requestId,
        method: p.request.method,
        url: p.request.url,
        type: p.type,
        ts: p.timestamp,
        wall: p.wallTime,
        postData: p.request.postData?.slice(0, 2000),
        session: s,
        status: null,
        reqHeaders: p.request.headers,
      });
      this.inflight.add(p.requestId);
      if (this.network.size > RING) this.network.delete(this.network.keys().next().value!);
    });
    s.on('Network.responseReceived', ({ requestId, response }) => {
      const e = this.network.get(requestId);
      if (e)
        Object.assign(e, {
          status: response.status,
          statusText: response.statusText,
          mime: response.mimeType,
          timing: response.timing,
          resHeaders: { ...response.headers, ...e.resHeaders },
          protocol: response.protocol,
          remote: response.remoteIPAddress,
        });
    });
    // Raw headers as sent and received, including Cookie and Set-Cookie (the plain events leave them out).
    s.on('Network.requestWillBeSentExtraInfo', ({ requestId, headers }) => {
      const e = this.network.get(requestId);
      if (e) e.reqHeaders = { ...e.reqHeaders, ...headers };
    });
    s.on('Network.responseReceivedExtraInfo', ({ requestId, headers }) => {
      const e = this.network.get(requestId);
      if (e) e.resHeaders = { ...e.resHeaders, ...headers };
    });
    s.on('Network.loadingFinished', ({ requestId, encodedDataLength, timestamp }) => {
      this.inflight.delete(requestId);
      const e = this.network.get(requestId);
      if (e) {
        e.size = encodedDataLength;
        e.end = timestamp;
      }
    });
    s.on('Network.loadingFailed', ({ requestId, errorText, canceled, timestamp }) => {
      this.inflight.delete(requestId);
      const e = this.network.get(requestId);
      if (e) {
        e.failed = canceled ? 'canceled' : errorText;
        e.end = timestamp;
      }
    });
    // Child targets: cross-origin iframes (OOPIF) and workers.
    s.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
      const child = s.conn.session(sessionId);
      if (foreignFrame(targetInfo.url)) {
        if (waitingForDebugger) child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        s.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        return;
      }
      if (targetInfo.type === 'iframe') {
        this.sessions.set(sessionId, child);
        try {
          await this.#setupSession(child, false);
        } catch {}
      }
      if (waitingForDebugger) child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    });
    s.on('Target.detachedFromTarget', ({ sessionId }) => {
      this.sessions.delete(sessionId);
      for (const [id, f] of this.frames)
        if (f.session?.id === sessionId) {
          this.frames.delete(id);
          this.prefixes.delete(f.prefix);
        }
    });

    if (this.allow || this.deny) {
      // Enforce allowlist and deny policy inside the browser: page-initiated navigations, redirects, frames, popups.
      s.on('Fetch.requestPaused', ({ requestId, request }) => {
        const why = this.allow && !this.allow(request.url) ? 'not in allowlist' : this.deny?.url(request.url) ? 'blocked_by_policy' : null;
        if (!why) {
          s.send('Fetch.continueRequest', { requestId }).catch(() => {});
          return;
        }
        this.events.push(`blocked navigation to ${request.url.slice(0, 100)} (${why})`);
        s.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      });
      await s.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    }
    await Promise.all([
      s.send('Page.enable'),
      s.send('Runtime.enable'),
      s.send('Network.enable', { maxPostDataSize: 2000 }),
      isRoot ? s.send('Performance.enable').catch(() => {}) : null, // perf counters (layouts, script time) count from here
      s.send('Log.enable').catch(() => {}),
      // page keeps "focused" behaviour when the window is in the background (real-profile modes)
      isRoot ? s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}) : null,
      s.send('Page.addScriptToEvaluateOnNewDocument', { source: this.agentSrc, worldName: WORLD }),
      s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {}),
    ]);
    // Install the agent into the frames that already exist.
    const { frameTree } = await s.send('Page.getFrameTree');
    const visit = async (node: Json, parentId: string | null | undefined): Promise<void> => {
      if (foreignFrame(node.frame.url)) {
        this.foreign.add(node.frame.id);
        return;
      }
      const f = this.#frame(node.frame.id, s);
      f.url = node.frame.url;
      if (parentId) f.parentId = parentId;
      if (!parentId && isRoot) this.#setMain(node.frame.id);
      try {
        const { executionContextId } = await s.send('Page.createIsolatedWorld', { frameId: node.frame.id, worldName: WORLD });
        await s.send('Runtime.evaluate', { expression: this.agentSrc, contextId: executionContextId });
        f.ctx = f.ctx || executionContextId;
      } catch {}
      for (const c of node.childFrames || []) await visit(c, node.frame.id);
    };
    await visit(frameTree, isRoot ? null : undefined);
    if (!isRoot) s.send('Runtime.runIfWaitingForDebugger').catch(() => {});
  }

  // The main frame owns the empty ref prefix (e12, not f1e12). Another frame's context can be reported
  // first (e.g. an extension iframe after a re-attach) and take it; give it back here.
  #setMain(fid: string) {
    this.mainFrameId = fid;
    const f = this.frames.get(fid);
    if (!f || f.prefix === '') return;
    const other = this.frames.get(this.prefixes.get('') ?? '');
    if (other) {
      other.prefix = `f${this.nextFrame++}`;
      this.prefixes.set(other.prefix, other.id);
    }
    this.prefixes.delete(f.prefix);
    f.prefix = '';
    this.prefixes.set('', fid);
  }

  #frame(id: string, session: CDPSession): Frame {
    let f = this.frames.get(id);
    if (!f) {
      const prefix = this.mainFrameId === null && session === this.root && this.frames.size === 0 ? '' : `f${this.nextFrame++}`;
      f = { id, parentId: null, session, ctx: null, prefix, url: '' };
      this.frames.set(id, f);
      this.prefixes.set(prefix, id);
    } else if (session !== this.root && f.session === this.root) {
      f.session = session; // swapped into an OOPIF session
    }
    return f;
  }

  #pushConsole(e: ConsoleEntry) {
    e.ts = Date.now();
    this.console.push(e);
    if (this.console.length > RING) this.console.shift();
  }

  async #onDialog(s: CDPSession, { type, message, defaultPrompt }: { type: string; message: string; defaultPrompt?: string }) {
    const pol: DialogPolicy = this.dialogPolicy || { accept: true };
    if (this.dialogPolicy?.once) this.dialogPolicy = null;
    const accept = type === 'beforeunload' ? true : pol.accept;
    const promptText = type === 'prompt' ? (pol.text ?? defaultPrompt ?? '') : undefined;
    try {
      await s.send('Page.handleJavaScriptDialog', { accept, promptText });
    } catch {}
    this.events.push(
      `dialog ${type} ${JSON.stringify(message.slice(0, 120))} -> ${accept ? 'accepted' : 'dismissed'}${type === 'prompt' && accept ? ` with ${JSON.stringify(promptText)}` : ''}`,
    );
  }

  // ---- agent calls ----
  frameForRef(ref: string | undefined): string {
    const m = /^(f\d+)?e\d+$/.exec(ref || '');
    if (!m) throw new Error(`bad ref "${ref}" (expected e12 or f2e7)`);
    const fid = this.prefixes.get(m[1] || '');
    if (!fid) throw new Error(`frame of ref ${ref} is gone; take a new snapshot`);
    return fid;
  }

  get mainFrame() {
    return this.mainFrameId === null ? undefined : this.frames.get(this.mainFrameId);
  }

  /** The main frame id; a tab always has one once init() has run. */
  get mainId(): string {
    if (this.mainFrameId === null) throw new Error('page has no main frame yet');
    return this.mainFrameId;
  }

  async #ctx(fid: string, timeout = 10000): Promise<Frame> {
    const t0 = Date.now();
    for (;;) {
      const f = this.frames.get(fid);
      if (!f) throw new Error('frame is gone');
      if (f.ctx) return f;
      if (Date.now() - t0 > timeout) {
        // last resort: create the world now
        const { executionContextId } = await f.session.send('Page.createIsolatedWorld', { frameId: fid, worldName: WORLD });
        await f.session.send('Runtime.evaluate', { expression: this.agentSrc, contextId: executionContextId });
        f.ctx = executionContextId;
        return f;
      }
      await new Promise<void>((r) => {
        this.ctxWaiters.push(r);
        setTimeout(r, 200);
      });
    }
  }

  async call(fid: string, fn: string, args: Json[] = [], { byValue = true } = {}): Promise<Json> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await this.#ctx(fid);
      try {
        const res = await f.session.send('Runtime.evaluate', {
          expression: `globalThis.__bbm.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`,
          contextId: f.ctx,
          returnByValue: byValue,
          awaitPromise: true,
        });
        if (res.exceptionDetails) {
          const msg: string = res.exceptionDetails.exception?.description?.split('\n')[0] || res.exceptionDetails.text;
          // world without agent (a fresh world after a re-attach reports "reading '<fn>'" without naming __bbm)
          if ((/__bbm/.test(msg) || msg.includes(`reading '${fn}'`)) && attempt < 2) {
            await f.session.send('Runtime.evaluate', { expression: this.agentSrc, contextId: f.ctx });
            continue;
          }
          throw new Error(msg.replace(/^Error: /, ''));
        }
        return byValue ? res.result.value : res.result;
      } catch (e: any) {
        if (/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(e.message) && attempt < 2) {
          f.ctx = null;
          await sleep(100);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`call ${fn}: no page context after 3 attempts`); // not reached: the last attempt returns or throws
  }

  // ---- snapshot ----
  async snapshot(opts: SnapshotOpts = {}): Promise<Snapshot> {
    const lines: string[] = [];
    let injections = 0;
    const visit = async (fid: string, depth: number, ref?: string): Promise<Json> => {
      const f = this.frames.get(fid)!;
      let snap;
      try {
        snap = await this.call(fid, 'snapshot', [{ prefix: f.prefix, mode: opts.mode, viewport: opts.viewport, ref }]);
      } catch (e: any) {
        if (depth === 0) throw e; // the page (or the scope) itself: no snapshot, not one with no URL
        lines.push(' '.repeat(depth) + `(frame unavailable: ${e.message})`);
        return null;
      }
      if (snap.error) throw new Error(snap.error);
      injections += snap.injections;
      const childAt = new Map();
      for (const fr of snap.frames) childAt.set(fr.at, fr);
      for (let i = 0; i < snap.lines.length; i++) {
        const l = snap.lines[i];
        lines.push(' '.repeat(depth + l.d) + l.t);
        const fr = childAt.get(i);
        if (fr && (opts.frames ?? true)) {
          const cfid = await this.#childFrameId(fid, fr.ref).catch(() => null);
          if (cfid) await visit(cfid, depth + fr.depth + 1);
          else lines.push(' '.repeat(depth + fr.depth + 1) + '(frame not loaded)');
        }
      }
      return snap;
    };
    let ref = opts.ref,
      modal: Snapshot['modal'] = null;
    const scope = opts.scope || 'auto';
    if (!ref && scope !== 'auto' && scope !== 'page') ref = scope;
    if (!ref && scope === 'auto') {
      modal = await this.call(this.mainId, 'modal', [this.mainFrame?.prefix || '']).catch(() => null);
      if (modal) ref = modal.ref;
    }
    let fid = this.mainId;
    if (ref) fid = this.frameForRef(ref);
    const top = await visit(fid, 0, ref);
    return { lines, url: top?.url, title: top?.title, injections, scroll: top?.scroll, modal };
  }

  async #childFrameId(fid: string, ref: string) {
    const f = this.frames.get(fid)!;
    const obj = await this.call(fid, 'el', [ref], { byValue: false });
    const { node } = await f.session.send('DOM.describeNode', { objectId: obj.objectId });
    f.session.send('Runtime.releaseObject', { objectId: obj.objectId }).catch(() => {});
    const id = node.frameId || node.contentDocument?.frameId;
    return id && this.frames.has(id) ? id : null;
  }

  // Offset of a frame's viewport inside the top-level viewport.
  async frameOffset(fid: string): Promise<{ x: number; y: number }> {
    const f = this.frames.get(fid)!;
    if (!f.parentId || fid === this.mainFrameId) return { x: 0, y: 0 };
    const parent = this.frames.get(f.parentId);
    if (!parent) return { x: 0, y: 0 };
    const s = parent.session;
    const { backendNodeId } = await s.send('DOM.getFrameOwner', { frameId: fid });
    const { model } = await s.send('DOM.getBoxModel', { backendNodeId });
    // In-process frames: quads are relative to the session's root frame viewport.
    let rootFid: string = f.parentId;
    for (let r = this.frames.get(rootFid); r?.parentId && this.frames.get(r.parentId)?.session === s; r = this.frames.get(rootFid)) rootFid = r.parentId;
    const base = s === this.root ? { x: 0, y: 0 } : await this.frameOffset(rootFid);
    return { x: base.x + model.content[0], y: base.y + model.content[1] };
  }

  async #scrollOwners(fid: string) {
    let f = this.frames.get(fid);
    while (f && f.parentId && f.id !== this.mainFrameId) {
      const parent = this.frames.get(f.parentId);
      if (!parent) break;
      try {
        const { backendNodeId } = await parent.session.send('DOM.getFrameOwner', { frameId: f.id });
        await parent.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
      } catch {}
      f = parent;
    }
  }

  async point(ref: string, opts: { block?: string; noScroll?: boolean; position?: string } = {}) {
    const fid = this.frameForRef(ref);
    await this.#scrollOwners(fid);
    const p = await this.call(fid, 'point', [ref, opts]);
    if (p.error) throw new Error(p.error);
    const off = await this.frameOffset(fid);
    return { ...p, x: p.x + off.x, y: p.y + off.y, fid };
  }

  // ---- input ----
  async mouseClick(x: number, y: number, { button = 'left', count = 1, modifiers = 0 }: ClickOpts = {}) {
    const s = this.root;
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    for (let i = 1; i <= count; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
    }
  }

  async click(ref: string, opts: ClickOpts = {}) {
    const p = await this.point(ref);
    await this.mouseClick(p.x, p.y, opts);
    return p;
  }

  async hover(ref: string) {
    const p = await this.point(ref);
    await this.root.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    return p;
  }

  press(combo: string) {
    return pressKey(this.root, combo);
  }

  async type(ref: string, text: string, { clear = true, submit = false, noFocus = false } = {}) {
    const fid = this.frameForRef(ref);
    const info = await this.call(fid, 'info', [ref]);
    // noFocus: fill without focusing (a password manager that re-injects its menu on every focus)
    const direct = noFocus || info.tag === 'select' || ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(info.type);
    const notes: string[] = [];
    if (direct) {
      const res = await this.setValue(ref, text);
      notes.push(`set value ${JSON.stringify(res.value)}`);
    } else {
      try {
        const p = await this.click(ref);
        if (p.covered) notes.push(`covered by ${p.covered}`);
      } catch (e: any) {
        notes.push(e.message);
      }
      await this.call(fid, 'focus', [ref, { clear }]);
      await this.root.send('Input.insertText', { text });
    }
    if (submit) await this.press('Enter');
    return notes;
  }

  setValue(ref: string, value: string | string[]) {
    return this.call(this.frameForRef(ref), 'setValue', [ref, value]);
  }

  // select: native <select> -> set value; custom combobox -> behave like a user and verify the commit.
  async select(ref: string, value: string | string[]) {
    const fid = this.frameForRef(ref);
    const info = await this.call(fid, 'info', [ref]);
    if (info.tag === 'select' || Array.isArray(value)) return `= ${JSON.stringify((await this.setValue(ref, value)).value)}`;
    const want = String(value).toLowerCase().trim();
    const f = this.frames.get(fid)!;
    const st0 = await this.call(fid, 'comboState', [ref]);
    if (st0.editable) await this.type(ref, String(value), { clear: true });
    else await this.click(ref);
    await this.settle({ max: 1500 });
    const committed = async () => {
      const st = await this.call(fid, 'comboState', [ref]);
      return !st.expanded && st.value.toLowerCase().includes(want);
    };
    const opt = await this.call(fid, 'optionRef', [String(value), f.prefix]);
    if (opt) {
      await this.click(opt);
      await this.settle({ max: 1500 });
      if (await committed()) return `clicked option ${opt}`;
    }
    // keyboard fallback (some widgets ignore mouse on options)
    if (st0.editable || opt) {
      if (!st0.editable) await this.call(fid, 'focus', [ref]);
      for (let i = 1; i <= 60; i++) {
        await this.press('ArrowDown');
        const st = await this.call(fid, 'comboState', [ref]);
        if (st.active.toLowerCase() === want || (st.active && st.active.toLowerCase().includes(want))) {
          await this.press('Enter');
          await this.settle({ max: 1500 });
          if (await committed()) return `keyboard ArrowDown×${i} + Enter`;
          break;
        }
        if (!st.active && i > 3) break;
      }
    }
    const st = await this.call(fid, 'comboState', [ref]);
    throw new Error(
      `could not commit ${JSON.stringify(String(value))} (value now ${JSON.stringify(st.value)}${st.expanded ? ', list still open' : ''}); try snapshot + click option or keys`,
    );
  }

  async upload(ref: string, files: string[]) {
    const fid = this.frameForRef(ref);
    const f = this.frames.get(fid)!;
    const info = await this.call(fid, 'info', [ref]);
    if (info.tag === 'input' && info.type === 'file') {
      const obj = await this.call(fid, 'el', [ref], { byValue: false });
      await f.session.send('DOM.setFileInputFiles', { files, objectId: obj.objectId });
      return 'files set on input';
    }
    // drop zone: synthesize a native file drop
    const p = await this.point(ref);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await this.root.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data });
    }
    return 'files dropped';
  }

  async drag(fromRef: string, toRef: string, { position }: { position?: string } = {}) {
    // Scroll both into view first; measure without scrolling so nothing moves while the button is down.
    await this.point(toRef, { block: 'nearest' });
    await this.point(fromRef, { block: 'nearest' });
    const a = await this.point(fromRef, { noScroll: true });
    const b = await this.point(toRef, { position, noScroll: true });
    const s = this.root;
    let intercepted: Json = null;
    const off = s.on('Input.dragIntercepted', ({ data }) => {
      intercepted = data;
    });
    await s.send('Input.setInterceptDrags', { enabled: true });
    try {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 5; i++) {
        await s.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: a.x + ((b.x - a.x) * i) / 5,
          y: a.y + ((b.y - a.y) * i) / 5,
          button: 'left',
          buttons: 1,
        });
      }
      await sleep(30);
      if (intercepted) {
        for (const type of ['dragEnter', 'dragOver', 'drop']) await s.send('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data: intercepted });
      }
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      return intercepted ? 'html5 drag' : 'mouse drag';
    } finally {
      off();
      await s.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
  }

  // ---- waiting ----
  async settle({ max = 3000 } = {}) {
    const t0 = Date.now();
    // 1. a navigation may be in flight: wait for the agent world of the new document
    await sleep(30);
    // 2. network quiet for 300ms (ignore long-lived requests older than 2s)
    let quietSince = Date.now();
    while (Date.now() - t0 < max) {
      const now = Date.now();
      let busy = 0;
      for (const id of this.inflight) {
        const e = this.network.get(id);
        if (!e) {
          this.inflight.delete(id);
          continue;
        }
        if (e.started === undefined) e.started = now;
        if (now - e.started < 2000) busy++;
      }
      if (busy) quietSince = now;
      if (now - quietSince >= 150 && this.mainFrame?.ctx) break;
      await sleep(40);
    }
    if (process.env.BBM_TRACE)
      console.error(`[settle] network ${Date.now() - t0}ms inflight=${[...this.inflight].map((id) => this.network.get(id)?.url).join(',')}`);
    // 3. DOM quiet
    try {
      await this.call(this.mainId, 'settle', [{ quiet: 100, max: Math.max(1500, max - (Date.now() - t0)) }]);
    } catch {}
    return Date.now() - t0;
  }

  async waitFor(opts: WaitOpts): Promise<{ ok: boolean; ms: number; frame?: string }> {
    const timeout = Math.min(opts.timeout ?? 10000, 60000);
    const t0 = Date.now();
    if (opts.url) {
      const re = new RegExp(opts.url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
      while (Date.now() - t0 < timeout) {
        if (re.test(this.mainFrame?.url || '')) break;
        await sleep(100);
      }
      if (!re.test(this.mainFrame?.url || '')) return { ok: false, ms: Date.now() - t0 };
    }
    if (opts.text || opts.gone || opts.ref) {
      while (Date.now() - t0 < timeout) {
        try {
          const fid = opts.ref ? this.frameForRef(opts.ref) : this.mainId;
          const r = await this.call(fid, 'waitFor', [{ text: opts.text, gone: opts.gone, ref: opts.ref, timeout: timeout - (Date.now() - t0) }]);
          if (r.ok) return { ok: true, ms: Date.now() - t0 };
          // text may live in a child frame
          if (opts.text && !opts.ref) {
            for (const f of this.frames.values()) {
              if (f.id === this.mainFrameId) continue;
              if (await this.call(f.id, 'hasText', [opts.text]).catch(() => false)) return { ok: true, ms: Date.now() - t0, frame: f.prefix };
            }
          }
          break;
        } catch (e: any) {
          if (/navigat|context|gone/i.test(e.message)) {
            await sleep(150);
            continue;
          }
          throw e;
        }
      }
      return { ok: false, ms: Date.now() - t0 };
    }
    return { ok: true, ms: Date.now() - t0 };
  }

  async navigate(url: string) {
    const loads = this.loads;
    let newDoc = true;
    if (url === 'back' || url === 'forward') {
      const { currentIndex, entries } = await this.root.send('Page.getNavigationHistory');
      const e = entries[currentIndex + (url === 'back' ? -1 : 1)];
      if (!e) throw new Error(`no ${url} history entry`);
      await this.root.send('Page.navigateToHistoryEntry', { entryId: e.id });
    } else if (url === 'reload') {
      await this.root.send('Page.reload');
    } else {
      const res = await this.root.send('Page.navigate', { url });
      if (res.errorText) throw new Error(`navigation failed: ${res.errorText}`);
      newDoc = !!res.loaderId;
    }
    const tl = Date.now();
    if (newDoc) await this.waitLoad(loads);
    if (process.env.BBM_TRACE) console.error(`[navigate] load ${Date.now() - tl}ms loads=${this.loads}`);
    await this.settle({ max: 3000 });
  }

  // Wait until DOMContentLoaded fired after the given load counter.
  async waitLoad(since: number, timeout = 15000) {
    const t0 = Date.now();
    while (this.loads <= since && Date.now() - t0 < timeout) await sleep(30);
  }

  // area = what to capture in CSS px: a ref, clip {x, y, width, height} (viewport coordinates, as getBoundingClientRect
  // gives), the full page, or the viewport. padding grows ref/clip areas. scale 'fit' keeps the image at most
  // maxWidth device px wide; 'full' keeps every device pixel. Returned scale = image px per CSS px.
  async screenshot({ ref, clip: box, padding = 0, fullPage = false, marks = false, quality = 60, scale: mode = 'fit', maxWidth = 1280 }: ScreenshotOpts = {}) {
    if (marks) for (const f of this.frames.values()) await this.call(f.id, 'marks', [true]).catch(() => {});
    try {
      const params: Json = { format: 'jpeg', quality };
      const { cssLayoutViewport: vp, cssContentSize } = await this.root.send('Page.getLayoutMetrics');
      let area: { x: number; y: number; width: number; height: number } | undefined; // viewport coordinates, except fullPage (page coordinates)
      if (ref) {
        const fid = this.frameForRef(ref);
        await this.call(fid, 'point', [ref]);
        const r = await this.call(fid, 'rect', [ref]);
        const off = await this.frameOffset(fid);
        area = { x: r.x + off.x, y: r.y + off.y, width: r.w, height: r.h };
      } else if (box) {
        area = { x: box.x, y: box.y, width: box.width, height: box.height };
      }
      let clip;
      if (area) {
        const x = Math.max(0, area.x - padding),
          y = Math.max(0, area.y - padding);
        area = { x, y, width: Math.max(1, area.x + area.width + padding - x), height: Math.max(1, area.y + area.height + padding - y) };
        clip = { ...area, x: area.x + vp.pageX, y: area.y + vp.pageY };
        if (box) params.captureBeyondViewport = true; // a clip may reach below the fold
      } else if (fullPage) {
        clip = area = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 8000) };
        params.captureBeyondViewport = true;
      } else {
        clip = { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight };
        area = { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight };
      }
      // maxWidth is in device pixels: on a 2x display a 1000-CSS-px viewport is 2000 px.
      const dpr =
        (await this.evaluate('devicePixelRatio')
          .then(Number)
          .catch(() => 1)) || 1;
      const s = mode === 'full' ? 1 : Math.min(1, maxWidth / (clip.width * dpr));
      params.clip = { ...clip, scale: s };
      const { data } = await this.root.send('Page.captureScreenshot', params);
      const scale = s * dpr;
      return {
        data,
        scale,
        width: Math.round(clip.width * scale),
        height: Math.round(clip.height * scale),
        area: { x: Math.round(area.x), y: Math.round(area.y), width: Math.round(area.width), height: Math.round(area.height), page: fullPage && !ref && !box },
        viewport: { w: vp.clientWidth, h: vp.clientHeight },
      };
    } finally {
      if (marks) for (const f of this.frames.values()) await this.call(f.id, 'marks', [false]).catch(() => {});
    }
  }

  // Evaluate JS in the page's main world (page globals visible). With ref: function receives the element.
  // A returned Promise is awaited (up to timeout ms); values JSON cannot carry are made readable (see NORM).
  async evaluate(expression: string, { ref, frame, timeout = 30000 }: { ref?: string; frame?: string; timeout?: number } = {}): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`eval timed out after ${timeout}ms (the page may still run it)`)), timeout);
    });
    try {
      return await Promise.race([this.#evaluate(expression, { ref, frame }), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #evaluate(expression: string, { ref, frame }: { ref?: string; frame?: string }): Promise<string> {
    const fid = ref ? this.frameForRef(ref) : ((frame ? this.prefixes.get(frame) : null) ?? this.mainFrameId);
    const f = fid == null ? undefined : this.frames.get(fid);
    if (!f) throw new Error(`unknown frame ${frame}`);
    const isFn = /^\s*(async\s+)?(\([^)]*\)\s*=>|function\b|[a-zA-Z_$][\w$]*\s*=>)/.test(expression);
    const byValue = (objectId: string, body: string) =>
      f.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `async function(){ ${NORM} return norm(${body}); }`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
    if (ref) {
      const obj = await this.call(fid!, 'el', [ref], { byValue: false });
      const fn = isFn ? expression : `(el) => (${expression})`;
      return fmtEval(await byValue(obj.objectId, `await (${fn})(this)`));
    }
    // Evaluate as written; if the value is a function, call it (lets callers pass "() => ..."). Objects (a
    // Promise from fetch().then(), an async IIFE) are awaited and read back by value.
    let res = await f.session.send('Runtime.evaluate', {
      expression,
      contextId: f.mainCtx || undefined,
      returnByValue: false,
      awaitPromise: true,
      replMode: true,
      userGesture: true,
    });
    if (!res.exceptionDetails && res.result.type === 'function') res = await byValue(res.result.objectId, 'await this()');
    else if (!res.exceptionDetails && res.result.objectId) res = await byValue(res.result.objectId, 'await this').catch(() => res);
    return fmtEval(res);
  }
}

// In-page helper: Headers/Map/URLSearchParams -> object, Set -> array, DOM node -> HTML excerpt,
// Response -> a hint to read its body, other class instances that JSON shows as {} -> [ClassName].
// A cross-origin Window throws on any property read: it shows as [Window].
const NORM = `const norm = (v) => { try { return norm1(v); } catch { return '[Window]'; } };
const norm1 = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype) return v;
  if (typeof Node !== 'undefined' && v instanceof Node) return (v.outerHTML || v.textContent || '').slice(0, 2000);
  if (typeof Response !== 'undefined' && v instanceof Response) return '[Response ' + v.status + ' ' + v.url + '] read the body in the same eval: (await r.json()) or (await r.text())';
  let json; try { json = JSON.stringify(v); } catch { return '[' + (v.constructor?.name || 'object') + ']'; }
  if (json !== '{}') return v;
  if (typeof v[Symbol.iterator] === 'function') { const a = [...v]; return a.every((e) => Array.isArray(e) && e.length === 2) ? Object.fromEntries(a) : a; }
  return '[' + (v.constructor?.name || 'object') + ']';
};`;

function fmtEval(res: Json): string {
  if (res.exceptionDetails) throw new Error((res.exceptionDetails.exception?.description || res.exceptionDetails.text).split('\n').slice(0, 3).join('\n'));
  const r = res.result;
  if (r.type === 'undefined') return 'undefined';
  if ('value' in r) return typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 1);
  return r.description || r.type;
}
