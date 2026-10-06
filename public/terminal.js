'use strict';

/*
 * Browser-side VT emulator: renders PTY text and ANSI attributes as HTML spans; keystrokes return as text.
 */

/* ================================================================== */
/* Palettes & helpers                                                  */
/* ================================================================== */

const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, INVERSE = 16,
      HIDDEN = 32, STRIKE = 64;

const CONT = '\u0000'; // continuation cell of a double-width character

// Standard xterm 16-color palette (0-15) and helpers for 256/truecolor.
const PALETTE = [
  '#1c2130', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd',
  '#56b6c2', '#d7dae0', '#5c6370', '#ef7d85', '#a9d88a', '#f0d399',
  '#7dc0f2', '#d99ae8', '#74d0e0', '#ffffff',
];

function hex2(n) { return n.toString(16).padStart(2, '0'); }

/** Maps an xterm-256 color index (>=16) to '#rrggbb', leaving indexes below 16 numeric. */
function color256(n) {
  if (n < 16) return n;
  if (n < 232) {
    const i = n - 16;
    const lv = (v) => (v === 0 ? 0 : 55 + v * 40);
    return '#' + hex2(lv(Math.floor(i / 36))) + hex2(lv(Math.floor(i / 6) % 6)) + hex2(lv(i % 6));
  }
  const v = 8 + (n - 232) * 10;
  return '#' + hex2(v) + hex2(v) + hex2(v);
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Character width (pragmatic wcwidth) --------------------------------- */

function isCombining(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) || (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) || (cp >= 0x0e31 && cp <= 0x0e3e && cp !== 0x0e32 && cp !== 0x0e33) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) || (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 ||
    (cp >= 0x2061 && cp <= 0x2064) ||
    cp === 0x05bf || (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) || cp === 0x05c7 ||
    cp === 0x061c || cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) || (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x06e7 && cp <= 0x06e8) || (cp >= 0x06ea && cp <= 0x06ed) ||
    (cp >= 0x0900 && cp <= 0x0902) || cp === 0x093c ||
    (cp >= 0x0941 && cp <= 0x0948) || (cp >= 0x0951 && cp <= 0x0954) ||
    (cp >= 0x0962 && cp <= 0x0963) ||
    cp === 0x0981 || cp === 0x09bc || (cp >= 0x09c1 && cp <= 0x09c4) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x200e && cp <= 0x200f) || cp === 0xfeff
  );
}

function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isCombining(cp)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function isOnlyRI(s) {
  for (let i = 0; i < s.length; i += 2) {
    const cp = s.codePointAt(i);
    if (cp < 0x1f1e6 || cp > 0x1f1ff) return false;
  }
  return s.length > 0;
}

const BLANK = Object.freeze({ ch: ' ', fg: null, bg: null, at: 0 });
const blankRow = (cols) => Array.from({ length: cols }, () => BLANK);

function blankGrid(cols, rows) {
  const g = new Array(rows);
  for (let y = 0; y < rows; y++) g[y] = blankRow(cols);
  return g;
}

/* ================================================================== */
/* Term — VT-style screen emulator                                     */
/* ================================================================== */

const S_GROUND = 0, S_ESC = 1, S_CSI = 2, S_OSC = 3, S_CHARSET = 4,
      S_STRING = 5, S_STRING_ESC = 6, S_OSC_ESC = 7;

class Term {
  constructor(opts = {}) {
    this.opts = opts;
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
    this.cell = { w: 8, h: 17 }; // measured cell metrics, set by fit()

    // callbacks
    this.onScrollLine = opts.onScrollLine || (() => {});
    this.onClearScrollback = opts.onClearScrollback || (() => {});
    this.onAlt = opts.onAlt || (() => {});
    this.onTitle = opts.onTitle || (() => {});
    this.onResponse = opts.onResponse || (() => {});
    this.onBell = opts.onBell || (() => {});

    this.normal = blankGrid(this.cols, this.rows);
    this.alt = null;
    this.isAlt = false;

    this.state = S_GROUND;
    this.csiBuf = '';
    this.oscBuf = '';
    this.title = '';
    this.surrogateHold = '';

    this.reset(true);
  }

  get screen() { return this.isAlt && this.alt ? this.alt : this.normal; }

  get savedSlot() { return this.isAlt ? this.savedAlt : this.savedNormal; }
  set savedSlot(v) { if (this.isAlt) this.savedAlt = v; else this.savedNormal = v; }

  reset(full) {
    this.cursor = { x: 0, y: 0 };
    this.curFg = null; this.curBg = null; this.curAt = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.wrap = true;
    this.wrapPending = false;
    this.originMode = false;
    this.appCursor = false;
    this.cursorVisible = true;
    this.insertMode = false;
    this.bracketedPaste = false;
    this.lnm = false;
    this.mouseMode = 0;
    this.lastCh = '';
    this.savedNormal = null;
    this.savedAlt = null;
    this.state = S_GROUND;
    this.csiBuf = '';
    this.oscBuf = '';
    this.fillTabs();
    if (full) {
      this.normal = blankGrid(this.cols, this.rows);
      this.alt = null;
      this.isAlt = false;
      this.onAlt(false);
      this.onClearScrollback();
    }
  }

  fillTabs() {
    this.tabs = new Set();
    for (let x = 8; x < this.cols; x += 8) this.tabs.add(x);
  }

  /* ---------------- writing characters ---------------- */

