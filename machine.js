(function (root) {
  "use strict";

  var MEM = 65536;
  var STATE = 0x4000;
  var TABLE = 0x2400;
  var NOTE = 0x4300;
  var SCREEN = 0, APP = 4, BOOT = 8, PHASE = 12, X = 16, Y = 20, X0 = 24, Y0 = 28;
  var DX = 32, DY = 36, SCROLL = 40, WIFI = 44, BT = 48, BRIGHT = 52, KEY = 56;
  var MAPX = 60, MAPY = 64, NOTELEN = 68, OPEN = 72, MENU = 76;

  function sex(value, bits) {
    var sign = 1 << (bits - 1);
    return ((value & ((1 << bits) - 1)) ^ sign) - sign;
  }

  function Machine() {
    this.mem = new Uint8Array(MEM);
    this.view = new DataView(this.mem.buffer);
    this.regs = new Uint32Array(32);
    this.pc = 0;
    this.z = 0;
    this.n = 0;
    this.c = 0;
    this.v = 0;
    this.yielded = false;
  }

  Machine.prototype.get = function (i) { return i === 31 ? 0 : this.regs[i]; };
  Machine.prototype.set = function (i, value) { if (i !== 31) this.regs[i] = value >>> 0; };
  Machine.prototype.u32 = function (addr) { return this.view.getUint32(addr >>> 0, true); };
  Machine.prototype.w32 = function (addr, value) { this.view.setUint32(addr >>> 0, value >>> 0, true); };

  Machine.prototype.flagSub = function (left, right) {
    var a = left | 0;
    var b = right | 0;
    var result = (a - b) | 0;
    this.z = result === 0 ? 1 : 0;
    this.n = result < 0 ? 1 : 0;
    this.c = (left >>> 0) >= (right >>> 0) ? 1 : 0;
    this.v = ((a < 0) !== (b < 0) && (a < 0) !== (result < 0)) ? 1 : 0;
    return result >>> 0;
  };

  Machine.prototype.cond = function (code) {
    var z = this.z, n = this.n, c = this.c, v = this.v;
    if (code === 0) return z === 1;
    if (code === 1) return z === 0;
    if (code === 2) return c === 1;
    if (code === 3) return c === 0;
    if (code === 8) return c === 1 && z === 0;
    if (code === 10) return n === v;
    if (code === 11) return n !== v;
    if (code === 12) return z === 0 && n === v;
    if (code === 13) return z === 1 || n !== v;
    return false;
  };

  Machine.prototype.step = function () {
    var word = this.u32(this.pc);
    var here = this.pc;
    var op = function (mask) { return (word & mask) >>> 0; };
    if (op(0xffe0001f) === 0xd4200000) { this.yielded = true; this.pc = here + 4; return; }
    if (op(0xfc000000) === 0x14000000) { this.pc = here + sex(word & 0x3ffffff, 26) * 4; return; }
    if (op(0xfffffc1f) === 0xd65f0000) { this.pc = this.get((word >>> 5) & 31); return; }
    if (op(0xff000010) === 0x54000000) {
      this.pc = this.cond(word & 15) ? here + sex((word >>> 5) & 0x7ffff, 19) * 4 : here + 4;
      return;
    }
    if (op(0x7e000000) === 0x34000000) {
      var value = this.get(word & 31);
      var take = (word & 0x01000000) ? value !== 0 : value === 0;
      this.pc = take ? here + sex((word >>> 5) & 0x7ffff, 19) * 4 : here + 4;
      return;
    }
    if (op(0xff800000) === 0x52800000) {
      this.set(word & 31, ((word >>> 5) & 0xffff) << (((word >>> 21) & 3) * 16));
      this.pc = here + 4;
      return;
    }
    if (op(0xffc00000) === 0x11000000) {
      this.set(word & 31, (this.get((word >>> 5) & 31) + ((word >>> 10) & 0xfff)) >>> 0);
      this.pc = here + 4;
      return;
    }
    if (op(0xffc00000) === 0x51000000) {
      this.set(word & 31, (this.get((word >>> 5) & 31) - ((word >>> 10) & 0xfff)) >>> 0);
      this.pc = here + 4;
      return;
    }
    if (op(0xffc00000) === 0x71000000) {
      this.set(word & 31, this.flagSub(this.get((word >>> 5) & 31), (word >>> 10) & 0xfff));
      this.pc = here + 4;
      return;
    }
    if (op(0xffe0fc00) === 0x0b000000) {
      this.set(word & 31, (this.get((word >>> 5) & 31) + this.get((word >>> 16) & 31)) >>> 0);
      this.pc = here + 4;
      return;
    }
    if (op(0xffe0fc00) === 0x4b000000) {
      this.set(word & 31, (this.get((word >>> 5) & 31) - this.get((word >>> 16) & 31)) >>> 0);
      this.pc = here + 4;
      return;
    }
    if (op(0xffe0fc00) === 0x6b000000) {
      this.set(word & 31, this.flagSub(this.get((word >>> 5) & 31), this.get((word >>> 16) & 31)));
      this.pc = here + 4;
      return;
    }
    if (op(0xffc00000) === 0xb9400000) {
      this.set(word & 31, this.u32(this.get((word >>> 5) & 31) + ((word >>> 10) & 0xfff) * 4));
      this.pc = here + 4;
      return;
    }
    if (op(0xffc00000) === 0xb9000000) {
      this.w32(this.get((word >>> 5) & 31) + ((word >>> 10) & 0xfff) * 4, this.get(word & 31));
      this.pc = here + 4;
      return;
    }
    this.yielded = true;
    this.bad = word;
    this.pc = here + 4;
  };

  Machine.prototype.frame = function () {
    this.yielded = false;
    this.bad = 0;
    this.pc = 0;
    var guard = 0;
    while (!this.yielded && guard < 8000) { this.step(); guard += 1; }
    this.steps = guard;
    return guard;
  };

  function Asm() { this.bytes = []; this.labels = {}; this.fixes = []; }
  Asm.prototype.emit = function (word) { this.bytes.push(word >>> 0); };
  Asm.prototype.label = function (name) { this.labels[name] = this.bytes.length * 4; };
  Asm.prototype.fix = function (kind, label, extra) {
    this.fixes.push({ at: this.bytes.length * 4, kind: kind, label: label, extra: extra || 0 });
    this.emit(0);
  };
  Asm.prototype.movz = function (rd, imm) { this.emit(0x52800000 | ((imm & 0xffff) << 5) | rd); };
  Asm.prototype.addImm = function (rd, rn, imm) { this.emit(0x11000000 | ((imm & 0xfff) << 10) | (rn << 5) | rd); };
  Asm.prototype.subImm = function (rd, rn, imm) { this.emit(0x51000000 | ((imm & 0xfff) << 10) | (rn << 5) | rd); };
  Asm.prototype.cmpImm = function (rn, imm) { this.emit(0x71000000 | ((imm & 0xfff) << 10) | (rn << 5) | 31); };
  Asm.prototype.cmpReg = function (rn, rm) { this.emit(0x6b000000 | (rm << 16) | (rn << 5) | 31); };
  Asm.prototype.addReg = function (rd, rn, rm) { this.emit(0x0b000000 | (rm << 16) | (rn << 5) | rd); };
  Asm.prototype.subReg = function (rd, rn, rm) { this.emit(0x4b000000 | (rm << 16) | (rn << 5) | rd); };
  Asm.prototype.ldr = function (rt, rn, byteOff) { this.emit(0xb9400000 | (((byteOff / 4) & 0xfff) << 10) | (rn << 5) | rt); };
  Asm.prototype.str = function (rt, rn, byteOff) { this.emit(0xb9000000 | (((byteOff / 4) & 0xfff) << 10) | (rn << 5) | rt); };
  Asm.prototype.b = function (label) { this.fix("b", label, 0); };
  Asm.prototype.beq = function (label) { this.fix("cond", label, 0); };
  Asm.prototype.bne = function (label) { this.fix("cond", label, 1); };
  Asm.prototype.bhs = function (label) { this.fix("cond", label, 2); };
  Asm.prototype.blo = function (label) { this.fix("cond", label, 3); };
  Asm.prototype.bhi = function (label) { this.fix("cond", label, 8); };
  Asm.prototype.bge = function (label) { this.fix("cond", label, 10); };
  Asm.prototype.blt = function (label) { this.fix("cond", label, 11); };
  Asm.prototype.bgt = function (label) { this.fix("cond", label, 12); };
  Asm.prototype.ble = function (label) { this.fix("cond", label, 13); };
  Asm.prototype.cbz = function (rt, label) { this.fix("cbz", label, rt); };
  Asm.prototype.cbnz = function (rt, label) { this.fix("cbnz", label, rt | 256); };
  Asm.prototype.brk = function () { this.emit(0xd4200000); };
  Asm.prototype.link = function () {
    var out = new Uint32Array(this.bytes.length);
    var i;
    for (i = 0; i < this.bytes.length; i += 1) out[i] = this.bytes[i];
    for (i = 0; i < this.fixes.length; i += 1) {
      var fix = this.fixes[i];
      var imm = (this.labels[fix.label] - fix.at) / 4;
      var slot = fix.at / 4;
      if (fix.kind === "b") out[slot] = 0x14000000 | (imm & 0x3ffffff);
      else if (fix.kind === "cond") out[slot] = 0x54000000 | ((imm & 0x7ffff) << 5) | fix.extra;
      else {
        var cbnz = (fix.extra & 256) !== 0;
        out[slot] = (cbnz ? 0x35000000 : 0x34000000) | ((imm & 0x7ffff) << 5) | (fix.extra & 31);
      }
    }
    return out;
  };

  var R = { base: 0, boot: 1, screen: 2, phase: 3, x: 4, y: 5, x0: 6, y0: 7, tmp: 8, dy: 9, action: 10, ptr: 11, count: 12, index: 13, left: 14, top: 15, wide: 16, tall: 17, gate: 18, need: 19, app: 20, scroll: 21, key: 22, len: 23, menu: 24 };

  function assemble() {
    var a = new Asm();
    a.movz(R.base, STATE);
    a.ldr(R.boot, R.base, BOOT);
    a.cmpImm(R.boot, 90);
    a.bhs("alive");
    a.addImm(R.boot, R.boot, 1);
    a.str(R.boot, R.base, BOOT);
    a.brk();
    a.label("alive");
    a.ldr(R.screen, R.base, SCREEN);
    a.cbnz(R.screen, "ready");
    a.movz(R.screen, 1);
    a.str(R.screen, R.base, SCREEN);
    a.brk();
    a.label("ready");
    a.ldr(R.key, R.base, KEY);
    a.cbnz(R.key, "type");
    a.ldr(R.phase, R.base, PHASE);
    a.cmpImm(R.phase, 1);
    a.beq("drag");
    a.cmpImm(R.phase, 2);
    a.beq("release");
    a.brk();
    a.label("drag");
    a.ldr(R.screen, R.base, SCREEN);
    a.cmpImm(R.screen, 4);
    a.beq("ccbright");
    a.cmpImm(R.screen, 3);
    a.bne("done");
    a.ldr(R.app, R.base, APP);
    a.cmpImm(R.app, 3);
    a.bne("dragset");
    a.ldr(R.tmp, R.base, MAPX);
    a.ldr(R.dy, R.base, DX);
    a.addReg(R.tmp, R.tmp, R.dy);
    a.str(R.tmp, R.base, MAPX);
    a.ldr(R.tmp, R.base, MAPY);
    a.ldr(R.dy, R.base, DY);
    a.addReg(R.tmp, R.tmp, R.dy);
    a.str(R.tmp, R.base, MAPY);
    a.b("done");
    a.label("dragset");
    a.cmpImm(R.app, 1);
    a.bne("done");
    a.ldr(R.y, R.base, Y);
    a.cmpImm(R.y, 300);
    a.blt("dragscroll");
    a.cmpImm(R.y, 370);
    a.bgt("dragscroll");
    a.ldr(R.x, R.base, X);
    a.str(R.x, R.base, BRIGHT);
    a.b("done");
    a.label("dragscroll");
    a.ldr(R.scroll, R.base, SCROLL);
    a.ldr(R.dy, R.base, DY);
    a.addReg(R.scroll, R.scroll, R.dy);
    a.cmpImm(R.scroll, 160);
    a.ble("smin");
    a.movz(R.scroll, 160);
    a.label("smin");
    a.cmpImm(R.scroll, 0);
    a.bge("sok");
    a.movz(R.scroll, 0);
    a.label("sok");
    a.str(R.scroll, R.base, SCROLL);
    a.b("done");
    a.label("ccbright");
    a.ldr(R.y, R.base, Y);
    a.cmpImm(R.y, 300);
    a.blt("done");
    a.cmpImm(R.y, 370);
    a.bgt("done");
    a.ldr(R.x, R.base, X);
    a.str(R.x, R.base, BRIGHT);
    a.b("done");
    a.label("release");
    a.ldr(R.x, R.base, X);
    a.ldr(R.y, R.base, Y);
    a.ldr(R.x0, R.base, X0);
    a.ldr(R.y0, R.base, Y0);
    a.subReg(R.tmp, R.x, R.x0);
    a.cmpImm(R.tmp, 0);
    a.bge("absx");
    a.subReg(R.tmp, 31, R.tmp);
    a.label("absx");
    a.cmpImm(R.tmp, 26);
    a.bhi("swipe");
    a.subReg(R.tmp, R.y, R.y0);
    a.cmpImm(R.tmp, 0);
    a.bge("absy");
    a.subReg(R.tmp, 31, R.tmp);
    a.label("absy");
    a.cmpImm(R.tmp, 26);
    a.bhi("swipe");
    a.b("tap");
    a.label("swipe");
    a.subReg(R.dy, R.y0, R.y);
    a.cmpImm(R.dy, 0);
    a.blt("down");
    a.cmpImm(R.dy, 70);
    a.blt("done");
    a.ldr(R.screen, R.base, SCREEN);
    a.cmpImm(R.screen, 1);
    a.beq("gohome");
    a.cmpImm(R.screen, 4);
    a.beq("gohome");
    a.cmpImm(R.screen, 5);
    a.beq("gohome");
    a.cmpImm(R.y0, 760);
    a.bhs("gohome");
    a.b("done");
    a.label("down");
    a.subReg(R.dy, 31, R.dy);
    a.cmpImm(R.dy, 60);
    a.blt("done");
    a.cmpImm(R.y0, 48);
    a.bhi("done");
    a.cmpImm(R.x0, 170);
    a.blo("done");
    a.movz(R.screen, 4);
    a.str(R.screen, R.base, SCREEN);
    a.b("done");
    a.label("gohome");
    a.ldr(R.app, R.base, APP);
    a.str(R.app, R.base, OPEN);
    a.movz(R.screen, 2);
    a.str(R.screen, R.base, SCREEN);
    a.movz(R.menu, 0);
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("tap");
    a.movz(R.ptr, TABLE);
    a.ldr(R.count, R.ptr, 0);
    a.movz(R.index, 0);
    a.addImm(R.ptr, R.ptr, 4);
    a.label("walk");
    a.cmpReg(R.index, R.count);
    a.bhs("done");
    a.ldr(R.left, R.ptr, 0);
    a.ldr(R.top, R.ptr, 4);
    a.ldr(R.wide, R.ptr, 8);
    a.ldr(R.tall, R.ptr, 12);
    a.ldr(R.action, R.ptr, 16);
    a.ldr(R.need, R.ptr, 20);
    a.ldr(R.gate, R.ptr, 24);
    a.ldr(R.screen, R.base, SCREEN);
    a.cmpImm(R.need, 255);
    a.beq("screenok");
    a.cmpReg(R.need, R.screen);
    a.bne("next");
    a.label("screenok");
    a.cmpImm(R.gate, 0);
    a.beq("box");
    a.cmpImm(R.gate, 1);
    a.bne("appgate");
    a.ldr(R.menu, R.base, MENU);
    a.cmpImm(R.menu, 1);
    a.bne("next");
    a.b("box");
    a.label("appgate");
    a.ldr(R.app, R.base, APP);
    a.cmpReg(R.gate, R.app);
    a.bne("next");
    a.label("box");
    a.cmpReg(R.x, R.left);
    a.blt("next");
    a.addReg(R.tmp, R.left, R.wide);
    a.cmpReg(R.x, R.tmp);
    a.bge("next");
    a.cmpReg(R.y, R.top);
    a.blt("next");
    a.addReg(R.tmp, R.top, R.tall);
    a.cmpReg(R.y, R.tmp);
    a.bge("next");
    a.b("act");
    a.label("next");
    a.addImm(R.ptr, R.ptr, 28);
    a.addImm(R.index, R.index, 1);
    a.b("walk");
    a.label("act");
    a.cmpImm(R.action, 100);
    a.beq("wifi");
    a.cmpImm(R.action, 101);
    a.beq("blue");
    a.cmpImm(R.action, 102);
    a.beq("gohome");
    a.cmpImm(R.action, 103);
    a.beq("lock");
    a.cmpImm(R.action, 104);
    a.beq("restart");
    a.cmpImm(R.action, 105);
    a.beq("menu");
    a.cmpImm(R.action, 107);
    a.beq("reopen");
    a.cmpImm(R.action, 106);
    a.beq("switcher");
    a.cmpImm(R.action, 108);
    a.beq("control");
    a.cmpImm(R.action, 8);
    a.bhi("done");
    a.str(R.action, R.base, APP);
    a.str(R.action, R.base, OPEN);
    a.movz(R.screen, 3);
    a.str(R.screen, R.base, SCREEN);
    a.movz(R.menu, 0);
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("wifi");
    a.ldr(R.tmp, R.base, WIFI);
    a.cmpImm(R.tmp, 0);
    a.beq("won");
    a.movz(R.tmp, 0);
    a.b("wstore");
    a.label("won");
    a.movz(R.tmp, 1);
    a.label("wstore");
    a.str(R.tmp, R.base, WIFI);
    a.b("done");
    a.label("blue");
    a.ldr(R.tmp, R.base, BT);
    a.cmpImm(R.tmp, 0);
    a.beq("bon");
    a.movz(R.tmp, 0);
    a.b("bstore");
    a.label("bon");
    a.movz(R.tmp, 1);
    a.label("bstore");
    a.str(R.tmp, R.base, BT);
    a.b("done");
    a.label("lock");
    a.movz(R.screen, 1);
    a.str(R.screen, R.base, SCREEN);
    a.movz(R.menu, 0);
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("restart");
    a.movz(R.boot, 0);
    a.str(R.boot, R.base, BOOT);
    a.movz(R.screen, 0);
    a.str(R.screen, R.base, SCREEN);
    a.movz(R.menu, 0);
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("menu");
    a.ldr(R.menu, R.base, MENU);
    a.cmpImm(R.menu, 0);
    a.beq("mon");
    a.movz(R.menu, 0);
    a.b("mstore");
    a.label("mon");
    a.movz(R.menu, 1);
    a.label("mstore");
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("reopen");
    a.ldr(R.app, R.base, OPEN);
    a.str(R.app, R.base, APP);
    a.movz(R.screen, 3);
    a.str(R.screen, R.base, SCREEN);
    a.b("done");
    a.label("switcher");
    a.movz(R.screen, 5);
    a.str(R.screen, R.base, SCREEN);
    a.movz(R.menu, 0);
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("control");
    a.movz(R.screen, 4);
    a.str(R.screen, R.base, SCREEN);
    a.movz(R.menu, 0);
    a.str(R.menu, R.base, MENU);
    a.b("done");
    a.label("type");
    a.ldr(R.screen, R.base, SCREEN);
    a.cmpImm(R.screen, 3);
    a.bne("clearkey");
    a.ldr(R.app, R.base, APP);
    a.cmpImm(R.app, 4);
    a.bne("clearkey");
    a.ldr(R.len, R.base, NOTELEN);
    a.cmpImm(R.key, 8);
    a.bne("put");
    a.cmpImm(R.len, 0);
    a.beq("clearkey");
    a.subImm(R.len, R.len, 1);
    a.str(R.len, R.base, NOTELEN);
    a.b("clearkey");
    a.label("put");
    a.cmpImm(R.len, 72);
    a.bhs("clearkey");
    a.addReg(R.tmp, R.len, R.len);
    a.addReg(R.tmp, R.tmp, R.tmp);
    a.addReg(R.tmp, R.base, R.tmp);
    a.addImm(R.tmp, R.tmp, NOTE - STATE);
    a.str(R.key, R.tmp, 0);
    a.addImm(R.len, R.len, 1);
    a.str(R.len, R.base, NOTELEN);
    a.label("clearkey");
    a.movz(R.key, 0);
    a.str(R.key, R.base, KEY);
    a.label("done");
    a.brk();
    return a.link();
  }

  function hit(x, y, w, h, action, screen, gate) { return [x, y, w, h, action, screen, gate]; }

  function hits() {
    var list = [];
    var ids = [6, 5, 4, 8, 3, 7, 2, 1];
    var i;
    list.push(hit(8, 8, 78, 36, 105, 255, 0));
    list.push(hit(12, 52, 168, 44, 102, 255, 1));
    list.push(hit(12, 100, 168, 44, 103, 255, 1));
    list.push(hit(12, 148, 168, 44, 104, 255, 1));
    list.push(hit(12, 196, 168, 44, 106, 255, 1));
    list.push(hit(12, 244, 168, 44, 108, 255, 1));
    list.push(hit(20, 74, 170, 156, 3, 2, 0));
    list.push(hit(200, 74, 170, 156, 6, 2, 0));
    for (i = 0; i < ids.length; i += 1) {
      list.push(hit(22 + (i % 4) * 92, 250 + Math.floor(i / 4) * 96, 62, 62, ids[i], 2, 0));
    }
    [2, 3, 4, 1].forEach(function (id, index) { list.push(hit(36 + index * 86, 748, 62, 62, id, 2, 0)); });
    list.push(hit(8, 56, 110, 48, 102, 3, 0));
    list.push(hit(20, 168, 350, 52, 100, 3, 1));
    list.push(hit(20, 220, 350, 52, 101, 3, 1));
    list.push(hit(70, 250, 250, 280, 107, 5, 0));
    list.push(hit(24, 168, 160, 86, 100, 4, 0));
    list.push(hit(206, 168, 160, 86, 101, 4, 0));
    return list;
  }

  function load(machine) {
    var code = assemble();
    var table = hits();
    var i, k;
    machine.codeWords = code.length;
    machine.first = code[0];
    for (i = 0; i < code.length; i += 1) machine.w32(i * 4, code[i]);
    machine.w32(TABLE, table.length);
    for (i = 0; i < table.length; i += 1) {
      for (k = 0; k < 7; k += 1) machine.w32(TABLE + 4 + i * 28 + k * 4, table[i][k]);
    }
    machine.w32(STATE + WIFI, 1);
    machine.w32(STATE + BT, 1);
    machine.w32(STATE + BRIGHT, 280);
  }

  function readState(machine) {
    var len = machine.u32(STATE + NOTELEN);
    var note = "";
    var i;
    for (i = 0; i < len && i < 72; i += 1) note += String.fromCharCode(machine.u32(NOTE + i * 4));
    return {
      screen: machine.u32(STATE + SCREEN),
      app: machine.u32(STATE + APP),
      boot: machine.u32(STATE + BOOT),
      scroll: machine.u32(STATE + SCROLL) | 0,
      wifi: machine.u32(STATE + WIFI),
      bt: machine.u32(STATE + BT),
      bright: machine.u32(STATE + BRIGHT),
      mapX: machine.u32(STATE + MAPX) | 0,
      mapY: machine.u32(STATE + MAPY) | 0,
      open: machine.u32(STATE + OPEN),
      menu: machine.u32(STATE + MENU),
      note: note
    };
  }

  function selfTest() {
    var machine = new Machine();
    load(machine);
    var i;
    for (i = 0; i < 100; i += 1) machine.frame();
    var locked = readState(machine);
    if (locked.screen !== 1 || locked.boot < 90) {
      throw new Error("boot " + locked.screen + " " + locked.boot + " steps " + machine.steps + " word " + (machine.first >>> 0).toString(16) + " bad " + (machine.bad >>> 0).toString(16) + " n " + machine.codeWords);
    }
    machine.w32(STATE + PHASE, 2);
    machine.w32(STATE + X, 200);
    machine.w32(STATE + Y, 400);
    machine.w32(STATE + X0, 200);
    machine.w32(STATE + Y0, 700);
    machine.frame();
    if (readState(machine).screen !== 2) throw new Error("unlock");
    machine.w32(STATE + PHASE, 2);
    machine.w32(STATE + X, 326);
    machine.w32(STATE + Y, 376);
    machine.w32(STATE + X0, 326);
    machine.w32(STATE + Y0, 376);
    machine.frame();
    var opened = readState(machine);
    if (opened.screen !== 3 || opened.app !== 1) throw new Error("open " + opened.screen + ":" + opened.app);
    machine.w32(STATE + PHASE, 2);
    machine.w32(STATE + X, 40);
    machine.w32(STATE + Y, 80);
    machine.w32(STATE + X0, 40);
    machine.w32(STATE + Y0, 80);
    machine.frame();
    if (readState(machine).screen !== 2) throw new Error("back");
    machine.w32(STATE + SCREEN, 3);
    machine.w32(STATE + APP, 4);
    machine.w32(STATE + KEY, 65);
    machine.w32(STATE + PHASE, 0);
    machine.frame();
    if (readState(machine).note !== "A") throw new Error("note " + readState(machine).note);
    machine.w32(STATE + MENU, 1);
    machine.w32(STATE + PHASE, 2);
    machine.w32(STATE + X, 40);
    machine.w32(STATE + Y, 210);
    machine.w32(STATE + X0, 40);
    machine.w32(STATE + Y0, 210);
    machine.frame();
    if (readState(machine).screen !== 5) throw new Error("switcher");
    machine.w32(STATE + MENU, 1);
    machine.w32(STATE + PHASE, 2);
    machine.w32(STATE + X, 40);
    machine.w32(STATE + Y, 260);
    machine.w32(STATE + X0, 40);
    machine.w32(STATE + Y0, 260);
    machine.frame();
    if (readState(machine).screen !== 4) throw new Error("control");
    machine.w32(STATE + PHASE, 1);
    machine.w32(STATE + X, 120);
    machine.w32(STATE + Y, 330);
    machine.frame();
    if (readState(machine).bright !== 120) throw new Error("bright");
    return "ok";
  }

  var NAMES = ["", "Settings", "Safari", "Maps", "Notes", "Photos", "Calendar", "Weather", "Clock"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var GRID = [6, 5, 4, 8, 3, 7, 2, 1];
  var DOCK = [2, 3, 4, 1];

  function rr(ctx, x, y, w, h, r) {
    var rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function font(ctx, size, weight) {
    ctx.font = (weight || 500) + " " + size + "px -apple-system, BlinkMacSystemFont, sans-serif";
  }

  function hm(d) {
    var h = d.getHours();
    var m = d.getMinutes();
    h = h % 12;
    if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" : "") + m;
  }

  function wall(ctx) {
    var g = ctx.createLinearGradient(0, 0, 40, 844);
    g.addColorStop(0, "#24538f");
    g.addColorStop(0.42, "#123056");
    g.addColorStop(1, "#070d16");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 390, 844);
    var glow = ctx.createRadialGradient(300, 150, 8, 280, 190, 240);
    glow.addColorStop(0, "rgba(255, 214, 170, .62)");
    glow.addColorStop(0.35, "rgba(120, 170, 230, .2)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 390, 844);
    ctx.fillStyle = "#08111b";
    ctx.beginPath();
    ctx.moveTo(0, 640);
    ctx.quadraticCurveTo(90, 560, 190, 610);
    ctx.quadraticCurveTo(290, 670, 390, 575);
    ctx.lineTo(390, 844);
    ctx.lineTo(0, 844);
    ctx.fill();
    ctx.fillStyle = "#0c1826";
    ctx.beginPath();
    ctx.moveTo(0, 710);
    ctx.quadraticCurveTo(140, 650, 390, 720);
    ctx.lineTo(390, 844);
    ctx.lineTo(0, 844);
    ctx.fill();
  }

  function apple(ctx) {
    ctx.save();
    ctx.translate(195, 392);
    ctx.scale(0.78, 0.78);
    ctx.translate(-85, -108);
    ctx.fillStyle = "#f5f5f7";
    ctx.fill(new Path2D("M138.1 105.6c-.3-24.2 19.8-35.8 20.7-36.4-11.3-16.5-28.8-18.8-35-19-14.9-1.5-29.1 8.8-36.6 8.8-7.6 0-19.2-8.6-31.6-8.3-16.2.2-31.2 9.4-39.6 24-16.9 29.3-4.3 72.6 12.1 96.4 8 11.6 17.6 24.6 30.2 24.1 12.1-.5 16.7-7.8 31.3-7.8s18.7 7.8 31.6 7.5c13-.2 21.2-11.8 29.1-23.5 9.2-13.4 13-26.4 13.2-27.1-.3-.1-25.3-9.7-25.6-38.5zM116.4 32.2c6.7-8.1 11.2-19.4 10-30.7-9.6.4-21.3 6.4-28.2 14.5-6.2 7.2-11.6 18.7-10.2 29.7 10.8.8 21.8-5.5 28.4-13.5z"));
    ctx.restore();
  }

  function glyph(ctx, id, x, y, s) {
    var cx = x + s / 2;
    var cy = y + s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (id === 1) {
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = "#fff";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.15, 0, 6.3);
      ctx.stroke();
      var tooth;
      for (tooth = 0; tooth < 8; tooth += 1) {
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-2.1, s * 0.2, 4.2, s * 0.1);
      }
    } else if (id === 2) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.27, 0, 6.3);
      ctx.fill();
      ctx.fillStyle = "#ff3b30";
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.2);
      ctx.lineTo(s * 0.07, s * 0.04);
      ctx.lineTo(-s * 0.07, s * 0.04);
      ctx.fill();
      ctx.fillStyle = "#0a84ff";
      ctx.beginPath();
      ctx.moveTo(0, s * 0.2);
      ctx.lineTo(s * 0.055, -s * 0.01);
      ctx.lineTo(-s * 0.055, -s * 0.01);
      ctx.fill();
    } else if (id === 3) {
      ctx.fillStyle = "rgba(255,255,255,.92)";
      rr(ctx, -s * 0.24, -s * 0.2, s * 0.48, s * 0.4, 4);
      ctx.fill();
      ctx.strokeStyle = "#34c759";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-s * 0.2, s * 0.06);
      ctx.lineTo(s * 0.18, -s * 0.08);
      ctx.stroke();
      ctx.fillStyle = "#ff3b30";
      ctx.beginPath();
      ctx.arc(s * 0.02, -s * 0.08, s * 0.07, 0, 6.3);
      ctx.fill();
    } else if (id === 4) {
      ctx.fillStyle = "#fff";
      rr(ctx, -s * 0.22, -s * 0.26, s * 0.44, s * 0.52, 3);
      ctx.fill();
      ctx.fillStyle = "#c9a227";
      var line;
      for (line = 0; line < 4; line += 1) ctx.fillRect(-s * 0.14, -s * 0.12 + line * s * 0.1, s * 0.28, 2);
    } else if (id === 5) {
      var petals = ["#ff9f0a", "#ff375f", "#bf5af2", "#0a84ff", "#30d158", "#64d2ff"];
      var petal;
      for (petal = 0; petal < 6; petal += 1) {
        ctx.rotate(Math.PI / 3);
        ctx.fillStyle = petals[petal];
        ctx.beginPath();
        ctx.ellipse(0, -s * 0.13, s * 0.075, s * 0.15, 0, 0, 6.3);
        ctx.fill();
      }
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.055, 0, 6.3);
      ctx.fill();
    } else if (id === 7) {
      ctx.fillStyle = "#ffd60a";
      ctx.beginPath();
      ctx.arc(-s * 0.05, s * 0.02, s * 0.15, 0, 6.3);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.95)";
      ctx.beginPath();
      ctx.arc(s * 0.1, s * 0.08, s * 0.13, 0, 6.3);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -s * 0.04, s * 0.11, 0, 6.3);
      ctx.fill();
    } else if (id === 8) {
      ctx.fillStyle = "#f5f5f7";
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.28, 0, 6.3);
      ctx.fill();
      ctx.strokeStyle = "#1c1c1e";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 2);
      ctx.lineTo(0, -s * 0.14);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 2);
      ctx.lineTo(s * 0.1, s * 0.02);
      ctx.stroke();
      ctx.fillStyle = "#ff9f0a";
      ctx.beginPath();
      ctx.arc(0, 0, 2.4, 0, 6.3);
      ctx.fill();
    }
    ctx.restore();
  }

  function icon(ctx, id, x, y, s, label) {
    ctx.save();
    rr(ctx, x, y, s, s, s * 0.223);
    ctx.clip();
    if (id === 6) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "#ff3b30";
      ctx.fillRect(x, y, s, s * 0.3);
      ctx.fillStyle = "#1c1c1e";
      font(ctx, Math.floor(s * 0.4), 700);
      ctx.textAlign = "center";
      ctx.fillText(String(new Date().getDate()), x + s / 2, y + s * 0.78);
    } else {
      var fills = ["", "#8e8e93", "#0a84ff", "#30d158", "#ffd60a", "#ffffff", "#fff", "#64d2ff", "#1c1c1e"];
      ctx.fillStyle = fills[id] || "#333";
      ctx.fillRect(x, y, s, s);
      glyph(ctx, id, x, y, s);
    }
    ctx.restore();
    ctx.save();
    rr(ctx, x + 0.5, y + 0.5, s - 1, s - 1, s * 0.223);
    ctx.strokeStyle = "rgba(255,255,255,.28)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    if (label) {
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = 4;
      font(ctx, 11, 500);
      ctx.textAlign = "center";
      ctx.fillText(NAMES[id], x + s / 2, y + s + 15);
      ctx.shadowBlur = 0;
    }
  }

  function indicator(ctx, ink) {
    rr(ctx, 132, 824, 126, 5, 2.5);
    ctx.fillStyle = ink === "#000" ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.9)";
    ctx.fill();
  }

  function status(ctx, ink, d) {
    ctx.fillStyle = ink;
    font(ctx, 15, 600);
    ctx.textAlign = "center";
    ctx.fillText(hm(d), 210, 31);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    rr(ctx, 332, 18, 25, 12, 3);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fillRect(334, 20, 16, 8);
    ctx.fillRect(357, 21, 2, 6);
  }

  function back(ctx, ink) {
    ctx.fillStyle = ink;
    font(ctx, 17, 400);
    ctx.textAlign = "left";
    ctx.fillText("‹  Back", 18, 86);
  }

  function title(ctx, ink, text) {
    ctx.fillStyle = ink;
    font(ctx, 17, 650);
    ctx.textAlign = "center";
    ctx.fillText(text, 214, 86);
  }

  function toggle(ctx, x, y, on) {
    rr(ctx, x, y, 50, 30, 15);
    ctx.fillStyle = on ? "#30d158" : "rgba(120,120,128,.45)";
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(on ? x + 35 : x + 15, y + 15, 12, 0, 6.3);
    ctx.fill();
  }

  function keys() {
    var rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
    var list = [];
    var top = 548;
    var r, i, row, w, gap, x, y;
    for (r = 0; r < rows.length; r += 1) {
      row = rows[r];
      y = top + r * 48;
      gap = 5;
      w = r === 2 ? 30 : (390 - 12 - gap * (row.length - 1)) / row.length;
      x = r === 2 ? 58 : (390 - (row.length * w + (row.length - 1) * gap)) / 2;
      if (r === 2) list.push({ x: 8, y: y, w: 46, h: 42, code: 8, label: "del" });
      for (i = 0; i < row.length; i += 1) {
        list.push({ x: x, y: y, w: w, h: 42, code: row.charCodeAt(i), label: row[i] });
        x += w + gap;
      }
    }
    list.push({ x: 78, y: top + 144, w: 234, h: 42, code: 32, label: "space" });
    return list;
  }

  function keyCode(x, y) {
    var list = keys();
    var i;
    for (i = 0; i < list.length; i += 1) {
      var key = list[i];
      if (x >= key.x && x < key.x + key.w && y >= key.y && y < key.y + key.h) return key.code;
    }
    return 0;
  }

  function paintKeys(ctx) {
    var list = keys();
    var i;
    ctx.fillStyle = "#1c1c1e";
    ctx.fillRect(0, 530, 390, 314);
    for (i = 0; i < list.length; i += 1) {
      var key = list[i];
      rr(ctx, key.x, key.y, key.w, key.h, 8);
      ctx.fillStyle = key.code === 8 || key.code === 32 ? "#3a3a3c" : "#636366";
      ctx.fill();
      ctx.fillStyle = "#fff";
      font(ctx, key.code === 32 ? 13 : 16, 500);
      ctx.textAlign = "center";
      ctx.fillText(key.label, key.x + key.w / 2, key.y + 27);
    }
  }

  function paintBoot(ctx, boot) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 390, 844);
    apple(ctx);
    rr(ctx, 125, 560, 140, 4, 2);
    ctx.fillStyle = "#2c2c2e";
    ctx.fill();
    var width = Math.max(8, Math.min(140, (boot / 90) * 140));
    rr(ctx, 125, 560, width, 4, 2);
    ctx.fillStyle = "#f5f5f7";
    ctx.fill();
  }

  function paintLock(ctx, d) {
    wall(ctx);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    font(ctx, 18, 500);
    ctx.fillText(DAYS[d.getDay()] + ", " + MONS[d.getMonth()] + " " + d.getDate(), 195, 168);
    font(ctx, 92, 200);
    ctx.fillText(hm(d), 195, 268);
    font(ctx, 15, 500);
    ctx.fillStyle = "rgba(255,255,255,.82)";
    ctx.fillText("Swipe up to open", 195, 760);
    indicator(ctx, "#fff");
  }

  function paintHome(ctx, d) {
    var i;
    wall(ctx);
    status(ctx, "#fff", d);
    rr(ctx, 20, 74, 170, 156, 22);
    ctx.fillStyle = "rgba(12, 28, 22, .72)";
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 13, 600);
    ctx.textAlign = "left";
    ctx.fillText("Maps", 34, 98);
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(40, 180);
    ctx.lineTo(100, 140);
    ctx.lineTo(160, 168);
    ctx.stroke();
    ctx.fillStyle = "#ff453a";
    ctx.beginPath();
    ctx.arc(112, 150, 7, 0, 6.3);
    ctx.fill();
    ctx.save();
    rr(ctx, 200, 74, 170, 156, 22);
    ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fillRect(200, 74, 170, 156);
    ctx.fillStyle = "#ff3b30";
    ctx.fillRect(200, 74, 170, 36);
    ctx.fillStyle = "#fff";
    font(ctx, 12, 700);
    ctx.textAlign = "center";
    ctx.fillText(DAYS[d.getDay()].toUpperCase(), 285, 97);
    ctx.fillStyle = "#1c1c1e";
    font(ctx, 54, 300);
    ctx.fillText(String(d.getDate()), 285, 168);
    font(ctx, 13, 500);
    ctx.fillText(MONS[d.getMonth()], 285, 198);
    ctx.restore();
    for (i = 0; i < GRID.length; i += 1) {
      icon(ctx, GRID[i], 22 + (i % 4) * 92, 250 + Math.floor(i / 4) * 96, 62, true);
    }
    rr(ctx, 14, 734, 362, 96, 32);
    ctx.fillStyle = "rgba(255,255,255,.16)";
    ctx.fill();
    for (i = 0; i < DOCK.length; i += 1) icon(ctx, DOCK[i], 36 + i * 86, 748, 62, false);
    indicator(ctx, "#fff");
  }

  function paintSettings(ctx, s, d) {
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#fff", d);
    back(ctx, "#0a84ff");
    title(ctx, "#fff", "Settings");
    ctx.fillStyle = "rgba(255,255,255,.08)";
    rr(ctx, 20, 168, 350, 52, 14);
    ctx.fill();
    rr(ctx, 20, 220, 350, 52, 14);
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 16, 500);
    ctx.textAlign = "left";
    ctx.fillText("Wi-Fi", 36, 200);
    ctx.fillText("Bluetooth", 36, 252);
    ctx.fillStyle = "rgba(255,255,255,.55)";
    font(ctx, 14, 400);
    ctx.textAlign = "right";
    ctx.fillText(s.wifi ? "On" : "Off", 286, 200);
    ctx.fillText(s.bt ? "On" : "Off", 286, 252);
    toggle(ctx, 304, 179, s.wifi);
    toggle(ctx, 304, 231, s.bt);
    rr(ctx, 20, 308, 350, 54, 14);
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 13, 500);
    ctx.textAlign = "left";
    ctx.fillText("Brightness", 36, 328);
    var knob = Math.max(36, Math.min(340, s.bright));
    rr(ctx, 36, 342, 304, 8, 4);
    ctx.fillStyle = "#3a3a3c";
    ctx.fill();
    rr(ctx, 36, 342, Math.max(8, knob - 36), 8, 4);
    ctx.fillStyle = "#ffd60a";
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(knob, 346, 11, 0, 6.3);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 372, 390, 430);
    ctx.clip();
    ctx.translate(0, -(s.scroll | 0));
    var rows = ["Display", "Sound", "Focus", "General"];
    var n;
    for (n = 0; n < rows.length; n += 1) {
      var y = 390 + n * 62;
      rr(ctx, 20, y, 350, 52, 14);
      ctx.fillStyle = "rgba(255,255,255,.08)";
      ctx.fill();
      ctx.fillStyle = "#fff";
      font(ctx, 16, 500);
      ctx.textAlign = "left";
      ctx.fillText(rows[n], 36, y + 32);
    }
    ctx.restore();
    indicator(ctx, "#fff");
  }

  function paintSafari(ctx, d) {
    ctx.fillStyle = "#f5f5f7";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#000", d);
    back(ctx, "#0a84ff");
    title(ctx, "#000", "Safari");
    rr(ctx, 16, 112, 358, 36, 12);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.fillStyle = "#8e8e93";
    font(ctx, 13, 500);
    ctx.textAlign = "center";
    ctx.fillText("pygu.local", 195, 135);
    ctx.fillStyle = "#1c1c1e";
    font(ctx, 28, 700);
    ctx.textAlign = "left";
    ctx.fillText("Morning edition", 24, 190);
    rr(ctx, 24, 210, 342, 150, 16);
    var sky = ctx.createLinearGradient(24, 210, 24, 360);
    sky.addColorStop(0, "#7eb6e0");
    sky.addColorStop(1, "#f3d7b0");
    ctx.fillStyle = sky;
    ctx.fill();
    ctx.fillStyle = "#1c1c1e";
    font(ctx, 15, 400);
    ctx.fillText("Light moves across the water", 24, 400);
    ctx.fillText("before the street is awake.", 24, 424);
    ctx.fillText("A quiet page, already here.", 24, 448);
    indicator(ctx, "#000");
  }

  function paintMaps(ctx, s, d) {
    var ox = ((s.mapX % 72) + 72) % 72;
    var oy = ((s.mapY % 72) + 72) % 72;
    ctx.fillStyle = "#d7e7d3";
    ctx.fillRect(0, 0, 390, 844);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 108, 390, 716);
    ctx.clip();
    ctx.fillStyle = "#b7d7c3";
    ctx.fillRect(40 + ox, 180 + oy, 120, 90);
    ctx.fillStyle = "#9ec5e8";
    ctx.fillRect(220 - ox, 420 - oy, 180, 70);
    ctx.strokeStyle = "#f7f4ea";
    ctx.lineWidth = 10;
    var x, y;
    for (x = ox - 72; x < 420; x += 72) {
      ctx.beginPath();
      ctx.moveTo(x, 100);
      ctx.lineTo(x, 844);
      ctx.stroke();
    }
    for (y = oy + 80; y < 860; y += 72) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(390, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 390, 108);
    status(ctx, "#000", d);
    back(ctx, "#0a84ff");
    title(ctx, "#000", "Maps");
    ctx.fillStyle = "#ff3b30";
    ctx.beginPath();
    ctx.arc(195, 430, 9, 0, 6.3);
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 12, 600);
    ctx.textAlign = "center";
    ctx.fillText("Drag to move", 195, 470);
    indicator(ctx, "#000");
  }

  function paintNotes(ctx, s, d) {
    ctx.fillStyle = "#fffdf6";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#000", d);
    back(ctx, "#0a84ff");
    title(ctx, "#000", "Notes");
    ctx.strokeStyle = "rgba(90, 140, 200, .35)";
    ctx.lineWidth = 1;
    var y;
    for (y = 160; y < 520; y += 28) {
      ctx.beginPath();
      ctx.moveTo(20, y);
      ctx.lineTo(370, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#1c1c1e";
    font(ctx, 18, 400);
    ctx.textAlign = "left";
    var text = s.note || "";
    var line = "";
    var yy = 184;
    var i;
    for (i = 0; i < text.length; i += 1) {
      line += text[i] === " " ? " " : text[i];
      if (line.length >= 26 || text[i] === "\n") {
        ctx.fillText(line, 24, yy);
        line = "";
        yy += 28;
      }
    }
    ctx.fillText(line + "|", 24, yy);
    paintKeys(ctx);
    indicator(ctx, "#fff");
  }

  function paintPhotos(ctx, d) {
    var tones = [["#1d4e89", "#e7c59a"], ["#1b4332", "#95d5b2"], ["#6a2c3e", "#f1c0c8"], ["#16324f", "#8ecae6"], ["#5c4a32", "#ead7b0"], ["#22223b", "#9a8c98"]];
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#fff", d);
    back(ctx, "#0a84ff");
    title(ctx, "#fff", "Photos");
    var i;
    for (i = 0; i < 6; i += 1) {
      var x = 16 + (i % 3) * 122;
      var y = 130 + Math.floor(i / 3) * 150;
      var g = ctx.createLinearGradient(x, y, x + 112, y + 136);
      g.addColorStop(0, tones[i][0]);
      g.addColorStop(1, tones[i][1]);
      rr(ctx, x, y, 112, 136, 12);
      ctx.fillStyle = g;
      ctx.fill();
    }
    indicator(ctx, "#fff");
  }

  function paintCalendar(ctx, d) {
    ctx.fillStyle = "#f2f2f7";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#000", d);
    back(ctx, "#0a84ff");
    title(ctx, "#000", MONS[d.getMonth()]);
    var labels = ["S", "M", "T", "W", "T", "F", "S"];
    var first = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
    var count = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    var colW = 48;
    var left = 27;
    var c, day, index, col, row, cx, cy;
    font(ctx, 12, 600);
    ctx.textAlign = "center";
    for (c = 0; c < 7; c += 1) {
      ctx.fillStyle = "#8e8e93";
      ctx.fillText(labels[c], left + c * colW + 16, 150);
    }
    for (day = 1; day <= count; day += 1) {
      index = first + day - 1;
      col = index % 7;
      row = Math.floor(index / 7);
      cx = left + col * colW + 16;
      cy = 190 + row * 48;
      if (day === d.getDate()) {
        ctx.beginPath();
        ctx.fillStyle = "#ff3b30";
        ctx.arc(cx, cy - 5, 16, 0, 6.3);
        ctx.fill();
        ctx.fillStyle = "#fff";
      } else ctx.fillStyle = "#1c1c1e";
      font(ctx, 16, 500);
      ctx.fillText(String(day), cx, cy);
    }
    indicator(ctx, "#000");
  }

  function paintWeather(ctx, d) {
    var g = ctx.createLinearGradient(0, 0, 0, 844);
    g.addColorStop(0, "#4da3ff");
    g.addColorStop(1, "#0b2545");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#fff", d);
    back(ctx, "#fff");
    title(ctx, "#fff", "Weather");
    ctx.fillStyle = "#ffd60a";
    ctx.beginPath();
    ctx.arc(120, 230, 36, 0, 6.3);
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 76, 200);
    ctx.textAlign = "left";
    ctx.fillText("24°", 24, 360);
    font(ctx, 22, 500);
    ctx.fillText("Clear", 28, 400);
    var hours = [d.getHours(), (d.getHours() + 1) % 24, (d.getHours() + 2) % 24, (d.getHours() + 3) % 24];
    var n;
    for (n = 0; n < hours.length; n += 1) {
      var x = 28 + n * 90;
      ctx.fillStyle = "rgba(255,255,255,.16)";
      rr(ctx, x, 460, 78, 92, 16);
      ctx.fill();
      ctx.fillStyle = "#fff";
      font(ctx, 13, 600);
      ctx.textAlign = "center";
      ctx.fillText(hours[n] + ":00", x + 39, 496);
      ctx.fillText((22 + n) + "°", x + 39, 526);
    }
    indicator(ctx, "#fff");
  }

  function paintClock(ctx, d) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#fff", d);
    back(ctx, "#0a84ff");
    title(ctx, "#fff", "Clock");
    var sec = d.getSeconds() + d.getMilliseconds() / 1000;
    var minute = d.getMinutes() + sec / 60;
    var hour = (d.getHours() % 12) + minute / 60;
    ctx.save();
    ctx.translate(195, 390);
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, 6.3);
    ctx.fillStyle = "#1c1c1e";
    ctx.fill();
    ctx.strokeStyle = "#f5f5f7";
    ctx.lineWidth = 2;
    var tick;
    for (tick = 0; tick < 12; tick += 1) {
      ctx.rotate(Math.PI / 6);
      ctx.beginPath();
      ctx.moveTo(0, -100);
      ctx.lineTo(0, -112);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.translate(195, 390);
    ctx.strokeStyle = "#f5f5f7";
    ctx.lineCap = "round";
    ctx.lineWidth = 6;
    ctx.rotate(hour * Math.PI / 6);
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(0, -58);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(195, 390);
    ctx.strokeStyle = "#f5f5f7";
    ctx.lineCap = "round";
    ctx.lineWidth = 4;
    ctx.rotate(minute * Math.PI / 30);
    ctx.beginPath();
    ctx.moveTo(0, 16);
    ctx.lineTo(0, -86);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(195, 390);
    ctx.strokeStyle = "#ff9f0a";
    ctx.lineWidth = 2;
    ctx.rotate(sec * Math.PI / 30);
    ctx.beginPath();
    ctx.moveTo(0, 20);
    ctx.lineTo(0, -96);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#fff";
    font(ctx, 28, 300);
    ctx.textAlign = "center";
    ctx.fillText(hm(d), 195, 560);
    indicator(ctx, "#fff");
  }

  function paintControl(ctx, s, d) {
    wall(ctx);
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(0, 0, 390, 844);
    status(ctx, "#fff", d);
    rr(ctx, 24, 168, 160, 86, 22);
    ctx.fillStyle = s.wifi ? "rgba(10,132,255,.9)" : "rgba(255,255,255,.16)";
    ctx.fill();
    rr(ctx, 206, 168, 160, 86, 22);
    ctx.fillStyle = s.bt ? "rgba(10,132,255,.9)" : "rgba(255,255,255,.16)";
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 16, 650);
    ctx.textAlign = "left";
    ctx.fillText("Wi-Fi", 40, 206);
    ctx.fillText("Bluetooth", 222, 206);
    font(ctx, 12, 500);
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.fillText(s.wifi ? "On" : "Off", 40, 230);
    ctx.fillText(s.bt ? "On" : "Off", 222, 230);
    rr(ctx, 24, 308, 342, 54, 16);
    ctx.fillStyle = "rgba(255,255,255,.14)";
    ctx.fill();
    var knob = Math.max(40, Math.min(340, s.bright));
    rr(ctx, 40, 330, Math.max(10, knob - 40), 10, 5);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.fillStyle = "#fff";
    font(ctx, 13, 500);
    ctx.textAlign = "center";
    ctx.fillText("Swipe up to close", 195, 760);
    indicator(ctx, "#fff");
  }

  function paintSwitcher(ctx, s) {
    ctx.fillStyle = "#0c0c0e";
    ctx.fillRect(0, 0, 390, 844);
    rr(ctx, 70, 250, 250, 280, 28);
    ctx.fillStyle = "#1c1c1e";
    ctx.fill();
    var id = s.open || 0;
    if (id >= 1 && id <= 8) {
      icon(ctx, id, 164, 300, 62, false);
      ctx.fillStyle = "#fff";
      font(ctx, 18, 600);
      ctx.textAlign = "center";
      ctx.fillText(NAMES[id], 195, 400);
      font(ctx, 13, 400);
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.fillText("Tap to reopen", 195, 470);
    } else {
      ctx.fillStyle = "#fff";
      font(ctx, 18, 600);
      ctx.textAlign = "center";
      ctx.fillText("Nothing open", 195, 390);
    }
    indicator(ctx, "#fff");
  }

  function paintMenu(ctx) {
    rr(ctx, 8, 48, 176, 248, 22);
    ctx.fillStyle = "rgba(22,22,24,.9)";
    ctx.fill();
    var items = [[52, "Home"], [100, "Lock"], [148, "Restart"], [196, "Apps"], [244, "Control"]];
    var i;
    ctx.textAlign = "left";
    for (i = 0; i < items.length; i += 1) {
      ctx.fillStyle = "#fff";
      font(ctx, 16, 600);
      ctx.fillText(items[i][1], 28, items[i][0] + 28);
    }
  }

  function paintRail(ctx) {
    rr(ctx, 8, 8, 78, 36, 18);
    ctx.fillStyle = "rgba(255,255,255,.2)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillRect(24, 24, 16, 2);
    ctx.fillRect(44, 24, 16, 2);
    ctx.fillRect(64, 24, 8, 2);
  }

  function paintFace(ctx, s, now, ripples) {
    var d = new Date(now);
    if (s.screen === 0) {
      paintBoot(ctx, s.boot);
      return;
    }
    if (s.screen === 1) paintLock(ctx, d);
    else if (s.screen === 2) paintHome(ctx, d);
    else if (s.screen === 4) paintControl(ctx, s, d);
    else if (s.screen === 5) paintSwitcher(ctx, s);
    else if (s.app === 1) paintSettings(ctx, s, d);
    else if (s.app === 2) paintSafari(ctx, d);
    else if (s.app === 3) paintMaps(ctx, s, d);
    else if (s.app === 4) paintNotes(ctx, s, d);
    else if (s.app === 5) paintPhotos(ctx, d);
    else if (s.app === 6) paintCalendar(ctx, d);
    else if (s.app === 7) paintWeather(ctx, d);
    else if (s.app === 8) paintClock(ctx, d);
    else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 390, 844);
      status(ctx, "#fff", d);
      back(ctx, "#0a84ff");
      title(ctx, "#fff", "Home");
      indicator(ctx, "#fff");
    }
    if (s.screen !== 0) paintRail(ctx);
    if (s.menu) paintMenu(ctx);
    var level = Math.max(36, Math.min(390, s.bright || 280)) / 390;
    ctx.fillStyle = "rgba(0,0,0," + ((1 - level) * 0.62).toFixed(3) + ")";
    ctx.fillRect(0, 0, 390, 844);
    var i;
    for (i = ripples.length - 1; i >= 0; i -= 1) {
      var age = (now - ripples[i].t) / 460;
      if (age >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      var rad = 16 + age * 40;
      var glow = ctx.createRadialGradient(ripples[i].x, ripples[i].y, 0, ripples[i].x, ripples[i].y, rad);
      glow.addColorStop(0, "rgba(255,255,255," + (0.95 * (1 - age)).toFixed(3) + ")");
      glow.addColorStop(0.35, "rgba(255,255,255," + (0.4 * (1 - age)).toFixed(3) + ")");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ripples[i].x, ripples[i].y, rad, 0, 6.3);
      ctx.fill();
    }
  }

  function start(canvas) {
    var machine = new Machine();
    load(machine);
    var dead = false;
    var hold = false;
    var typing = false;
    var ax = 0;
    var ay = 0;
    var px = 0;
    var py = 0;
    var slideX = 0;
    var slideY = 0;
    var queued = null;
    var ripples = [];
    var raf = 0;

    function local(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      var scale = Math.min(rect.width / 390, rect.height / 844);
      if (scale <= 0) return null;
      var left = rect.left + (rect.width - 390 * scale) / 2;
      var top = rect.top + (rect.height - 844 * scale) / 2;
      var x = (clientX - left) / scale;
      var y = (clientY - top) / scale;
      if (x < 0 || y < 0 || x >= 390 || y >= 844) return null;
      return { x: x, y: y };
    }

    function down(event) {
      if (event.cancelable) event.preventDefault();
      var point = local(event.clientX, event.clientY);
      if (!point) return;
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
      ripples.push({ x: point.x, y: point.y, t: performance.now() });
      var state = readState(machine);
      var code = state.screen === 3 && state.app === 4 ? keyCode(point.x, point.y) : 0;
      if (code) {
        typing = true;
        hold = false;
        queued = { phase: 0, x: point.x | 0, y: point.y | 0, dx: 0, dy: 0, key: code };
        return;
      }
      typing = false;
      hold = true;
      ax = px = point.x;
      ay = py = point.y;
      slideX = 0;
      slideY = 0;
      queued = { phase: 1, x: point.x | 0, y: point.y | 0, dx: 0, dy: 0, key: 0 };
    }

    function move(event) {
      if (!hold) return;
      if (event.cancelable) event.preventDefault();
      var point = local(event.clientX, event.clientY);
      if (!point) return;
      slideX += point.x - px;
      slideY += point.y - py;
      px = point.x;
      py = point.y;
      queued = { phase: 1, x: point.x | 0, y: point.y | 0, dx: slideX | 0, dy: slideY | 0, key: 0 };
    }

    function up(event) {
      if (event && event.cancelable) event.preventDefault();
      if (typing) {
        typing = false;
        return;
      }
      if (!hold) return;
      hold = false;
      queued = { phase: 2, x: px | 0, y: py | 0, dx: slideX | 0, dy: slideY | 0, key: 0 };
      slideX = 0;
      slideY = 0;
    }

    function tick(now) {
      if (dead) return;
      if (queued) {
        machine.w32(STATE + PHASE, queued.phase);
        machine.w32(STATE + X, queued.x);
        machine.w32(STATE + Y, queued.y);
        machine.w32(STATE + X0, ax | 0);
        machine.w32(STATE + Y0, ay | 0);
        machine.w32(STATE + DX, queued.dx);
        machine.w32(STATE + DY, queued.dy);
        if (queued.key) machine.w32(STATE + KEY, queued.key);
        if (queued.phase === 1) {
          slideX = 0;
          slideY = 0;
        }
        queued = null;
      } else {
        machine.w32(STATE + PHASE, 0);
        machine.w32(STATE + DX, 0);
        machine.w32(STATE + DY, 0);
      }
      machine.frame();
      machine.w32(STATE + PHASE, 0);
      machine.w32(STATE + DX, 0);
      machine.w32(STATE + DY, 0);
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(3, window.devicePixelRatio || 1);
      var pw = Math.max(1, Math.round(rect.width * dpr));
      var ph = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      var ctx = canvas.getContext("2d");
      var scale = Math.min(pw / 390, ph / 844);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, pw, ph);
      ctx.setTransform(scale, 0, 0, scale, (pw - 390 * scale) / 2, (ph - 844 * scale) / 2);
      paintFace(ctx, readState(machine), now, ripples);
      raf = requestAnimationFrame(tick);
    }

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    raf = requestAnimationFrame(tick);
    return function () {
      dead = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }

  root.Pygu = { start: start };
  root.__pyguCore = { Machine: Machine, load: load, readState: readState, selfTest: selfTest, start: start, STATE: STATE };
  if (typeof module !== "undefined" && module.exports) module.exports = root.__pyguCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
