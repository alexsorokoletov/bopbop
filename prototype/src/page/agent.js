// @ts-check
// Page agent. Injected into an isolated world of every frame.
// Browser-agnostic: needs only DOM APIs. Exposes globalThis.__bbm.
(() => {
  if (globalThis.__bbm) return;

  const refOf = new WeakMap(); // Element -> number
  const byNum = new Map(); // number -> {ref: WeakRef<Element>, fp: fingerprint}
  let seq = 0;

  const INTERACTIVE = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'file',
    'date',
    'treeitem',
    'colorpicker',
    'clickable',
    'canvas',
    'iframe',
    'draggable',
  ]);
  const CONTAINER = new Set([
    'navigation',
    'main',
    'form',
    'dialog',
    'alertdialog',
    'list',
    'table',
    'group',
    'menu',
    'menubar',
    'tablist',
    'tabpanel',
    'region',
    'search',
    'banner',
    'contentinfo',
    'complementary',
    'listbox',
    'tree',
    'grid',
    'radiogroup',
    'toolbar',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'link',
    'button',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'treeitem',
    'heading',
    'clickable',
    'cell',
    'columnheader',
    'switch',
    'checkbox',
    'radio',
  ]);
  const INPUT_ROLES = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    file: 'file',
    color: 'colorpicker',
    date: 'date',
    'datetime-local': 'date',
    time: 'date',
    month: 'date',
    week: 'date',
  };
  const TAG_ROLES = {
    button: 'button',
    textarea: 'textbox',
    nav: 'navigation',
    main: 'main',
    form: 'form',
    dialog: 'dialog',
    ul: 'list',
    ol: 'list',
    menu: 'list',
    table: 'table',
    tr: 'row',
    th: 'columnheader',
    td: 'cell',
    option: 'option',
    summary: 'button',
    fieldset: 'group',
    iframe: 'iframe',
    frame: 'iframe',
    canvas: 'canvas',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    search: 'search',
  };
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'svg', 'path']);
  const INJECTION =
    /ignore (all |any |your |the )?(previous |prior |above )?(instructions|prompts?)|system (prompt|override)|you are now|disregard (all|previous|your)|new instructions|exfiltrat|(ai|automated) (assistants?|agents?)|note to (the )?(ai|agent|assistant)/i;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const q = (s) => JSON.stringify(s);

  function refFor(el) {
    let n = refOf.get(el);
    if (!n) {
      n = ++seq;
      refOf.set(el, n);
      byNum.set(n, { ref: new WeakRef(el), fp: null });
    }
    return n;
  }

  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r.split(/\s+/)[0];
    const t = el.localName;
    if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'input') {
      if (el.type === 'hidden') return null;
      return INPUT_ROLES[el.type] || 'textbox';
    }
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'img') return el.getAttribute('alt') === '' ? null : 'img';
    if (TAG_ROLES[t]) return TAG_ROLES[t];
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    if (el.getAttribute('draggable') === 'true') return 'draggable';
    return null;
  }

  // Composed-tree children: shadow root content, slot assignments, then light DOM.
  function children(node) {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (node.localName === 'slot') {
      const a = node.assignedNodes({ flatten: true });
      return a.length ? a : [...node.childNodes];
    }
    return [...node.childNodes];
  }

  function textOf(node, max = 200) {
    let out = '';
    const walk = (n) => {
      if (out.length > max) return;
      if (n.nodeType === 3) {
        out += n.data;
        return;
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        if (SKIP_TAGS.has(n.localName) || n.localName === 'select' || n.localName === 'datalist') return;
        if (n.getAttribute('aria-hidden') === 'true') return;
        if (n.localName === 'img') {
          out += ' ' + (n.getAttribute('alt') || '') + ' ';
          return;
        }
        if (n.localName === 'input' && ['submit', 'button'].includes(n.type)) {
          out += ' ' + n.value + ' ';
          return;
        }
      }
      for (const c of children(n)) walk(c);
    };
    walk(node);
    return norm(out);
  }

  function byId(el, id) {
    const root = el.getRootNode();
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  }

  function accName(el, r) {
    let n = el.getAttribute('aria-label');
    if (!n) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb)
        n = lb
          .split(/\s+/)
          .map((id) => textOf(byId(el, id) || document.createElement('i')))
          .join(' ');
    }
    if (!n && el.labels && el.labels.length) n = [...el.labels].map((l) => textOf(l)).join(' ');
    if (!n && el.localName === 'img') n = el.getAttribute('alt');
    if (!n && el.localName === 'input' && ['submit', 'button', 'reset'].includes(el.type)) n = el.value || el.type;
    if (!n && el.localName === 'fieldset') n = textOf(el.querySelector('legend') || document.createElement('i'));
    if (!n && el.localName === 'table') n = textOf(el.querySelector('caption') || document.createElement('i'));
    if (!n && NAME_FROM_CONTENT.has(r)) n = textOf(el);
    if (!n) n = el.getAttribute('title') || '';
    if (!n && r === 'draggable') n = textOf(el, 80);
    return clip(norm(n), 80);
  }

  function isVisible(el) {
    if (el.getAttribute('aria-hidden') === 'true' && !(el.localName === 'canvas' && el.width * el.height > 2500)) return false;
    if (el.checkVisibility) {
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) {
        // display:contents has no box but its children can render
        return getComputedStyle(el).display === 'contents' ? 'contents' : false;
      }
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') return 'contents';
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && cs.overflow !== 'visible') return false;
    // visually hidden text (sr-only / clip) is excluded: common prompt-injection carrier
    if (rect.width <= 1 && rect.height <= 1 && (cs.position === 'absolute' || cs.position === 'fixed')) return false;
    if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') return false;
    if (parseFloat(cs.fontSize) === 0) return false;
    return true;
  }

  function isBlock(el) {
    const d = getComputedStyle(el).display;
    return !(d === 'inline' || d === 'contents');
  }

  function isClickable(el) {
    if (el.onclick || el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti >= 0) return true;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer') return false;
    const p = el.parentElement || el.getRootNode().host;
    return !p || getComputedStyle(p).cursor !== 'pointer';
  }

  function hrefOf(el) {
    try {
      const u = new URL(el.href, location.href);
      if (u.origin === location.origin) return clip(u.pathname + u.search + u.hash, 60);
      return clip(u.host + u.pathname, 60);
    } catch {
      return '';
    }
  }

  function states(el, r) {
    const s = [];
    if (r === 'textbox' || r === 'searchbox' || r === 'spinbutton' || r === 'date' || r === 'slider' || r === 'colorpicker') {
      const v = el.isContentEditable ? textOf(el, 80) : el.type === 'password' && el.value ? '•'.repeat(Math.min(8, el.value.length)) : el.value;
      if (v) s.push('= ' + q(clip(norm(String(v)), 60)));
      else if (el.placeholder) s.push('placeholder=' + q(clip(el.placeholder, 40)));
    }
    if (r === 'combobox' && el.localName === 'input' && el.value) s.push('= ' + q(clip(el.value, 60)));
    if (r === 'option' || r === 'menuitem' || r === 'treeitem') {
      const owner = el.id && el.getRootNode().querySelector?.(`[aria-activedescendant="${CSS.escape(el.id)}"]`);
      if (owner) s.push('active');
    }
    if (r === 'combobox' && el.localName === 'select') {
      const opt = el.selectedOptions[0];
      s.push('= ' + q(opt ? norm(opt.textContent) : ''));
      const opts = [...el.options].map((o) => norm(o.textContent));
      s.push(opts.length <= 12 ? 'options: ' + opts.join('|') : `(${opts.length} options)`);
    } else if (r === 'listbox' && el.localName === 'select') {
      s.push('= ' + q([...el.selectedOptions].map((o) => norm(o.textContent)).join(', ')));
    }
    if (r === 'file' && el.files && el.files.length) s.push('= ' + q([...el.files].map((f) => f.name).join(', ')));
    if ('checked' in el && (r === 'checkbox' || r === 'radio' || r === 'switch')) {
      if (el.checked) s.push('checked');
    } else if (el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    const ex = el.getAttribute('aria-expanded');
    if (ex) s.push(ex === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') s.push('haspopup');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.required) s.push('required');
    if (el === deepActive()) s.push('focused');
    if (r === 'link') {
      const h = hrefOf(el);
      if (h) s.push('-> ' + h);
    }
    if (r === 'canvas') {
      const b = el.getBoundingClientRect();
      s.push(`${Math.round(b.width)}x${Math.round(b.height)} (pixels only: use screenshot + click_xy)`);
    }
    if (el.localName === 'a' && el.target === '_blank') s.push('newtab');
    return s;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function fingerprint(el, r, name) {
    return { r, name, tag: el.localName };
  }

  // ---- snapshot ----
  function snapshot(opts = {}) {
    const prefix = opts.prefix || '';
    const interactiveOnly = opts.mode === 'interactive';
    const viewportOnly = !!opts.viewport;
    const vw = innerWidth,
      vh = innerHeight;
    const lines = [];
    const frames = []; // [{ref, line index}] iframes to inline (server side)
    let buf = []; // inline segments for the current text line
    let bufDepth = 0;
    let injections = 0;

    const flush = () => {
      if (!buf.length) return;
      let text = buf.join(' ').replace(/\s+/g, ' ').trim();
      buf = [];
      if (!text) return;
      if (INJECTION.test(text)) {
        injections++;
        text = '⚠possible-injection: ' + text;
      }
      lines.push({ d: bufDepth, t: clip(text, 300) });
    };
    const emit = (d, t) => {
      flush();
      lines.push({ d, t });
    };

    const inViewport = (el) => {
      const b = el.getBoundingClientRect();
      return b.bottom > 0 && b.right > 0 && b.top < vh && b.left < vw;
    };

    const token = (el, r) => {
      const n = refFor(el);
      const name = accName(el, r);
      byNum.get(n).fp = fingerprint(el, r, name);
      const st = states(el, r);
      const label = r === 'clickable' && name ? q(name) : name ? q(name) : '';
      return [r, label, `[${prefix}e${n}]`, ...st].filter(Boolean).join(' ');
    };

    let muted = 0; // inside a <label> whose control carries the text as its name
    const walk = (node, depth) => {
      if (node.nodeType === 3) {
        if (interactiveOnly || muted) return;
        const t = node.data;
        if (t.trim()) {
          if (!buf.length) bufDepth = depth;
          buf.push(t);
        }
        return;
      }
      if (node.nodeType === 11) {
        for (const c of children(node)) walk(c, depth);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (SKIP_TAGS.has(el.localName)) return;
      const vis = isVisible(el);
      if (!vis) return;
      if (vis === 'contents') {
        for (const c of children(el)) walk(c, depth);
        return;
      }
      if (el.localName === 'br') {
        flush();
        return;
      }
      let r = role(el);
      if (r === 'row' || r === 'cell' || r === 'columnheader') {
        if (r === 'row') {
          if (viewportOnly && !inViewport(el)) return;
          flush();
          const cells = [...el.children].filter((c) => isVisible(c)).map((c) => inline(c, prefix));
          lines.push({ d: depth, t: '| ' + cells.join(' | ') + ' |' });
          return;
        }
      }
      if (!r && isClickable(el)) r = 'clickable';
      if ((r === 'listitem' || (el.localName === 'li' && !r)) && !interactiveOnly) {
        if (viewportOnly && !inViewport(el)) return;
        const s = inline(el, prefix);
        if (s.length <= 200 && !el.querySelector('ul,ol,table,[role=list],[role=listitem],iframe')) {
          emit(depth, '- ' + s);
          return;
        }
      }
      if (r === 'heading') {
        const lvl = +(el.getAttribute('aria-level') || el.localName.slice(1)) || 2;
        if (viewportOnly && !inViewport(el)) return;
        emit(depth, `${'#'.repeat(Math.min(lvl, 6))} ${clip(textOf(el), 120)}`);
        return;
      }
      if (r === 'img') {
        if (interactiveOnly) return;
        const name = accName(el, r);
        if (name) {
          if (!buf.length) bufDepth = depth;
          buf.push(`[img ${q(name)}]`);
        }
        return;
      }
      if (r && INTERACTIVE.has(r)) {
        if (viewportOnly && !inViewport(el)) return;
        const tok = token(el, r);
        if (r === 'iframe') {
          emit(depth, tok);
          lines[lines.length - 1].frame = `${prefix}e${refOf.get(el)}`;
          return;
        }
        const hasInteractiveKids =
          r !== 'option' && el.querySelector?.('a[href],button,input,select,textarea,[role=button],[role=link],[role=option],[role=menuitem]');
        if (r === 'combobox' || (r === 'listbox' && el.localName === 'select') || !hasInteractiveKids) {
          if (r === 'clickable' || r === 'link') {
            if (isBlock(el)) emit(depth, tok);
            else {
              if (!buf.length) bufDepth = depth;
              buf.push(tok);
            }
          } else emit(depth, tok);
          return;
        }
        emit(depth, tok);
        for (const c of children(el)) walk(c, depth + 1);
        flush();
        return;
      }
      const scrollY = el !== document.body && el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
      const container = (r && CONTAINER.has(r)) || scrollY;
      if (container) {
        const name = r ? accName(el, r) : '';
        const sc = scrollY ? ` [${prefix}e${refFor(el)}] scrollable ${Math.round(el.scrollTop)}/${el.scrollHeight - el.clientHeight}` : '';
        emit(depth, `${r || 'region'}${name ? ' ' + q(name) : ''}${sc}:`);
        for (const c of children(el)) walk(c, depth + 1);
        flush();
        return;
      }
      const block = isBlock(el);
      if (block) flush();
      const mute = el.localName === 'label' && el.control && isVisible(el.control) === true;
      if (mute) muted++;
      for (const c of children(el)) walk(c, depth);
      if (mute) muted--;
      if (block) flush();
    };

    let root = document.body || document.documentElement;
    if (opts.ref) {
      const el = resolve(opts.ref).el;
      if (!el) return { error: `ref ${opts.ref} not found` };
      root = el;
    }
    walk(root, 0);
    flush();

    // collapse empty containers ("list:" followed by nothing deeper)
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.t.endsWith(':') && !(lines[i + 1] && lines[i + 1].d > l.d)) continue;
      out.push(l);
    }
    out.forEach((l, i) => {
      if (l.frame) {
        frames.push({ ref: l.frame, at: i, depth: l.d });
        delete l.frame;
      }
    });
    const scroll = {
      y: Math.round(scrollY),
      h: Math.round(document.documentElement.scrollHeight),
      vh,
    };
    return { url: location.href, title: document.title, lines: out, frames, injections, scroll };
  }

  function inline(el, prefix) {
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        parts.push(n.data);
        return;
      }
      if (n.nodeType === 11) {
        for (const c of children(n)) walk(c);
        return;
      }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.localName)) return;
      if (!isVisible(n)) return;
      let r = role(n);
      if (!r && isClickable(n)) r = 'clickable';
      if (r && INTERACTIVE.has(r)) {
        const num = refFor(n);
        const name = accName(n, r);
        byNum.get(num).fp = fingerprint(n, r, name);
        parts.push(` ${[r, name ? q(name) : '', `[${prefix}e${num}]`, ...states(n, r)].filter(Boolean).join(' ')} `);
        return;
      }
      for (const c of children(n)) walk(c);
    };
    walk(el);
    return clip(norm(parts.join(' ')), 200);
  }

  // ---- ref resolution with self-healing ----
  function numOf(ref) {
    const m = /e(\d+)$/.exec(ref || '');
    return m ? +m[1] : NaN;
  }

  function resolve(ref) {
    const n = numOf(ref);
    const ent = byNum.get(n);
    if (!ent) return { el: null, error: `unknown ref ${ref}` };
    const el = ent.ref.deref();
    if (el && el.isConnected) return { el };
    if (!ent.fp) return { el: null, error: `ref ${ref} is stale` };
    // Element was replaced (re-render). Find a unique match by role+name.
    const matches = [];
    const walk = (node) => {
      if (matches.length > 1) return;
      if (node.nodeType === 1) {
        let r = role(node);
        if (!r && isClickable(node)) r = 'clickable';
        if (r === ent.fp.r && node.localName === ent.fp.tag && accName(node, r) === ent.fp.name) matches.push(node);
      }
      if (node.nodeType === 1 || node.nodeType === 11 || node.nodeType === 9) for (const c of children(node)) walk(c);
    };
    walk(document);
    if (matches.length === 1) {
      refOf.set(matches[0], n);
      ent.ref = new WeakRef(matches[0]);
      return { el: matches[0], healed: true };
    }
    return { el: null, error: `ref ${ref} is stale (element removed${matches.length > 1 ? ', ambiguous match' : ''}); take a new snapshot` };
  }

  // "text=Account": the smallest visible element under root whose text contains the string; prefers interactive ones.
  // count = matches that do not contain another match (so a label and its wrapper count once).
  function findText(needle, root = document.body || document) {
    const want = needle.toLowerCase();
    const v = JSON.stringify(needle);
    const labelSel = ['aria-label', 'value', 'alt', 'title', 'placeholder'].map((a) => `[${a}*=${v} i]`).join(',');
    let best = null,
      bestScore = Infinity;
    const matches = [];
    const walk = (node) => {
      if (node.nodeType === 1) {
        if (SKIP_TAGS.has(node.localName) || !isVisible(node)) return;
        // Prune with the full text plus descendants' labels and values: the 400-char excerpt misses text
        // late in long containers, and textContent misses aria-label/value/alt/title.
        const label = node.getAttribute('aria-label') || '';
        if (!((node.textContent || '') + ' ' + label).toLowerCase().includes(want) && !node.querySelector(labelSel)) return; // children cannot match either
        const t = (textOf(node, 400) || label).toLowerCase();
        if (t.includes(want)) {
          matches.push(node);
          let r = role(node);
          if (!r && isClickable(node)) r = 'clickable';
          const score = t.length - (r && INTERACTIVE.has(r) ? 1000 : 0) + (t === want ? -500 : 0);
          if (score < bestScore) {
            best = node;
            bestScore = score;
          }
        }
      }
      if (node.nodeType === 1 || node.nodeType === 11 || node.nodeType === 9) for (const c of children(node)) walk(c);
    };
    walk(root);
    const count = matches.filter((m) => !matches.some((o) => o !== m && m.contains(o))).length;
    return { el: best, count };
  }

  function refOfEl(node, prefix) {
    const n = refFor(node);
    let r = role(node);
    if (!r && isClickable(node)) r = 'clickable';
    const name = accName(node, r);
    byNum.get(n).fp = fingerprint(node, r, name);
    return { ref: `${prefix}e${n}`, desc: `${r || node.localName}${name ? ' ' + JSON.stringify(name.slice(0, 40)) : ''}` };
  }

  // Locator chain, e.g. "text=ALD", "css=.tiles", "e12 >> text=ALD", "css=#card >> text=Total".
  // Each part searches inside the element the previous part found. Returns the ref of the last match,
  // how many elements matched it, and a short description; null when nothing matches in this frame.
  function locate(spec, prefix = '') {
    let scope = document.body || document,
      found = null,
      count = 1;
    for (const part of spec.split(/\s+>>\s+/)) {
      const m = /^(f\d+)?e\d+$/.exec(part);
      if (m) {
        if ((m[1] || '') !== prefix) return null; // a ref of another frame
        const r = resolve(part);
        if (!r.el) throw new Error(r.error);
        found = r.el;
        count = 1;
      } else if (part.startsWith('css=')) {
        const all = [...scope.querySelectorAll(part.slice(4))].filter(isVisible);
        found = all[0] || null;
        count = all.length;
      } else if (part.startsWith('text=')) {
        ({ el: found, count } = findText(part.slice(5).replace(/^["']|["']$/g, ''), scope));
      } else throw new Error(`bad locator part "${part}" (use a ref, css=…, or text=…)`);
      if (!found) return null;
      scope = found;
    }
    return { ...refOfEl(found, prefix), count };
  }

  function el(ref) {
    const r = resolve(ref);
    if (!r.el) throw new Error(r.error);
    return r.el;
  }

  // Scroll into view and return the click point in frame-viewport coordinates.
  function point(ref, opts = {}) {
    const r = resolve(ref);
    if (!r.el) return { error: r.error };
    const e = r.el;
    if (!opts.noScroll) e.scrollIntoView({ block: opts.block || 'center', inline: 'center', behavior: 'instant' });
    // An inline element that wraps a block (<a><h2>…</h2></a>) starts with an empty fragment: skip it.
    const b = [...e.getClientRects()].find((r) => r.width && r.height) || e.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) return { error: `ref ${ref} has no box (hidden?)`, healed: r.healed };
    const fy = opts.position === 'before' ? 0.25 : opts.position === 'after' ? 0.75 : 0.5;
    const x = b.left + (opts.dx ?? b.width / 2),
      y = b.top + (opts.dy ?? b.height * fy);
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    let covered = null;
    if (
      hit &&
      hit !== e &&
      !e.contains(hit) &&
      !hit.contains?.(e) &&
      !(/** @type {ShadowRoot} */ (hit.getRootNode()).host && e.contains(/** @type {ShadowRoot} */ (hit.getRootNode()).host))
    ) {
      const lab = e.labels && [...e.labels].some((l) => l.contains(hit));
      if (!lab) covered = describe(hit);
    }
    // a form-submission control: a click on it must change something (L012)
    const submit = e.closest('input[type=submit],input[type=image],button');
    const submits = !!submit && !!submit.form && (submit.localName !== 'button' || (submit.getAttribute('type') || 'submit').toLowerCase() === 'submit');
    return { x, y, healed: r.healed, covered, submits };
  }

  function describe(e) {
    const r = role(e) || e.localName;
    const n = accName(e, r) || clip(textOf(e, 40), 40);
    return `${r}${n ? ' ' + q(n) : ''}`;
  }

  function setValue(ref, value) {
    const e = el(ref);
    if (e.localName === 'select') {
      const want = Array.isArray(value) ? value : [value];
      const lc = want.map((v) => String(v).toLowerCase().trim());
      let found = 0;
      for (const o of e.options) {
        const hit = lc.includes(o.value.toLowerCase()) || lc.includes(norm(o.textContent).toLowerCase());
        if (e.multiple) o.selected = hit;
        else if (hit && !found) {
          e.value = o.value;
        }
        if (hit) found++;
      }
      if (!found) throw new Error(`no option ${q(String(value))}; options: ${[...e.options].map((o) => norm(o.textContent)).join('|')}`);
    } else if (e.isContentEditable) {
      e.focus();
      e.textContent = value;
    } else {
      const proto = e.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    }
    e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: e.localName === 'select' ? norm(e.selectedOptions[0]?.textContent) : e.value };
  }

  function focus(ref, { clear = false } = {}) {
    const e = el(ref);
    e.focus();
    if (clear) {
      if ('select' in e && typeof e.select === 'function') e.select();
      else if (e.isContentEditable) {
        const s = getSelection();
        s.selectAllChildren(e);
      }
    }
    return { focused: deepActive() === e };
  }

  // querySelectorAll that also searches open shadow roots.
  /** @param {string} sel @param {Document | ShadowRoot} [root] @returns {Element[]} */
  function deepQueryAll(sel, root = document) {
    const out = [...root.querySelectorAll(sel)];
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) out.push(...deepQueryAll(sel, e.shadowRoot));
    return out;
  }

  // Custom combobox helpers (ARIA pattern).
  function optionRef(want, prefix = '') {
    const w = norm(want).toLowerCase();
    let exact = null,
      partial = null;
    for (const o of deepQueryAll('[role=option],[role=menuitem],[role=treeitem]')) {
      if (isVisible(o) !== true) continue;
      const t = textOf(o, 200).toLowerCase();
      if (t === w) {
        exact = o;
        break;
      }
      if (!partial && t.includes(w)) partial = o;
    }
    const o = exact || partial;
    if (!o) return null;
    const n = refFor(o);
    byNum.get(n).fp = fingerprint(o, role(o), accName(o, role(o)));
    return `${prefix}e${n}`;
  }
  function comboState(ref) {
    const e = el(ref);
    const ad = e.getAttribute('aria-activedescendant');
    const active = ad ? textOf(byId(e, ad) || document.createElement('i'), 200) : '';
    const value = 'value' in e && e.localName !== 'button' ? e.value : textOf(e, 200);
    return {
      value,
      active,
      expanded: e.getAttribute('aria-expanded') === 'true',
      editable: e.localName === 'input' || e.localName === 'textarea' || e.isContentEditable,
    };
  }

  function info(ref) {
    const e = el(ref);
    return { tag: e.localName, type: e.type || null, role: role(e), multiple: !!e.multiple };
  }

  // ---- text extraction ----
  function text(opts = {}) {
    const root = opts.ref ? el(opts.ref) : document.body;
    const out = [];
    let line = '';
    const walk = (n) => {
      if (n.nodeType === 3) {
        line += n.data;
        return;
      }
      if (n.nodeType === 11) {
        for (const c of children(n)) walk(c);
        return;
      }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.localName)) return;
      const v = isVisible(n);
      if (!v) return;
      if (n.localName === 'br') {
        out.push(line);
        line = '';
        return;
      }
      const block = v !== 'contents' && isBlock(n);
      if (block && line.trim()) {
        out.push(line);
        line = '';
      }
      const h = /^h([1-6])$/.exec(n.localName);
      if (h) {
        out.push('#'.repeat(+h[1]) + ' ' + textOf(n, 300));
        return;
      }
      if (n.localName === 'li') line += '- ';
      for (const c of children(n)) walk(c);
      if (n.localName === 'td' || n.localName === 'th') line += ' | ';
      if (block && line.trim()) {
        out.push(line);
        line = '';
      }
    };
    walk(root);
    if (line.trim()) out.push(line);
    let s = out.map(norm).filter(Boolean).join('\n');
    const total = s.length,
      off = opts.offset || 0,
      max = opts.maxChars || 20000;
    s = s.slice(off, off + max);
    return { text: s, total, offset: off, truncated: off + max < total };
  }

  // ---- waits ----
  function hasText(t) {
    return textOf(document.body || document.documentElement, 1e7)
      .toLowerCase()
      .includes(t.toLowerCase());
  }

  /** @param {{ text?: string, gone?: string, ref?: string, timeout?: number }} [opts] */
  function waitFor({ text: t, gone, ref, timeout = 10000 } = {}) {
    const check = () => {
      if (t && !hasText(t)) return false;
      if (gone && hasText(gone)) return false;
      if (ref) {
        const r = resolve(ref);
        if (!r.el || !isVisible(r.el)) return false;
      }
      return true;
    };
    return new Promise((res) => {
      if (check()) return res({ ok: true, ms: 0 });
      const t0 = performance.now();
      const mo = new MutationObserver(() => {
        if (check()) done(true);
      });
      const iv = setInterval(() => {
        if (check()) done(true);
        else if (performance.now() - t0 > timeout) done(false);
      }, 100);
      function done(ok) {
        mo.disconnect();
        clearInterval(iv);
        res({ ok, ms: Math.round(performance.now() - t0) });
      }
      mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    });
  }

  // Visible "work in progress" signals: aria-busy, progressbar, spinner text like "Loading…" / "Saving...".
  const BUSY_TEXT = /^\s*(loading|signing in|logging in|saving|submitting|processing|uploading|please wait|generating|searching)\b[^.\n]{0,30}(\.\.\.|…)\s*$/i;
  function busy() {
    for (const e of document.querySelectorAll('[aria-busy="true"],[role="progressbar"],progress')) if (isVisible(e) === true) return true;
    const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
    let n,
      k = 0;
    while ((n = w.nextNode()) && k++ < 5000) {
      if (n.data.length < 60 && BUSY_TEXT.test(n.data) && n.parentElement && isVisible(n.parentElement) === true) return true;
    }
    return false;
  }

  // Resolve when the DOM has had no mutations for `quiet` ms and no busy indicator shows (cap `max`).
  function settle({ quiet = 150, max = 2000 } = {}) {
    return new Promise((res) => {
      const t0 = performance.now();
      let last = t0;
      const mo = new MutationObserver(() => {
        last = performance.now();
      });
      mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      const iv = setInterval(() => {
        const now = performance.now();
        if ((now - last >= quiet && !busy()) || now - t0 >= max) {
          mo.disconnect();
          clearInterval(iv);
          res({ ms: Math.round(now - t0) });
        }
      }, 30);
    });
  }

  function scrollables() {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 10) out.push(n);
      }
      if (n.nodeType === 1 || n.nodeType === 11 || n.nodeType === 9) for (const c of children(n)) walk(c);
    };
    walk(document);
    return out;
  }

  // Scroll a container (or the page) by a fraction of its height.
  /** @param {{ ref?: string | null, dy?: number, to?: string }} [opts] */
  function scroll({ ref, dy = 0.8, to } = {}) {
    let s = ref ? el(ref) : null;
    if (!s) {
      // App layouts scroll a container (<main>) while the page is only a few px taller than the window:
      // use the page only when it can move a real step, else the largest scrollable container.
      const pageRoom = document.documentElement.scrollHeight - innerHeight;
      if (pageRoom < Math.min(innerHeight * 0.25, 200)) {
        const list = scrollables()
          .filter((n) => n !== document.documentElement && n !== document.body)
          .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
        s = list[0] || null;
      }
    }
    const target = s || document.scrollingElement;
    const h = s ? s.clientHeight : innerHeight;
    const before = target.scrollTop;
    if (to === 'top') target.scrollTop = 0;
    else if (to === 'bottom') target.scrollTop = target.scrollHeight;
    else target.scrollTop = before + dy * h;
    target.dispatchEvent(new Event('scroll'));
    return { moved: Math.round(target.scrollTop - before), atEnd: target.scrollTop + h >= target.scrollHeight - 2, top: Math.round(target.scrollTop) };
  }

  const frame = () =>
    new Promise(
      /** @param {(v?: unknown) => void} r */ (r) => {
        let done = false;
        const f = () => {
          if (!done) {
            done = true;
            r();
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(f));
        setTimeout(f, 50);
      },
    );
  // Scroll until the text exists, then scroll it into view: scrollIntoView moves every scrollable ancestor
  // (an app's <main>, not only the page), so "found" means the agent can see and act on it.
  /** @param {{ ref?: string | null, text?: string, dy?: number, max?: number }} [opts] */
  async function scrollUntil({ ref, text: t, dy = 0.8, max = 400 } = {}) {
    const reveal = (steps) => {
      const { el: hit } = findText(t);
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return { found: true, steps };
    };
    for (let i = 0; i <= max; i++) {
      if (hasText(t)) {
        const r = reveal(i);
        if (r) return r;
      }
      const r = scroll({ ref, dy });
      await frame();
      if (r.atEnd && r.moved === 0) break;
    }
    return reveal(max) || { found: false, steps: max };
  }

  // ---- set-of-marks overlay for screenshots ----
  let overlay = null;
  function marks(on) {
    overlay?.remove();
    overlay = null;
    if (!on) return { n: 0 };
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    let n = 0;
    for (const [num, ent] of byNum) {
      const e = ent.ref.deref();
      if (!e || !e.isConnected) continue;
      const b = e.getBoundingClientRect();
      if (b.bottom < 0 || b.top > innerHeight || b.width === 0) continue;
      const tag = document.createElement('div');
      tag.textContent = 'e' + num;
      tag.style.cssText = `position:fixed;left:${b.left}px;top:${Math.max(0, b.top - 12)}px;font:10px monospace;background:#e11;color:#fff;padding:0 2px;outline:1px solid #e11`;
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;outline:1px solid #e11`;
      overlay.append(box, tag);
      n++;
    }
    document.documentElement.append(overlay);
    return { n };
  }

  // The open modal dialog, if any: explicit modals first (aria-modal, <dialog> shown with showModal()),
  // then a large role=dialog (sites often omit aria-modal). Topmost = last in document order.
  function modal(prefix = '') {
    const vis = (e) => {
      const b = e.getBoundingClientRect();
      return b.width > 40 && b.height > 40 && isVisible(e);
    };
    const all = [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]')].filter(vis);
    const explicit = all.filter((e) => e.getAttribute('aria-modal') === 'true' || (e.localName === 'dialog' && e.matches(':modal')));
    const big = all.filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width * b.height > innerWidth * innerHeight * 0.2;
    });
    const pick = explicit.pop() || big.pop();
    if (!pick) return null;
    return { ref: `${prefix}e${refFor(pick)}`, name: accName(pick, 'dialog') || '' };
  }

  // Effect signature for "did this click change anything": DOM mutations, URL, title.
  let mutations = 0,
    observing = false;
  function effect() {
    if (!observing) {
      observing = true;
      // our own password-manager opt-out attributes (shield) are not an effect of the click
      const ours = /^data-(1p-ignore|lpignore|bwignore|form-type|protonpass-ignore)$/;
      new MutationObserver((ms) => {
        for (const m of ms) if (!(m.type === 'attributes' && ours.test(m.attributeName))) mutations++;
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    return `${mutations}|${location.href}|${document.title}`;
  }

  // ---- perf: what the page itself recorded (buffered performance entries) ----
  async function perf() {
    const take = (type) =>
      new Promise((done) => {
        try {
          const out = [];
          const po = new PerformanceObserver((list) => out.push(...list.getEntries()));
          po.observe({ type, buffered: true });
          setTimeout(() => {
            out.push(...po.takeRecords());
            po.disconnect();
            done(out);
          }, 50);
        } catch {
          done([]);
        }
      });
    const [lcp, shifts, longs, events, paints] = await Promise.all(['largest-contentful-paint', 'layout-shift', 'longtask', 'event', 'paint'].map(take));
    // CLS = largest session window (shifts < 1 s apart, window < 5 s), user-input shifts excluded
    let cls = 0,
      win = 0,
      first = 0,
      last = 0;
    for (const sh of shifts) {
      if (sh.hadRecentInput) continue;
      if (win && (sh.startTime - last > 1000 || sh.startTime - first > 5000)) {
        cls = Math.max(cls, win);
        win = 0;
      }
      if (!win) first = sh.startTime;
      win += sh.value;
      last = sh.startTime;
    }
    cls = Math.max(cls, win);
    // Shifts right after input are excluded from CLS by the spec; an agent's own click counts as input, so list them.
    const afterInput = shifts.filter((sh) => sh.hadRecentInput && sh.value >= 0.001).map((sh) => +sh.value.toFixed(3));
    const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0]);
    const lastLcp = lcp[lcp.length - 1];
    const inp = events.filter((e) => e.interactionId).reduce((m, e) => Math.max(m, e.duration), 0);
    return JSON.stringify({
      lcp: lastLcp ? Math.round(lastLcp.startTime) : null,
      lcpEl: lastLcp?.element ? describe(lastLcp.element) : null,
      cls: +cls.toFixed(3),
      afterInput,
      inp: inp || null,
      fcp: (() => {
        const f = paints.find((x) => x.name === 'first-contentful-paint');
        return f ? Math.round(f.startTime) : null;
      })(),
      ttfb: nav ? Math.round(nav.responseStart) : null,
      load: nav?.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
      longs: longs.map((l) => Math.round(l.duration)),
      res: [
        ...new Map(
          /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType('resource')).map((r) => [
            r.name + '@' + Math.round(r.startTime),
            { url: r.name, ms: Math.round(r.duration), size: r.transferSize, type: r.initiatorType },
          ]),
        ).values(),
      ],
    });
  }

  // ---- structured reading: extract (JSON) and markdown ----
  const CHROME = 'nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary]';
  const cellText = (c) => (c.innerText || '').replace(/\s+/g, ' ').trim();
  // node is inside root: page chrome counts only when it sits inside root too (a ref inside a <nav> still works)
  const inChrome = (node, root) => {
    const c = node.closest(CHROME);
    return !!c && c !== root && root.contains(c);
  };
  const NOT_CONTENT = /^(script|style|noscript|template|svg|button|select|input|textarea)$/;
  const dlFields = (dl) => {
    const fields = {};
    let key = null;
    for (const ch of dl.children) {
      if (ch.localName === 'dt') key = cellText(ch).replace(/:$/, '');
      else if (ch.localName === 'dd' && key) fields[key] = cellText(ch);
    }
    return fields;
  };
  const rowsOf = (t) =>
    [...t.rows]
      .filter((r) => r.closest('table') === t)
      .map((r) => ({ cells: [...r.cells].map(cellText), th: r.querySelector('th') !== null || r.parentElement?.localName === 'thead' }))
      .filter((r) => r.cells.some(Boolean));
  const isLayoutTable = (t) => !!t.querySelector('table');
  // One-cell-wide "tables" are headings or notes in table-layout sites: text, not data.
  const isTextTable = (rows) => rows.every((r) => r.cells.filter(Boolean).length <= 1);
  // A label|value block is a record only with at least two filled values.
  const fieldsOf = (rows) => {
    const f = {};
    for (const {
      cells: [k, v],
    } of rows)
      if (k) f[k.replace(/:$/, '')] = v;
    return Object.values(f).filter(Boolean).length >= 2 ? f : null;
  };
  const isFieldTable = (rows) => rows.length > 0 && rows.every((r) => r.cells.length === 2 && !r.th);

  /** Tables (rows keyed by column), label|value tables and <dl> (fields) inside the main content, as JSON. */
  function extract(opts = {}) {
    const root = opts.ref ? el(opts.ref) : document.body;
    const maxRows = opts.maxRows || 200;
    const blocks = [];
    const usable = (n) => isVisible(n) && (opts.ref || !inChrome(n, root));
    for (const t of root.querySelectorAll('table')) {
      if (!usable(t) || isLayoutTable(t)) continue;
      const rows = rowsOf(t);
      if (!rows.length || isTextTable(rows)) continue;
      if (isFieldTable(rows)) {
        const fields = fieldsOf(rows);
        if (fields) blocks.push({ kind: 'fields', fields });
        continue;
      }
      const head = rows.find((r) => r.th) || rows[0];
      const columns = head.cells.map((h, i) => h || `col${i + 1}`);
      const body = rows.filter((r) => r !== head && !r.th);
      if (!body.length) continue;
      blocks.push({
        kind: 'table',
        columns,
        rows: body.slice(0, maxRows).map((r) => Object.fromEntries(columns.map((c, i) => [c, r.cells[i] ?? '']))),
        total: body.length,
      });
    }
    for (const dl of root.querySelectorAll('dl')) {
      if (!usable(dl)) continue;
      const fields = dlFields(dl);
      if (Object.keys(fields).length) blocks.push({ kind: 'fields', fields });
    }
    return JSON.stringify({ url: location.href, blocks });
  }

  /** Main content as Markdown: headings, paragraphs, lists, tables, links; page chrome left out. */
  function markdown(opts = {}) {
    const root = opts.ref ? el(opts.ref) : document.querySelector('main,[role=main]') || document.body;
    const out = [];
    let line = '';
    const flush = () => {
      const t = line.replace(/[ \t]+/g, ' ').trim();
      if (t) out.push(t);
      line = '';
    };
    const esc = (t) => t.replace(/\|/g, '\\|');
    const inline = (n) => {
      if (n.nodeType === 3) return n.data;
      if (n.nodeType !== 1 || !isVisible(n) || NOT_CONTENT.test(n.localName)) return '';
      const kids = [...n.childNodes].map(inline).join('');
      const t = kids.replace(/\s+/g, ' ').trim();
      if (!t && n.localName !== 'img') return kids;
      if (n.localName === 'a' && /^https?:/.test(n.href)) return `[${t}](${n.href})`;
      if (n.localName === 'img') return n.alt ? `![${n.alt}]` : '';
      if (/^(strong|b)$/.test(n.localName)) return `**${t}**`;
      if (/^(em|i)$/.test(n.localName)) return `*${t}*`;
      if (n.localName === 'code') return '`' + t + '`';
      if (n.localName === 'br') return '\n';
      return kids;
    };
    const table = (t) => {
      const rows = rowsOf(t);
      if (!rows.length) return;
      if (isTextTable(rows)) {
        for (const r of rows) for (const c of r.cells) if (c) out.push(c);
        return;
      }
      if (isFieldTable(rows)) {
        for (const {
          cells: [k, v],
        } of rows)
          if (k || v) out.push(v ? `**${k.replace(/:$/, '')}**: ${v}` : k);
        return;
      }
      const width = Math.max(...rows.map((r) => r.cells.length));
      const pad = (cells) => '| ' + Array.from({ length: width }, (_, i) => esc(cells[i] || '')).join(' | ') + ' |';
      out.push([pad(rows[0].cells), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map((r) => pad(r.cells))].join('\n'));
    };
    const block = (n, depth = 0) => {
      if (n.nodeType === 3) {
        line += n.data;
        return;
      }
      if (n.nodeType !== 1 || !isVisible(n)) return;
      const tag = n.localName;
      if (NOT_CONTENT.test(tag)) return;
      if (n !== root && n.matches(CHROME)) return;
      if (/^h[1-6]$/.test(tag)) {
        flush();
        out.push('#'.repeat(+tag[1]) + ' ' + inline(n).replace(/\s+/g, ' ').trim());
        return;
      }
      if (tag === 'table') {
        flush();
        if (isLayoutTable(n)) for (const c of n.querySelectorAll(':scope > tbody > tr > td, :scope > tr > td')) block(c, depth);
        else table(n);
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        [...n.children]
          .filter((li) => li.localName === 'li' && isVisible(li))
          .forEach((li, i) => {
            const t = inline(li).replace(/\s+/g, ' ').trim();
            if (t) out.push('  '.repeat(depth) + (tag === 'ol' ? `${i + 1}. ` : '- ') + t);
          });
        return;
      }
      if (tag === 'dl') {
        flush();
        for (const [k, v] of Object.entries(dlFields(n))) out.push(`**${k}**: ${v}`);
        return;
      }
      if (tag === 'pre') {
        flush();
        out.push('```\n' + n.innerText.trimEnd() + '\n```');
        return;
      }
      if (/^(a|strong|b|em|i|code|img|span|label|small|sup|sub|abbr|time|mark)$/.test(tag)) {
        line += inline(n);
        return;
      }
      if (tag === 'br') {
        flush();
        return;
      }
      const isBlock = /^(p|div|section|article|blockquote|li|figure|figcaption|main|td|th|tr|tbody|form|fieldset|details|summary)$/.test(tag);
      if (isBlock) flush();
      for (const c of n.childNodes) block(c, depth);
      if (isBlock) flush();
    };
    block(root);
    flush();
    let md = out.join('\n\n').replace(/\n{3,}/g, '\n\n');
    const max = opts.maxChars || 20000;
    if (md.length > max) md = md.slice(0, max) + `\n… (${md.length - max} more chars; use maxChars or ref)`;
    return md;
  }

  // Password managers inject their own iframes into focused fields; Chrome then drops (and refuses) the
  // debugger for the whole tab. Agent tabs opt their fields out with each manager's documented attribute.
  let shielded = false;
  function shield() {
    if (shielded) return;
    shielded = true;
    const OPT_OUT = { 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other', 'data-protonpass-ignore': 'true' };
    const mark = (el) => {
      for (const [k, v] of Object.entries(OPT_OUT)) if (!el.hasAttribute(k)) el.setAttribute(k, v);
    };
    const isField = (el) => el && el.nodeType === 1 && (el.matches('input,textarea,select') || el.isContentEditable);
    document.querySelectorAll('input,textarea,select').forEach(mark);
    // capture on window runs before the managers' own focus listeners
    for (const type of ['focusin', 'pointerdown', 'mousedown'])
      addEventListener(
        type,
        (e) => {
          const t = e.composedPath()[0];
          if (isField(t)) mark(t);
        },
        true,
      );
  }

  // In-page deny guard: stops clicks and form submits on denied controls before page handlers run,
  // whatever started them (real input, an act step, or JS run through eval).
  let guarded = false;
  function guard(spec) {
    if (guarded) return;
    guarded = true;
    const nameRe = new RegExp(spec.name, spec.flags),
      pathRe = new RegExp(spec.path, spec.flags);
    const pathOf = (u) => {
      let p;
      try {
        p = new URL(u, location.href).pathname;
      } catch {
        return '';
      }
      try {
        p = decodeURIComponent(p);
      } catch {}
      return p.replace(/\/{2,}/g, '/');
    };
    const denied = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const t = node.closest('button,a,[role=button],[role=menuitem],[role=link],input[type=submit],input[type=button]') || node;
      const name = (t.getAttribute('aria-label') || t.innerText || t.value || '').replace(/\s+/g, ' ').trim();
      return (name && nameRe.test(name)) || (t.href && pathRe.test(pathOf(t.href)));
    };
    const stop = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    addEventListener(
      'click',
      (e) => {
        if (denied(e.composedPath()[0])) stop(e);
      },
      true,
    );
    addEventListener(
      'submit',
      (e) => {
        if (denied(e.submitter) || (/** @type {HTMLFormElement} */ (e.target).action && pathRe.test(pathOf(/** @type {HTMLFormElement} */ (e.target).action))))
          stop(e);
      },
      true,
    );
  }

  function rect(ref) {
    const b = el(ref).getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }

  globalThis.__bbm = {
    perf,
    effect,
    extract,
    markdown,
    shield,
    guard,
    modal,
    optionRef,
    comboState,
    scrollUntil,
    locate,
    snapshot,
    resolve,
    el,
    point,
    setValue,
    focus,
    info,
    text,
    waitFor,
    settle,
    scroll,
    marks,
    rect,
    hasText,
  };
})();