  putChar(ch) {
    const cp = ch.codePointAt(0);
    const w = charWidth(cp);

    if (this.attachToPrev(cp, ch, w)) return;
    if (w === 0) return;

    if (this.wrapPending) {
      this.wrapPending = false;
      this.cursor.x = 0;
      this.lineFeed();
    }

    // wrap a double-width char that won't fit in the last column
    if (w === 2 && this.cursor.x >= this.cols - 1) {
      if (this.wrap) {
        this.cursor.x = 0;
        this.lineFeed();
      } else {
        return;
      }
    }

    let { x, y } = this.cursor;
    if (x >= this.cols) {
      if (this.wrap) { x = 0; y = this.cursor.y; this.lineFeed(); y = this.cursor.y; }
      else x = this.cols - 1;
      this.cursor.x = x;
    }

    let row = this.screen[y];

    if (this.insertMode) {
      // shift right, dropping what falls off the end
      const shifted = row.slice();
      for (let i = this.cols - 1; i > x; i--) shifted[i] = row[i - 1];
      shifted[x] = BLANK;
      this.screen[y] = shifted;
      row = shifted;
    }

    // sanitize halves we are about to overwrite
    this.sanitizeAt(row, x);
    if (w === 2 && x + 1 < this.cols) this.sanitizeAt(row, x + 1);

    const cell = { ch, fg: this.curFg, bg: this.curBg, at: this.curAt, w: w === 2 ? 2 : undefined };
    row[x] = cell;
    if (w === 2) {
      if (x + 1 < this.cols) {
        row[x + 1] = { ch: CONT, fg: this.curFg, bg: this.curBg, at: this.curAt };
      }
    }

    this.lastCh = ch;
    this.cursor.x = x + w;
    if (this.cursor.x >= this.cols) {
      this.cursor.x = this.cols - 1;
      this.wrapPending = this.wrap;
    }
  }

  /** Merge combining marks, emoji modifiers, ZWJ sequences, and flag pairs into the previous cell. */
  attachToPrev(cp, ch, w) {
    let i = this.wrapPending ? this.cursor.x : this.cursor.x - 1;
    if (i >= this.cols) i = this.cols - 1;
    const row = this.screen[this.cursor.y];
    if (i >= 0 && row[i] && row[i].ch === CONT) i--;
    const cell = i >= 0 ? row[i] : null;
    const joinable = !!cell && cell.ch !== ' ' && cell.ch !== BLANK.ch;
    const isVS16 = cp === 0xfe0f;
    const isSkin = cp >= 0x1f3fb && cp <= 0x1f3ff;
    const attach = joinable && (
      w === 0 || isVS16 || isSkin || cell.ch.endsWith('\u200d') ||
      (cp >= 0x1f1e6 && cp <= 0x1f1ff && cell.ch.length < 4 && isOnlyRI(cell.ch))
    );
    if (!attach) return w === 0;

    const widen = (isVS16 || isSkin) && cell.w !== 2 && i + 1 < this.cols;
    const merged = { ch: cell.ch + ch, fg: cell.fg, bg: cell.bg, at: cell.at, w: widen ? 2 : cell.w };
    if (widen) {
      this.sanitizeAt(row, i + 1);
      row[i + 1] = { ch: CONT, fg: cell.fg, bg: cell.bg, at: cell.at };
      if (this.cursor.x === i + 1) {
        this.cursor.x = i + 2;
        if (this.cursor.x >= this.cols) {
          this.cursor.x = this.cols - 1;
          this.wrapPending = this.wrap;
        }
      }
    }
    row[i] = merged;
    return true;
  }

  /** Avoid dangling halves when overwriting part of a wide character. */
  sanitizeAt(row, x) {
    if (x < 0 || x >= this.cols) return;
    const c = row[x];
    if (!c) return;
    if (c.ch === CONT) {
      if (x > 0 && row[x - 1].w === 2) row[x - 1] = BLANK;
    } else if (c.w === 2 && x + 1 < this.cols && row[x + 1].ch === CONT) {
      row[x + 1] = BLANK;
    }
  }

  /** After shifting a row (ICH/DCH), drop broken wide-char halves. */
  sanitizeRow(row) {
    for (let x = 0; x < this.cols; x++) {
      const c = row[x];
      if (c.ch === CONT) {
        if (x === 0 || row[x - 1].w !== 2) row[x] = BLANK;
      } else if (c.w === 2) {
        if (x + 1 >= this.cols || row[x + 1].ch !== CONT) row[x] = BLANK;
      }
    }
  }

  /* ---------------- cursor & scrolling ---------------- */

  cursorMoved() { this.wrapPending = false; }

  lineFeed() {
    this.wrapPending = false;
    if (this.lnm) this.cursor.x = 0;
    if (this.cursor.y === this.scrollBottom) this.scrollUp(1);
    else if (this.cursor.y < this.rows - 1) this.cursor.y++;
  }

  reverseIndex() {
    this.wrapPending = false;
    if (this.cursor.y === this.scrollTop) this.scrollDown(1);
    else if (this.cursor.y > 0) this.cursor.y--;
  }

  scrollUp(n = 1, top = this.scrollTop, bot = this.scrollBottom) {
    for (let k = 0; k < n; k++) {
      const removed = this.screen[top];
      for (let y = top; y < bot; y++) this.screen[y] = this.screen[y + 1];
      this.screen[bot] = blankRow(this.cols);
      if (!this.isAlt && top === 0) this.onScrollLine(this.rowToHTML(removed));
    }
  }

  scrollDown(n = 1, top = this.scrollTop, bot = this.scrollBottom) {
    for (let k = 0; k < n; k++) {
      for (let y = bot; y > top; y--) this.screen[y] = this.screen[y - 1];
      this.screen[top] = blankRow(this.cols);
    }
  }

  clampY(y, lower, upper) { return Math.max(lower, Math.min(upper, y)); }

  /* ---------------- erase / edit ops ---------------- */

  eraseInLine(mode) {
    const row = this.screen[this.cursor.y];
    const { x } = this.cursor;
    if (mode === 0) {
      for (let i = x; i < this.cols; i++) row[i] = BLANK;
      if (row.length > this.cols) row.length = this.cols; // clear past-edge tail too
    } else if (mode === 1) for (let i = 0; i <= x && i < this.cols; i++) row[i] = BLANK;
    else if (mode >= 2) this.screen[this.cursor.y] = blankRow(this.cols);
  }

  eraseInDisplay(mode) {
    const { x, y } = this.cursor;
    if (mode === 0) {
      this.eraseInLine(0);
      for (let yy = y + 1; yy < this.rows; yy++) this.screen[yy] = blankRow(this.cols);
    } else if (mode === 1) {
      this.eraseInLine(1);
      for (let yy = 0; yy < y; yy++) this.screen[yy] = blankRow(this.cols);
    } else if (mode === 2) {
      for (let yy = 0; yy < this.rows; yy++) this.screen[yy] = blankRow(this.cols);
    } else if (mode === 3) {
      for (let yy = 0; yy < this.rows; yy++) this.screen[yy] = blankRow(this.cols);
      this.onClearScrollback();
    }
  }

