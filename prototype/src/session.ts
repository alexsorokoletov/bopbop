// One Controller per live browser link. When the link drops (extension reload, Chrome restart, crash), the next
// get() opens a new link and builds a new Controller, so the MCP server keeps working without a restart.
import type { CDPBrowser } from './cdp/browser.ts';
import { Controller, type ControllerOptions } from './controller.ts';

export const RECONNECT_NOTICE = '⚠ the browser connection dropped and is back: earlier tabs and refs are gone, tab ids start again at t1';

export class ControllerSource {
  #open: () => Promise<CDPBrowser>;
  #opts: ControllerOptions;
  #controller: Controller | undefined;
  #pending: Promise<Controller> | undefined;
  #lost = false;
  /** The browser being opened or in use: shutdown closes it. */
  browser: Promise<CDPBrowser> | undefined;

  constructor(open: () => Promise<CDPBrowser>, opts: ControllerOptions = {}) {
    this.#open = open;
    this.#opts = opts;
  }

  get(): Promise<Controller> {
    if (this.#controller && !this.#controller.browser.conn.closed) return Promise.resolve(this.#controller);
    if (this.#controller) {
      this.#controller = undefined;
      this.#lost = true;
    }
    // A failed open (no extension yet) is not cached: the next call tries again.
    this.#pending ||= this.#build().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #build() {
    this.browser = this.#open();
    const c = new Controller(await this.browser, this.#opts);
    await c.init();
    // The agent's label and color outlive a reconnect (the new extension link starts without them).
    c.onLabel = (label, color) => {
      this.#opts = { ...this.#opts, label, color };
    };
    if (this.#lost) {
      c.notice = RECONNECT_NOTICE;
      this.#lost = false;
    }
    this.#controller = c;
    return c;
  }
}