  insertLines(n) {
    const { y } = this.cursor;
    if (y < this.scrollTop || y > this.scrollBottom) return;
    this.scrollDown(n, y, this.scrollBottom);
  }

  deleteLines(n) {
    const { y } = this.cursor;
    if (y < this.scrollTop || y > this.scrollBottom) return;
    // shift up within region; push to scrollback only when it's a full-region delete at the top
    const top = y, bot = this.scrollBottom;
    for (let k = 0; k < n; k++) {
      const removed = this.screen[top];
      for (let yy = top; yy < bot; yy++) this.screen[yy] = this.screen[yy + 1];
      this.screen[bot] = blankRow(this.cols);
      if (!this.isAlt && top === 0) this.onScrollLine(this.rowToHTML(removed));
    }
  }

  insertChars(n) {
    const row = this.screen[this.cursor.y];
    const { x } = this.cursor;
    const shifted = row.slice();
    for (let i = this.cols - 1; i >= x + n; i--) shifted[i] = row[i - n];
    for (let i = x; i < Math.min(x + n, this.cols); i++) shifted[i] = BLANK;
    this.sanitizeRow(shifted);
    this.screen[this.cursor.y] = shifted;
  }

  deleteChars(n) {
    const row = this.screen[this.cursor.y];
    const { x } = this.cursor;
    const shifted = row.slice();
    for (let i = x; i < this.cols; i++) {
      shifted[i] = i + n < this.cols ? row[i + n] : BLANK;
    }
    this.sanitizeRow(shifted);
    this.screen[this.cursor.y] = shifted;
  }

  eraseChars(n) {
    const row = this.screen[this.cursor.y];
    for (let i = this.cursor.x; i < Math.min(this.cursor.x + n, this.cols); i++) row[i] = BLANK;
  }

  /* ---------------- alt screen ---------------- */

  enterAlt(saveCursor) {
    if (this.isAlt) return;
    if (saveCursor) this.savedNormal = this.snapshotCursor();
    this.alt = blankGrid(this.cols, this.rows);
    this.isAlt = true;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.onAlt(true);
  }

  exitAlt(restoreCursor) {
    if (!this.isAlt) return;
    this.isAlt = false;
    this.alt = null;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.onAlt(false);
    if (restoreCursor && this.savedNormal) this.restoreSnapshot(this.savedNormal);
  }

  snapshotCursor() {
    return {
      x: this.cursor.x, y: this.cursor.y,
      fg: this.curFg, bg: this.curBg, at: this.curAt,
      origin: this.originMode, wrap: this.wrap,
    };
  }

  restoreSnapshot(s) {
    this.cursor.x = Math.min(s.x, this.cols - 1);
    this.cursor.y = Math.min(s.y, this.rows - 1);
    this.curFg = s.fg; this.curBg = s.bg; this.curAt = s.at;
    this.originMode = s.origin; this.wrap = s.wrap;
    this.wrapPending = false;
  }

  /* ---------------- SGR ---------------- */

  sgr(pstr) {
    if (pstr === '') { this.curFg = null; this.curBg = null; this.curAt = 0; return; }
    const parts = pstr.split(';');
    const rgb = (nums) => {
      const vals = nums.slice(-3).map((v) => Math.max(0, Math.min(255, v | 0)));
      return '#' + hex2(vals[0]) + hex2(vals[1]) + hex2(vals[2]);
    };
    const base = (s) => {
      const m = /^(\d+)/.exec(s);
      return m ? parseInt(m[1], 10) : NaN;
    };

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];

      if (p.includes(':')) {
        // ITU T.416 subparameters, e.g. "38:2::255:0:0" or "4:3"
        const sub = p.split(':').map((s) => (s === '' ? NaN : Number(s)));
        const code = Number.isNaN(sub[0]) ? 0 : sub[0];
        if (code === 38 || code === 48) {
          const tail = sub.slice(1).filter((n) => !Number.isNaN(n));
          if (tail[0] === 5) {
            const c = color256(tail[1] | 0);
            if (code === 38) this.curFg = c; else this.curBg = c;
          } else if (tail[0] === 2) {
            const c = rgb(tail.slice(1));
            if (code === 38) this.curFg = c; else this.curBg = c;
          }
        } else {
          this.applySGR(code);
        }
        continue;
      }

      const n = base(p);
      if (Number.isNaN(n)) continue;

      if (n === 38 || n === 48) {
        const nxt = parts[i + 1];
        if (nxt === '5') {
          const c = color256((base(parts[i + 2]) || 0));
          if (n === 38) this.curFg = c; else this.curBg = c;
          i += 2;
        } else if (nxt === '2') {
          const r = base(parts[i + 2]) || 0, g = base(parts[i + 3]) || 0, b = base(parts[i + 4]) || 0;
          const c = rgb([r, g, b]);
          if (n === 38) this.curFg = c; else this.curBg = c;
          i += 4;
        }
        continue;
      }
      this.applySGR(n);
    }
  }

  applySGR(n) {
    switch (n) {
      case 0: this.curFg = null; this.curBg = null; this.curAt = 0; break;
      case 1: this.curAt |= BOLD; break;
      case 2: this.curAt |= DIM; break;
      case 3: this.curAt |= ITALIC; break;
      case 4: this.curAt |= UNDERLINE; break;
      case 5: case 6: this.curAt |= DIM; break; // blink: approximated
      case 7: this.curAt |= INVERSE; break;
      case 8: this.curAt |= HIDDEN; break;
      case 9: this.curAt |= STRIKE; break;
      case 21: case 22: this.curAt &= ~(BOLD | DIM); break;
      case 23: this.curAt &= ~ITALIC; break;
      case 24: this.curAt &= ~UNDERLINE; break;
      case 25: this.curAt &= ~DIM; break;
      case 27: this.curAt &= ~INVERSE; break;
      case 28: this.curAt &= ~HIDDEN; break;
      case 29: this.curAt &= ~STRIKE; break;
      case 39: this.curFg = null; break;
      case 49: this.curBg = null; break;
      default:
        if (n >= 30 && n <= 37) this.curFg = n - 30;
        else if (n >= 40 && n <= 47) this.curBg = n - 40;
        else if (n >= 90 && n <= 97) this.curFg = n - 90 + 8;
        else if (n >= 100 && n <= 107) this.curBg = n - 100 + 8;
        break;
    }
  }

  /* ---------------- resize ---------------- */

  resize(cols, rows) {
    cols = Math.max(10, cols | 0);
    rows = Math.max(4, rows | 0);
    if (cols === this.cols && rows === this.rows) return;

    const oldRows = this.rows;
    const current = this.screen;

    // last row index that still has visible content
    const lastUsed = (grid) => {
      for (let y = grid.length - 1; y >= 0; y--) {
        const row = grid[y];
        let end = row.length;
        while (end > 0) {
          const c = row[end - 1];
          const blank = c.ch === ' ' && c.fg === null && c.bg === null && c.at === 0;
          if (blank || c.ch === CONT) end--;
          else break;
        }
        if (end > 0) return y;
      }
      return 0;
    };

    // narrowing keeps past-edge cells so text comes back when the window grows
    const adoptRow = (src) => {
      if (src.length >= cols) return src;
      const r = src.slice();
      while (r.length < cols) r.push(BLANK);
      return r;
    };

    // Row-shrink slides content up by an anchor and routes overflow to scrollback.
    const retarget = (grid, isCurrent) => {
      let m = 0;
      if (rows < oldRows) {
        let anchor = lastUsed(grid);
        if (isCurrent && this.cursor.y > anchor) anchor = this.cursor.y;
        m = Math.max(0, anchor - (rows - 1));
      }
      if (m > 0 && grid === this.normal) {
        for (let y = 0; y < m && y < grid.length; y++) {
          this.onScrollLine(this.rowToHTML(grid[y]));
        }
      }
      const g = blankGrid(cols, rows);
      for (let y = 0; y < rows; y++) {
        const src = grid[m + y];
        if (!src) break;
        g[y] = adoptRow(src);
      }
      return { g, m };
    };

    let newNormal, newAlt = null, mCur = 0;
    if (current === this.normal) {
      const r = retarget(this.normal, true);
      newNormal = r.g;
      mCur = r.m;
    } else {
      newNormal = retarget(this.normal, false).g;
    }
    if (this.alt) {
      const r = retarget(this.alt, current === this.alt);
      newAlt = r.g;
      if (current === this.alt) mCur = r.m;
    }

    this.cols = cols;
    this.rows = rows;
    this.normal = newNormal;
    if (this.alt) this.alt = newAlt;
    for (const g of [this.normal, this.alt]) {
      if (!g) continue;
      for (let y = 0; y < g.length; y++) this.sanitizeRow(g[y]);
    }
    this.cursor.x = Math.min(this.cursor.x, cols - 1);
    this.cursor.y = Math.max(0, Math.min(this.cursor.y - mCur, rows - 1));
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.wrapPending = false;
    this.fillTabs();
  }

  /* ---------------- input stream parser ---------------- */

  write(str) {
    if (!str) return;
    if (this.surrogateHold) {
      str = this.surrogateHold + str;
      this.surrogateHold = '';
    }
    // hold a trailing high surrogate until its pair arrives in the next frame
    const tail = str.charCodeAt(str.length - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) {
      this.surrogateHold = str.slice(-1);
      str = str.slice(0, -1);
      if (!str) return;
    }
    let i = 0;
    const n = str.length;

    while (i < n) {
      const code = str.charCodeAt(i);

      // combine surrogate pairs so emoji stay in one cell
      let ch = str[i];
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
        const code2 = str.charCodeAt(i + 1);
        if (code2 >= 0xdc00 && code2 <= 0xdfff) { ch = str.slice(i, i + 2); i += 2; this.consumeChar(ch, true); continue; }
      }

      switch (this.state) {
        case S_GROUND:
          i++;
          this.ground(ch, code);
          break;

        case S_ESC:
          i++;
          this.escSeq(ch, code);
          break;

        case S_CHARSET:
          i++; // designated charset — ignored
          this.state = S_GROUND;
          break;

        case S_CSI:
          i++;
          if (code >= 0x40 && code <= 0x7e) {
            const buf = this.csiBuf;
            this.csiBuf = '';
            this.state = S_GROUND;
            this.dispatchCSI(buf, ch);
          } else {
            this.csiBuf += ch;
            if (this.csiBuf.length > 256) { this.csiBuf = ''; this.state = S_GROUND; }
          }
          break;

        case S_OSC:
          i++;
          if (code === 0x07) { this.state = S_GROUND; this.dispatchOSC(); }
          else if (code === 0x1b) this.state = S_OSC_ESC;
          else {
            this.oscBuf += ch;
            if (this.oscBuf.length > 8192) { this.oscBuf = ''; this.state = S_GROUND; }
          }
          break;

        case S_OSC_ESC:
          i++;
          this.state = S_GROUND;
          if (ch === '\\') this.dispatchOSC();
          else { this.oscBuf = ''; this.ground(ch, code); } // malformed — resync
          break;

        case S_STRING:
          i++;
          if (code === 0x1b) this.state = S_STRING_ESC;
          else if (code === 0x07) this.state = S_GROUND; // some terminals use BEL
          break;

        case S_STRING_ESC:
          i++;
          this.state = ch === '\\' ? S_GROUND : S_STRING;
          break;
      }
    }
  }

  consumeChar(ch, isPair) {
    if (this.state === S_GROUND) this.ground(ch, ch.charCodeAt(0));
    else if (this.state === S_ESC) this.escSeq(ch, ch.charCodeAt(0));
    else if (this.state === S_CSI) {
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) {
        const buf = this.csiBuf; this.csiBuf = ''; this.state = S_GROUND;
        this.dispatchCSI(buf, ch);
      } else { this.csiBuf += ch; }
    } else if (this.state === S_OSC) this.oscBuf += ch;
    // other states: swallow
  }

  ground(ch, code) {
    switch (code) {
      case 0x1b: this.state = S_ESC; return;
      case 0x0d: this.cursor.x = 0; this.wrapPending = false; return;
      case 0x0a: case 0x0b: this.lineFeed(); return;
      case 0x08: this.cursor.x = Math.max(0, this.cursor.x - 1); this.wrapPending = false; return;
      case 0x09: this.tab(); return;
      case 0x07: this.onBell(); return;
      case 0x00: case 0x0e: case 0x0f: case 0x7f: return;
      default:
        if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) return; // C0/C1 controls: ignore
        this.putChar(ch);
    }
  }

  tab() {
    let x = this.cursor.x + 1;
    while (x < this.cols - 1 && !this.tabs.has(x)) x++;
    this.cursor.x = Math.min(x, this.cols - 1);
    this.wrapPending = false;
  }

  escSeq(ch, code) {
    switch (ch) {
      case '[': this.state = S_CSI; this.csiBuf = ''; return;
      case ']': this.state = S_OSC; this.oscBuf = ''; return;
      case 'P': case 'X': case '^': case '_': this.state = S_STRING; return;
      case '(': case ')': case '*': case '+': case '#': case '%':
        this.state = S_CHARSET; return;
      case '7': this.savedSlot = this.snapshotCursor(); break;
      case '8': if (this.savedSlot) this.restoreSnapshot(this.savedSlot); break;
      case 'D': this.lineFeed(); break;            // IND
      case 'E': this.cursor.x = 0; this.lineFeed(); break; // NEL
      case 'M': this.reverseIndex(); break;        // RI
      case 'H': this.tabs.add(this.cursor.x); break; // HTS
      case 'c': this.reset(true); break;           // RIS
      case '=': case '>': case '\\': break;        // keypad / ST
      default: break;
    }
    this.state = S_GROUND;
  }

  dispatchOSC() {
    const buf = this.oscBuf;
    this.oscBuf = '';
    const semi = buf.indexOf(';');
    if (semi < 0) return;
    const cmd = buf.slice(0, semi);
    const payload = buf.slice(semi + 1);
    if (cmd === '0' || cmd === '2') {
      this.title = payload;
      this.onTitle(payload);
    }
    // 8 (hyperlinks), 7 (icon), notifications … ignored: plain text only
  }

  /* ---------------- CSI dispatch ---------------- */

  dispatchCSI(raw, final) {
    let priv = '', interm = '', pstr = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const c = raw.charCodeAt(i);
      if (c >= 0x30 && c <= 0x3f) {
        if (pstr === '' && interm === '' && (ch === '?' || ch === '>' || ch === '<' || ch === '=')) priv += ch;
        else pstr += ch;
      } else if (c >= 0x20 && c <= 0x2f) interm += ch;
      else pstr += ch;
    }
    const params = pstr === '' ? [] : pstr.split(';');
    const num = (idx, def) => {
      const s = params[idx];
      if (s === undefined || s === '') return def;
      const v = parseInt(s, 10);
      return Number.isNaN(v) ? def : v;
    };
    const cnt = (idx) => Math.max(1, num(idx, 1));

    // --- modes -------------------------------------------------------
    if (final === 'h' || final === 'l') {
      const on = final === 'h';
      const list = params.length ? params.map((s) => parseInt(s, 10) || 0) : [0];
      for (const p of list) {
        if (priv === '?') {
          switch (p) {
            case 1: this.appCursor = on; break;
            case 6: this.originMode = on; this.cursor.x = 0; this.cursor.y = on ? this.scrollTop : 0; break;
            case 7: this.wrap = on; if (!on) this.wrapPending = false; break;
            case 25: this.cursorVisible = on; break;
            case 47: case 1047: on ? this.enterAlt(false) : this.exitAlt(false); break;
            case 1048: on ? (this.savedSlot = this.snapshotCursor()) : (this.savedSlot && this.restoreSnapshot(this.savedSlot)); break;
            case 1049: on ? this.enterAlt(true) : this.exitAlt(true); break;
            case 9: case 1000: case 1002: case 1003: case 1006:
              if (on) this.mouseMode = p; else if (this.mouseMode === p) this.mouseMode = 0; break;
            case 2004: this.bracketedPaste = on; break;
            default: break;
          }
        } else {
          if (p === 4) this.insertMode = on;
          if (p === 20) this.lnm = on;
        }
      }
      return;
    }

    // --- SGR ---------------------------------------------------------
    if (final === 'm' && priv === '') { this.sgr(pstr); return; }

    // --- cursor position report / device attributes -------------------
    if (final === 'n') {
      const p = num(0, 0);
      if (priv === '?') {
        if (p === 6) this.onResponse(`\u001b[?${this.cursor.y + 1};${this.cursor.x + 1}R`);
      } else {
        if (p === 5) this.onResponse('\u001b[0n');
        else if (p === 6) this.onResponse(`\u001b[${this.cursor.y + 1};${this.cursor.x + 1}R`);
      }
      return;
    }
    if (final === 'c') {
      this.onResponse(priv === '>' ? '\u001b[>0;10;1c' : '\u001b[?6c');
      return;
    }

    // --- DECSTR / DECRQM ---------------------------------------------
    if (final === 'p' && interm === '!') {
      const keep = { x: this.cursor.x, y: this.cursor.y };
      this.curFg = null; this.curBg = null; this.curAt = 0;
      this.wrap = true; this.appCursor = false; this.cursorVisible = true;
      this.insertMode = false; this.originMode = false; this.bracketedPaste = false;
      this.scrollTop = 0; this.scrollBottom = this.rows - 1;
      this.cursor.x = Math.min(keep.x, this.cols - 1);
      this.cursor.y = Math.min(keep.y, this.rows - 1);
      return;
    }
    if (final === 'p' && interm === '$') {
      const p = num(0, 0);
      let on = 2;
      if (priv === '?') {
        const M = { 1: this.appCursor, 6: this.originMode, 7: this.wrap, 12: false,
                    25: this.cursorVisible, 47: this.isAlt, 1047: this.isAlt,
                    1049: this.isAlt, 2004: this.bracketedPaste,
                    9: this.mouseMode === 9, 1000: !!this.mouseMode, 1002: !!this.mouseMode,
                    1003: !!this.mouseMode, 1006: !!this.mouseMode };
        if (p in M) on = M[p] ? 1 : 2;
      }
      this.onResponse(`\u001b[${priv}${p};${on}$y`);
      return;
    }

    // --- everything else ---------------------------------------------
    switch (final) {
      case 'A': { // CUU
        const low = this.cursor.y >= this.scrollTop && this.cursor.y <= this.scrollBottom ? this.scrollTop : 0;
        this.cursor.y = Math.max(low, this.cursor.y - cnt(0)); this.cursorMoved(); break;
      }
      case 'B': case 'e': { // CUD / VPR
        const hi = this.cursor.y >= this.scrollTop && this.cursor.y <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
        this.cursor.y = Math.min(hi, this.cursor.y + cnt(0)); this.cursorMoved(); break;
      }
      case 'C': // CUF
        this.cursor.x = Math.min(this.cols - 1, this.cursor.x + cnt(0)); this.cursorMoved(); break;
      case 'D': // CUB
        this.cursor.x = Math.max(0, this.cursor.x - cnt(0)); this.cursorMoved(); break;
      case 'E': // CNL
        this.cursor.y = Math.min(this.rows - 1, this.cursor.y + cnt(0));
        this.cursor.x = 0; this.cursorMoved(); break;
      case 'F': // CPL
        this.cursor.y = Math.max(0, this.cursor.y - cnt(0));
        this.cursor.x = 0; this.cursorMoved(); break;
      case 'G': case '`': // CHA / HPA
        this.cursor.x = this.clampY(num(0, 1) - 1, 0, this.cols - 1); this.cursorMoved(); break;
      case 'd': { // VPA
        const y = this.originMode ? this.scrollTop + num(0, 1) - 1 : num(0, 1) - 1;
        this.cursor.y = this.clampY(y, 0, this.rows - 1); this.cursorMoved(); break;
      }
      case 'H': case 'f': { // CUP / HVP
        const row = num(0, 1), col = num(1, 1);
        const y = this.originMode ? this.scrollTop + row - 1 : row - 1;
        const maxY = this.originMode ? this.scrollBottom : this.rows - 1;
        this.cursor.y = this.clampY(y, 0, maxY);
        this.cursor.x = this.clampY(col - 1, 0, this.cols - 1);
        this.cursorMoved(); break;
      }
      case 'J': this.eraseInDisplay(num(0, 0)); this.cursorMoved(); break;
      case 'K': this.eraseInLine(num(0, 0)); break;
      case 'L': this.insertLines(cnt(0)); break;
      case 'M': this.deleteLines(cnt(0)); break;
      case '@': this.insertChars(cnt(0)); break;
      case 'P': this.deleteChars(cnt(0)); break;
      case 'X': this.eraseChars(cnt(0)); break;
      case 'S': this.scrollUp(cnt(0)); break;
      case 'T': this.scrollDown(cnt(0)); break;
      case 'I': for (let k = 0; k < cnt(0); k++) this.tab(); break;
      case 'Z': { // CBT
        let x = this.cursor.x - 1;
        while (x > 0 && !this.tabs.has(x)) x--;
        this.cursor.x = Math.max(0, x); this.cursorMoved(); break;
      }
      case 'g': // TBC
        if (num(0, 0) === 3) this.tabs.clear();
        else this.tabs.delete(this.cursor.x);
        break;
      case 'r': { // DECSTBM
        let top = num(0, 1), bot = num(1, this.rows);
        top = Math.max(1, top); bot = Math.min(this.rows, bot);
        if (bot > top) {
          this.scrollTop = top - 1;
          this.scrollBottom = bot - 1;
          this.cursor.x = 0;
          this.cursor.y = this.originMode ? this.scrollTop : 0;
          this.cursorMoved();
        }
        break;
      }
      case 's': this.savedSlot = this.snapshotCursor(); break; // SCOSC
      case 'u': if (this.savedSlot) this.restoreSnapshot(this.savedSlot); break; // SCORC
      case 'b': { // REP — repeat last graphic char
        const nRep = cnt(0);
        if (this.lastCh) for (let k = 0; k < nRep; k++) this.putChar(this.lastCh);
        break;
      }
      case 't': case 'w': case 'q': case 'p': case 'x': case 'y': case 'z':
        break; // window ops, cursor style, DECEP … ignored
      default:
        break;
    }
  }

  /* ---------------- rendering ---------------- */

  rowToHTML(row) {
    let end = row.length;
    while (end > 0) {
      const c = row[end - 1];
      const blank = (c.ch === ' ' && c.fg === null && c.bg === null && c.at === 0);
      if (blank || c.ch === CONT) end--;
      else break;
    }
    if (end === 0) return '&nbsp;';

    let out = '';
    let i = 0;
    while (i < end) {
      const c0 = row[i];
      const fg = c0.fg, bg = c0.bg, at = c0.at;
      let text = '';
      let j = i;
      while (j < end) {
        const c = row[j];
        if (c.fg !== fg || c.bg !== bg || c.at !== at) break;
        if (c.ch !== CONT) text += c.ch;
        j++;
      }
      out += spanWrap(fg, bg, at, text);
      i = j;
    }
    return out;
  }

  render(rowsEl, cursorEl) {
    let html = '';
    const scr = this.screen;
    for (let y = 0; y < this.rows; y++) html += '<div class="row">' + this.rowToHTML(scr[y]) + '</div>';
    rowsEl.innerHTML = html;

    if (this.cursorVisible) {
      cursorEl.classList.add('on');
      cursorEl.style.transform =
        `translate(${(this.cursor.x * this.cell.w).toFixed(2)}px, ${(this.cursor.y * this.cell.h).toFixed(2)}px)`;
    } else {
      cursorEl.classList.remove('on');
    }
  }
}

function spanWrap(fg, bg, at, text) {
  if (text === '') return '';
  if (at === 0 && fg === null && bg === null) return esc(text);

  let cf = fg === null ? 'var(--fg)' : (typeof fg === 'number' ? PALETTE[fg + ((at & BOLD) && fg < 8 ? 8 : 0)] : fg);
  let cb = bg === null ? 'var(--bg)' : (typeof bg === 'number' ? PALETTE[bg] : bg);
  if (at & INVERSE) { const t = cf; cf = cb; cb = t; }

  let css = 'color:' + cf + ';background:' + cb + ';';
  if (at & BOLD) css += 'font-weight:700;';
  if (at & DIM) css += 'opacity:.6;';
  if (at & ITALIC) css += 'font-style:italic;';
  const deco = [];
  if (at & UNDERLINE) deco.push('underline');
  if (at & STRIKE) deco.push('line-through');
  if (deco.length) css += 'text-decoration:' + deco.join(' ') + ';';
  if (at & HIDDEN) css += 'visibility:hidden;';

  return '<span style="' + css + '">' + esc(text) + '</span>';
}

/* ================================================================== */
/* Key mapping                                                         */
/* ================================================================== */

function ctrlChar(k) {
  if (k === ' ') return '\x00';
  if (k === '/') return '\x1f';
  if (k === '?') return '\x7f';
  const d = { '2': '\x00', '3': '\x1b', '4': '\x1c', '5': '\x1d', '6': '\x1e', '7': '\x1f', '8': '\x7f' };
  if (d[k]) return d[k];
  if ((k >= 'a' && k <= 'z') || (k >= 'A' && k <= 'Z')) {
    return String.fromCharCode(k.toUpperCase().charCodeAt(0) & 0x1f);
  }
  if ('@[]\\^_'.includes(k)) return String.fromCharCode(k.charCodeAt(0) & 0x1f);
  return null;
}

function keySeq(e, term) {
  const k = e.key;
  const ctrl = e.ctrlKey, alt = e.altKey, shift = e.shiftKey;
  const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);

  // let the browser keep copy / cut / paste chords
  if (ctrl && (k === 'v' || k === 'V')) return null;
  if (ctrl && shift && (k === 'c' || k === 'C' || k === 'x' || k === 'X')) return null;
  if (k === 'Insert' && (shift || ctrl)) return null;
  if (k === 'Delete' && shift) return null;

  switch (k) {
    case 'Enter': return ctrl ? '\n' : alt ? '\x1b\r' : '\r';
    case 'Backspace': return alt ? '\x1b\x7f' : '\x7f';
    case 'Tab': return shift ? '\x1b[Z' : '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return mod === 1 ? (term.appCursor ? '\x1bOA' : '\x1b[A') : `\x1b[1;${mod}A`;
    case 'ArrowDown': return mod === 1 ? (term.appCursor ? '\x1bOB' : '\x1b[B') : `\x1b[1;${mod}B`;
    case 'ArrowRight': return mod === 1 ? (term.appCursor ? '\x1bOC' : '\x1b[C') : `\x1b[1;${mod}C`;
    case 'ArrowLeft': return mod === 1 ? (term.appCursor ? '\x1bOD' : '\x1b[D') : `\x1b[1;${mod}D`;
    case 'Home': return mod === 1 ? (term.appCursor ? '\x1bOH' : '\x1b[H') : `\x1b[1;${mod}H`;
    case 'End': return mod === 1 ? (term.appCursor ? '\x1bOF' : '\x1b[F') : `\x1b[1;${mod}F`;
    case 'Insert': return `\x1b[2${mod > 1 ? ';' + mod : ''}~`;
    case 'Delete': return `\x1b[3${mod > 1 ? ';' + mod : ''}~`;
    case 'PageUp': return `\x1b[5${mod > 1 ? ';' + mod : ''}~`;
    case 'PageDown': return `\x1b[6${mod > 1 ? ';' + mod : ''}~`;
    case 'F1': return mod === 1 ? '\x1bOP' : `\x1b[1;${mod}P`;
    case 'F2': return mod === 1 ? '\x1bOQ' : `\x1b[1;${mod}Q`;
    case 'F3': return mod === 1 ? '\x1bOR' : `\x1b[1;${mod}R`;
    case 'F4': return mod === 1 ? '\x1bOS' : `\x1b[1;${mod}S`;
    case 'F5': return `\x1b[15${mod > 1 ? ';' + mod : ''}~`;
    case 'F6': return `\x1b[17${mod > 1 ? ';' + mod : ''}~`;
    case 'F7': return `\x1b[18${mod > 1 ? ';' + mod : ''}~`;
    case 'F8': return `\x1b[19${mod > 1 ? ';' + mod : ''}~`;
    case 'F9': return `\x1b[20${mod > 1 ? ';' + mod : ''}~`;
    case 'F10': return `\x1b[21${mod > 1 ? ';' + mod : ''}~`;
    case 'F11': return `\x1b[23${mod > 1 ? ';' + mod : ''}~`;
    case 'F12': return `\x1b[24${mod > 1 ? ';' + mod : ''}~`;
    default: break;
  }

  if (k.length === 1) {
    let seq = k;
    if (ctrl) {
      seq = ctrlChar(k);
      if (seq === null) return null;
    }
    if (alt) seq = '\x1b' + seq;
    return seq;
  }
  return null;
}

/* ================================================================== */
/* Client glue: DOM, WebSocket, fit, focus                             */
/* ================================================================== */

(function main() {
  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport'), scrollback = $('scrollback'), rowsEl = $('rows'),
        cursorEl = $('cursor'), probe = $('probe'), ta = $('input'),
        dot = $('dot'), titleEl = $('title'), infoEl = $('info'),
        reconnectBtn = $('reconnect'), hint = $('focus-hint');

  let cellW = 8, cellH = 17;
  let ws = null;
  let follow = true;
  let pending = false;
  const outQueue = [];

  const term = new Term({
    cols: 80,
    rows: 24,
    onScrollLine(html) {
      const div = document.createElement('div');
      div.className = 'sline';
      div.innerHTML = html;
      scrollback.appendChild(div);
      linkify(div);
      while (scrollback.childElementCount > 5000) scrollback.removeChild(scrollback.firstElementChild);
    },
    onClearScrollback() { scrollback.innerHTML = ''; },
    onAlt(isAlt) {
      document.body.classList.toggle('alt', isAlt);
      if (isAlt) { follow = true; }
      scheduleRender();
    },
    onTitle(t) {
      titleEl.textContent = t || 'webshell';
      document.title = t ? `${t} — webshell` : 'webshell';
    },
    onResponse(s) { sendInput(s); },
    onBell() { dot.style.background = '#e5c07b'; setTimeout(() => { dot.style.background = ''; }, 150); },
  });

  /* ---------- rendering ---------- */

  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      term.render(rowsEl, cursorEl);
      linkify(rowsEl);
      if (follow) viewport.scrollTop = viewport.scrollHeight;
    });
  }

  viewport.addEventListener('scroll', () => {
    const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    follow = gap < cellH * 1.5;
  });

  // Mouse-wheel scroll support (viewport only, no PTY involvement)
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return; // let browser zoom handle it
    e.stopPropagation();
  }, { passive: true });

  /* ---------- clickable links ---------- */

  const LINK_RE = /(?:https?:\/\/|ftp:\/\/|mailto:)[^\s<>'"()]+|www\.[^\s<>'"()]+/gi;

  function linkify(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !/(https?:\/\/|ftp:\/\/|mailto:|www\.)/.test(n.nodeValue)) {
          return NodeFilter.FILTER_REJECT;
        }
        return n.parentElement && n.parentElement.closest('a')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const parts = [];
      let last = 0, m;
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(text))) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        if (url.length < 5) { LINK_RE.lastIndex = m.index + 1; continue; }
        if (m.index > last) parts.push({ t: text.slice(last, m.index) });
        parts.push({ u: url });
        last = m.index + url.length;
        LINK_RE.lastIndex = last;
      }
      if (last === 0) continue;
      if (last < text.length) parts.push({ t: text.slice(last) });
      const frag = document.createDocumentFragment();
      for (const p of parts) {
        if (p.t !== undefined) {
          frag.appendChild(document.createTextNode(p.t));
        } else {
          const a = document.createElement('a');
          a.href = p.u.startsWith('www.') ? 'https://' + p.u : p.u;
          a.textContent = p.u;
          a.target = '_blank';
          a.rel = 'noopener';
          frag.appendChild(a);
        }
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* ---------- font size ---------- */

  const SIZE_MIN = 8, SIZE_MAX = 28, SIZE_DEFAULT = 14;
  let fontPx = SIZE_DEFAULT;

  function setFont(px) {
    fontPx = Math.max(SIZE_MIN, Math.min(SIZE_MAX, px));
    document.documentElement.style.setProperty('--size', fontPx + 'px');
    try { localStorage.setItem('webshell.size', String(fontPx)); } catch {}
    fit();
    scheduleRender();
  }

  /* ---------- fit to window ---------- */

  function fit() {
    const cs = getComputedStyle(viewport);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

    const pr = probe.getBoundingClientRect();
    // Measure from an actual rendered single cell for TUI alignment
    const spanWidth = Math.round(pr.width / probe.textContent.length) || 8;
    cellW = spanWidth;
    cellH = pr.height || 17;
    term.cell = { w: cellW, h: cellH };
    cursorEl.style.width = cellW.toFixed(2) + 'px';
    cursorEl.style.height = cellH.toFixed(2) + 'px';

    const cols = Math.max(20, Math.floor((viewport.clientWidth - padX) / cellW));
    const rows = Math.max(5, Math.floor((viewport.clientHeight - padY) / cellH));

    if (cols !== term.cols || rows !== term.rows) {
      term.resize(cols, rows);
      send({ type: 'resize', cols, rows });
      follow = true;
      scheduleRender();
    }
    infoEl.textContent = `${term.cols}×${term.rows}`;
  }

  let fitRaf = 0;
  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => { fitRaf = 0; fit(); });
  }

  new ResizeObserver(scheduleFit).observe(viewport);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fit(); scheduleRender(); });

  /* ---------- websocket ---------- */

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendInput(data) {
    if (!data) return;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    else outQueue.push(data);
  }

  function setConnected(on, label) {
    dot.classList.toggle('state-on', on);
    dot.classList.toggle('state-off', !on);
    reconnectBtn.hidden = on;
    if (label) infoEl.textContent = label;
    else infoEl.textContent = `${term.cols}×${term.rows}`;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = location.search || '';
    ws = new WebSocket(`${proto}//${location.host}/ws${qs}`);

    ws.addEventListener('open', () => {
      setConnected(true);
      send({ type: 'resize', cols: term.cols, rows: term.rows });
      while (outQueue.length) ws.send(JSON.stringify({ type: 'input', data: outQueue.shift() }));
      scheduleRender();
      ta.focus({ preventScroll: true });
    });

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'data') {
        term.write(m.data);
        scheduleRender();
      } else if (m.type === 'exit') {
        term.write(`\r\n\x1b[33m[ session ended — exit code ${m.code} ]\x1b[0m\r\n`);
        scheduleRender();
        setConnected(false, `exited (${m.code})`);
      }
    });

    ws.addEventListener('close', () => {
      setConnected(false, infoEl.textContent.startsWith('exited') ? infoEl.textContent : 'disconnected');
      scheduleRender();
    });

    ws.addEventListener('error', () => { /* close follows */ });
  }

  reconnectBtn.addEventListener('click', () => location.reload());

  /* ---------- keyboard ---------- */

  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Process']);

  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key === 'Process') return;

    // steal focus unless it's a pure modifier press
    if (document.activeElement !== ta && !MODIFIERS.has(e.key)) {
      ta.focus({ preventScroll: true });
    }

    const fontKey = e.ctrlKey && !e.altKey
      && ['=', '+', '-', '_', '0'].includes(e.key);
    if (fontKey) {
      e.preventDefault();
      if (e.key === '=' || e.key === '+') setFont(fontPx + 1);
      else if (e.key === '-' || e.key === '_') setFont(fontPx - 1);
      else setFont(SIZE_DEFAULT);
      return;
    }

    const seq = keySeq(e, term);
    if (seq !== null && seq !== undefined) {
      e.preventDefault();
      sendInput(seq);
    }
  });

  // IME / mobile input commits arrive through the textarea's value
  ta.addEventListener('input', () => {
    if (ta.value) { sendInput(ta.value); ta.value = ''; }
  });

  ta.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text) return;
    sendInput(term.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
  });

  /* ---------- focus ---------- */

  ta.addEventListener('focus', () => {
    document.body.classList.add('focused');
    hint.hidden = true;
  });
  ta.addEventListener('blur', () => {
    document.body.classList.remove('focused');
    hint.hidden = !(ws && ws.readyState === WebSocket.OPEN);
  });

  viewport.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) ta.focus({ preventScroll: true });
  });

  /* ---------- go ---------- */

  try {
    const saved = Number(localStorage.getItem('webshell.size'));
    if (saved >= SIZE_MIN && saved <= SIZE_MAX) {
      fontPx = saved;
      document.documentElement.style.setProperty('--size', fontPx + 'px');
    }
  } catch {}

  fit();
  scheduleRender();
  connect();
  setTimeout(() => { if (document.activeElement !== ta) hint.hidden = false; }, 500);

  // public scripting surface
  window.webshell = {
    term,
    write(s) { term.write(s); scheduleRender(); },
    send: sendInput,
    fit,
  };
})();
