(function (root) {
  "use strict";

  var MARKS = {
    display: "CFBundleDisplayName",
    name: "CFBundleName",
    id: "CFBundleIdentifier",
    version: "CFBundleShortVersionString",
    executable: "CFBundleExecutable",
    system: "MinimumOSVersion"
  };

  function text(bytes) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  function readInt(bytes, off, size) {
    var n = 0;
    var i;
    for (i = 0; i < size; i += 1) n = n * 256 + bytes[off + i];
    return n;
  }

  function bplist(bytes) {
    if (bytes.length < 40 || text(bytes.subarray(0, 8)) !== "bplist00") return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var tail = bytes.length - 32;
    var offsetSize = bytes[tail + 6];
    var refSize = bytes[tail + 7];
    var count = Number(view.getBigUint64(tail + 8));
    var top = Number(view.getBigUint64(tail + 16));
    var table = Number(view.getBigUint64(tail + 24));
    var cache = new Array(count);

    function at(index) {
      if (cache[index] !== undefined) return cache[index];
      cache[index] = null;
      var off = readInt(bytes, table + index * offsetSize, offsetSize);
      var marker = bytes[off];
      var type = marker >> 4;
      var info = marker & 15;
      var value = null;
      if (type === 0) value = info === 8 ? false : info === 9 ? true : null;
      else if (type === 1) value = readInt(bytes, off + 1, 1 << info);
      else {
        var p = off + 1;
        var size = info;
        if (info === 15) {
          var extra = 1 << (bytes[p] & 15);
          p += 1;
          size = readInt(bytes, p, extra);
          p += extra;
        }
        if (type === 5) value = text(bytes.subarray(p, p + size));
        else if (type === 6) {
          var chars = "";
          var n;
          for (n = 0; n < size; n += 1) chars += String.fromCharCode(view.getUint16(p + n * 2));
          value = chars;
        } else if (type === 10 || type === 13) {
          var refs = [];
          var r;
          for (r = 0; r < size; r += 1) refs.push(readInt(bytes, p + r * refSize, refSize));
          if (type === 10) {
            value = refs.map(at);
          } else {
            var dict = {};
            var base = p + size * refSize;
            for (r = 0; r < size; r += 1) dict[at(refs[r])] = at(readInt(bytes, base + r * refSize, refSize));
            value = dict;
          }
        }
      }
      cache[index] = value;
      return value;
    }

    var parsed = at(top);
    return parsed && typeof parsed === "object" ? parsed : null;
  }

  function xmlPlist(raw) {
    var body = text(raw);
    if (body.indexOf("<plist") === -1) return null;
    var out = {};
    var pattern = /<key>([^<]+)<\/key>\s*<(string|integer|real)>([^<]*)<\/\2>|<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/g;
    var match;
    while ((match = pattern.exec(body))) {
      if (match[1]) {
        var value = match[3].split("&" + "lt;").join("<").split("&" + "gt;").join(">").split("&" + "amp;").join("&");
        out[match[1]] = match[2] === "string" ? value : Number(value);
      } else out[match[4]] = match[5] === "true";
    }
    return out;
  }

  function plist(bytes) {
    return bplist(bytes) || xmlPlist(bytes) || {};
  }

  async function inflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer, want) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var end = -1;
    var from = Math.max(0, bytes.length - 22 - 65535);
    var i;
    for (i = bytes.length - 22; i >= from; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("This file is not an IPA archive.");
    var count = view.getUint16(end + 10, true);
    var ptr = view.getUint32(end + 16, true);
    var found = [];
    for (i = 0; i < count; i += 1) {
      if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("The archive directory is unreadable.");
      var method = view.getUint16(ptr + 10, true);
      var compSize = view.getUint32(ptr + 20, true);
      var nameLen = view.getUint16(ptr + 28, true);
      var extraLen = view.getUint16(ptr + 30, true);
      var commentLen = view.getUint16(ptr + 32, true);
      var local = view.getUint32(ptr + 42, true);
      var name = text(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;
      if (!want(name)) continue;
      var dataOff = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      var packed = bytes.subarray(dataOff, dataOff + compSize);
      if (method === 0) found.push({ name: name, data: packed });
      else if (method === 8) found.push({ name: name, data: await inflate(packed) });
      else throw new Error("Unsupported compression in " + name);
    }
    return found;
  }

  function cstring(bytes, start, end) {
    var out = "";
    var i;
    for (i = start; i < end && bytes[i]; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function macho(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var big = view.getUint32(0, false);
    if (big === 0xcafebabe) {
      var arches = view.getUint32(4, false);
      var slice = 0;
      var n;
      for (n = 0; n < arches; n += 1) {
        var at = 8 + n * 20;
        if (view.getUint32(at, false) === 0x0100000c) slice = view.getUint32(at + 8, false);
      }
      if (!slice) slice = view.getUint32(16, false);
      return macho(bytes.subarray(slice));
    }
    var le = view.getUint32(0, true) === 0xfeedfacf;
    if (!le && view.getUint32(0, true) !== 0xcffaedfe) return null;
    var read = function (off) { return view.getUint32(off, le); };
    var filetype = read(12);
    var commands = read(16);
    var cryptid = 0;
    var libs = [];
    var entry = false;
    var imports = [];
    var p = 32;
    var c;
    for (c = 0; c < commands; c += 1) {
      var cmd = read(p);
      var size = read(p + 4);
      if (size < 8 || p + size > bytes.length) break;
      if ((cmd === 0x21 || cmd === 0x2c) && size >= 20) cryptid = read(p + 16);
      if (cmd === 0x80000028) entry = true;
      if (cmd === 0xc || cmd === 0x80000018) {
        var nameAt = p + read(p + 8);
        if (nameAt < p + size) libs.push(cstring(bytes, nameAt, p + size).split("/").pop());
      }
      if (cmd === 0x2 && size >= 24) {
        var symoff = read(p + 8);
        var nsyms = read(p + 12);
        var stroff = read(p + 16);
        var strsize = read(p + 20);
        var limit = Math.min(nsyms, 8000);
        var s;
        for (s = 0; s < limit; s += 1) {
          var ent = symoff + s * 16;
          if (ent + 16 > bytes.length) break;
          var strx = view.getUint32(ent, true);
          var ntype = bytes[ent + 4];
          if ((ntype & 0x0e) !== 0) continue;
          if (stroff + strx >= bytes.length || stroff + strx >= stroff + strsize) continue;
          var sym = cstring(bytes, stroff + strx, Math.min(bytes.length, stroff + strsize));
          if (sym.charAt(0) === "_") sym = sym.slice(1);
          if (sym) imports.push(sym);
        }
      }
      p += size;
    }
    var kind = filetype === 2 ? "MH_EXECUTE" : filetype === 6 ? "MH_DYLIB" : filetype === 8 ? "MH_BUNDLE" : "MH_" + filetype;
    return { filetype: kind, cryptid: cryptid, libraries: libs, entry: entry, imports: imports, cpu: "ARM64" };
  }

  function iconOf(files) {
    var best = null;
    files.forEach(function (file) {
      if (!/\.png$/i.test(file.name) || /Assets\.car/i.test(file.name)) return;
      if (!/icon/i.test(file.name)) return;
      if (!best || file.data.length > best.data.length) best = file;
    });
    if (!best || best.data.length > 1500000 || typeof btoa !== "function") return "";
    var raw = "";
    var i;
    var chunk = 0x8000;
    for (i = 0; i < best.data.length; i += chunk) {
      raw += String.fromCharCode.apply(null, best.data.subarray(i, i + chunk));
    }
    return "data:image/png;base64," + btoa(raw);
  }

  function thin(bytes) {
    if (bytes.length < 32) return bytes;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) !== 0xcafebabe) return bytes;
    var arches = view.getUint32(4, false);
    var slice = 0;
    var n;
    for (n = 0; n < arches; n += 1) {
      var at = 8 + n * 20;
      if (view.getUint32(at, false) === 0x0100000c) slice = view.getUint32(at + 8, false);
    }
    if (!slice) slice = view.getUint32(16, false);
    return bytes.subarray(slice);
  }

  function Memory(segs) {
    this.segs = segs;
  }
  Memory.prototype.seg = function (va) {
    var i;
    for (i = 0; i < this.segs.length; i += 1) {
      var s = this.segs[i];
      if (va >= s.vmaddr && va < s.vmaddr + s.buf.length) return s;
    }
    return null;
  };
  Memory.prototype.u8 = function (va) {
    var s = this.seg(va);
    return s ? s.buf[va - s.vmaddr] : 0;
  };
  Memory.prototype.u32 = function (va) {
    var s = this.seg(va);
    if (!s) return 0;
    var off = va - s.vmaddr;
    if (off + 4 > s.buf.length) return 0;
    return new DataView(s.buf.buffer, s.buf.byteOffset, s.buf.byteLength).getUint32(off, true);
  };
  Memory.prototype.u64 = function (va) {
    var s = this.seg(va);
    if (!s) return 0;
    var off = va - s.vmaddr;
    if (off + 8 > s.buf.length) return 0;
    return Number(new DataView(s.buf.buffer, s.buf.byteOffset, s.buf.byteLength).getBigUint64(off, true));
  };
  Memory.prototype.u64b = function (va) {
    var s = this.seg(va);
    if (!s) return 0n;
    var off = va - s.vmaddr;
    if (off + 8 > s.buf.length) return 0n;
    return new DataView(s.buf.buffer, s.buf.byteOffset, s.buf.byteLength).getBigUint64(off, true);
  };
  Memory.prototype.w64 = function (va, value) {
    var s = this.seg(va);
    if (!s) return;
    var off = va - s.vmaddr;
    if (off + 8 > s.buf.length) return;
    new DataView(s.buf.buffer, s.buf.byteOffset, s.buf.byteLength).setBigUint64(off, BigInt(value), true);
  };
  Memory.prototype.w32 = function (va, value) {
    var s = this.seg(va);
    if (!s) return;
    var off = va - s.vmaddr;
    if (off + 4 > s.buf.length) return;
    new DataView(s.buf.buffer, s.buf.byteOffset, s.buf.byteLength).setUint32(off, value >>> 0, true);
  };
  Memory.prototype.w8 = function (va, value, len) {
    var s = this.seg(va);
    if (!s) return;
    var i;
    var room = s.buf.length - (va - s.vmaddr);
    var n = Math.min(len, room);
    for (i = 0; i < n; i += 1) s.buf[va - s.vmaddr + i] = value & 255;
  };
  Memory.prototype.copy = function (dst, src, len) {
    var i;
    for (i = 0; i < len; i += 1) this.w8(dst + i, this.u8(src + i), 1);
  };
  Memory.prototype.str = function (va) {
    var out = "";
    var i;
    for (i = 0; i < 240; i += 1) {
      var c = this.u8(va + i);
      if (!c) break;
      if (c < 32 || c > 126) return out;
      out += String.fromCharCode(c);
    }
    return out;
  };

  function bit(value, shift, width) {
    return Number((BigInt(value) >> BigInt(shift)) & ((1n << BigInt(width)) - 1n));
  }

  function sex(value, bits) {
    var sign = 1 << (bits - 1);
    return ((value & ((1 << bits) - 1)) ^ sign) - sign;
  }

  function loadImage(bytes) {
    bytes = thin(bytes);
    if (bytes.length < 32) return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var le = view.getUint32(0, true) === 0xfeedfacf;
    if (!le && view.getUint32(0, true) !== 0xcffaedfe) return null;
    var u32 = function (off) { return view.getUint32(off, le); };
    var u64 = function (off) { return Number(view.getBigUint64(off, le)); };
    var commands = u32(16);
    var base = 0;
    var entry = 0;
    var segs = [];
    var fix = null;
    var p = 32;
    var c;
    for (c = 0; c < commands; c += 1) {
      var cmd = u32(p);
      var size = u32(p + 4);
      if (size < 8 || p + size > bytes.length) break;
      if (cmd === 0x19) {
        var vmaddr = u64(p + 24);
        var vmsize = u64(p + 32);
        var fileoff = u64(p + 40);
        var filesize = u64(p + 48);
        if (!base && fileoff === 0) base = vmaddr;
        var span = Math.min(vmsize, 48 * 1024 * 1024);
        var buf = new Uint8Array(span);
        var take = Math.min(filesize, span, Math.max(0, bytes.length - fileoff));
        if (take > 0) buf.set(bytes.subarray(fileoff, fileoff + take));
        var sects = [];
        var nsects = u32(p + 64);
        var sp = p + 72;
        var s;
        for (s = 0; s < nsects && sp + 80 <= p + size; s += 1) {
          sects.push({
            name: cstring(bytes, sp, sp + 16),
            addr: u64(sp + 32),
            size: u64(sp + 40)
          });
          sp += 80;
        }
        segs.push({ vmaddr: vmaddr, buf: buf, sects: sects });
      } else if (cmd === 0x80000028 && size >= 16) {
        entry = u64(p + 8);
      } else if (cmd === 0x80000034 && size >= 16) {
        fix = { off: u32(p + 8), size: u32(p + 12) };
      }
      p += size;
    }
    if (!base && segs.length) base = segs[0].vmaddr;
    segs.push({ vmaddr: 0x400000000, buf: new Uint8Array(1024 * 1024), sects: [] });
    var mem = new Memory(segs);
    var stubs = {};
    var names = {};
    var nextId = 0;
    function tag(name) {
      var key = name.charAt(0) === "_" ? name.slice(1) : name;
      if (names[key]) return names[key];
      nextId += 1;
      var addr = 0x200000000 + nextId * 16;
      names[key] = addr;
      stubs[addr] = key;
      return addr;
    }
    if (fix && fix.off + 28 < bytes.length) {
      var blob = fix.off;
      var starts = blob + view.getUint32(blob + 4, true);
      var imports = blob + view.getUint32(blob + 8, true);
      var symbols = blob + view.getUint32(blob + 12, true);
      var count = view.getUint32(blob + 16, true);
      var format = view.getUint32(blob + 20, true);
      var step = format === 2 ? 8 : 4;
      var table = [];
      var i;
      for (i = 0; i < count && i < 200000; i += 1) {
        var word = view.getUint32(imports + i * step, true);
        var nameOff = (word >>> 9) & 0x7fffff;
        table.push(cstring(bytes, symbols + nameOff, symbols + nameOff + 240));
      }
      var segCount = view.getUint32(starts, true);
      for (i = 0; i < segCount && i < 64; i += 1) {
        var infoOff = view.getUint32(starts + 4 + i * 4, true);
        if (!infoOff) continue;
        var info = starts + infoOff;
        var pageSize = view.getUint16(info + 4, true) || 0x1000;
        var pointer = view.getUint16(info + 6, true);
        var segOff = Number(view.getBigUint64(info + 8, true));
        var pages = view.getUint16(info + 20, true);
        var stride = pointer === 2 || pointer === 6 ? 4 : 8;
        var page;
        for (page = 0; page < pages; page += 1) {
          var start = view.getUint16(info + 22 + page * 2, true);
          if (start === 0xffff || start & 0x8000) continue;
          var va = base + segOff + page * pageSize + start;
          var guard = 0;
          while (guard < 200000) {
            guard += 1;
            var raw = mem.u64b(va);
            var bindBit;
            var next;
            var ordinal = 0;
            var target = 0n;
            if (pointer === 2 || pointer === 6) {
              bindBit = bit(raw, 63, 1);
              next = bit(raw, 51, 12);
              ordinal = bit(raw, 0, 24);
              target = BigInt(bit(raw, 0, 36));
            } else if (pointer === 12) {
              bindBit = bit(raw, 62, 1);
              next = bit(raw, 51, 11);
              ordinal = bit(raw, 0, 24);
              target = BigInt(bit(raw, 0, 32));
            } else {
              bindBit = bit(raw, 62, 1);
              next = bit(raw, 51, 11);
              ordinal = bit(raw, 0, 16);
              target = BigInt(bit(raw, 0, 43));
            }
            if (bindBit) mem.w64(va, tag(table[ordinal] || "import"));
            else mem.w64(va, Number((pointer === 6 || pointer === 9 || pointer === 12 ? BigInt(base) : 0n) + target));
            if (!next) break;
            va += next * stride;
          }
        }
      }
    }
    return { mem: mem, entry: base + entry, base: base, stubs: stubs, bytes: bytes };
  }

  function sex32(value) {
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }

  function classesOf(image) {
    var classes = {};
    var i;
    for (i = 0; i < image.mem.segs.length; i += 1) {
      var sects = image.mem.segs[i].sects;
      var s;
      for (s = 0; s < sects.length; s += 1) {
        if (sects[s].name !== "__objc_classlist") continue;
        var n = Math.min(400, Math.floor(sects[s].size / 8));
        var k;
        for (k = 0; k < n; k += 1) {
          var cls = image.mem.u64(sects[s].addr + k * 8);
          var data = image.mem.u64(cls + 32) & ~7;
          if (!data) continue;
          var name = image.mem.str(image.mem.u64(data + 24));
          var methods = image.mem.u64(data + 32);
          var imps = {};
          if (methods) {
            var entsize = image.mem.u32(methods);
            var count = Math.min(400, image.mem.u32(methods + 4));
            var relative = (entsize & 0x80000000) !== 0;
            var stride = entsize & 0x3ff;
            if (!stride) stride = relative ? 12 : 24;
            var m;
            for (m = 0; m < count; m += 1) {
              var mp = methods + 8 + m * (relative ? 12 : stride);
              var sel = "";
              var imp = 0;
              if (relative) {
                sel = image.mem.str(mp + sex32(image.mem.u32(mp)));
                imp = mp + 8 + sex32(image.mem.u32(mp + 8));
              } else {
                sel = image.mem.str(image.mem.u64(mp));
                imp = image.mem.u64(mp + 16);
              }
              if (sel && imp) imps[sel] = imp;
            }
          }
          if (name) classes[name] = { imps: imps };
        }
      }
    }
    return classes;
  }

  function fnv(text) {
    var h = 2166136261;
    var i;
    for (i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h;
  }

  function uuidFrom(seed) {
    var s = "";
    var h = fnv(seed);
    var i;
    for (i = 0; i < 4; i += 1) {
      h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
      s += h.toString(16).padStart(8, "0");
    }
    return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20, 32);
  }

  function personality(info) {
    var bundleId = info.bundleId || "unknown";
    var uuid = uuidFrom(bundleId + ":" + (info.execName || ""));
    var pid = 1000 + (fnv(bundleId) % 20000);
    var home = "/var/mobile/Containers/Data/Application/" + uuid;
    var bundlePath = "/var/containers/Bundle/Application/" + uuid + "/" + (info.bundle || "Guest.app");
    var execPath = bundlePath + "/" + (info.execName || "Guest");
    return {
      pid: pid,
      ppid: 1,
      uid: 501,
      gid: 501,
      tid: pid,
      pgid: pid,
      machTask: 0x207,
      host: "Pygu",
      device: "iPhone15,2",
      model: "D73AP",
      os: info.system || "17.5",
      osbuild: "21F79",
      home: home,
      tmp: home + "/tmp",
      bundlePath: bundlePath,
      execPath: execPath,
      bundleId: bundleId,
      display: info.name || "Guest",
      info: info.plist || {}
    };
  }
  function runImage(image, proc) {
    var mem = image.mem;
    var x = new Array(31);
    var i;
    for (i = 0; i < 31; i += 1) x[i] = 0;
    var sp = 0x180000000;
    var stack = new Uint8Array(2 * 1024 * 1024);
    var stackBase = sp - stack.length;
    var pc = image.entry;
    var z = 0;
    var n = 0;
    var cflag = 0;
    var vflag = 0;
    var trace = [];
    var views = [];
    var logs = [];
    var hitMain = false;
    var stop = "";
    var steps = 0;
    var objects = {};
    var objId = 0x300000000;
    var bump = 0x400000100;
    var redirect = 0;
    var classes = classesOf(image);
    if (!proc) proc = personality({ bundleId: "test.guest", execName: "Guest", bundle: "Guest.app", name: "Guest" });
    function put(obj) {
      objId += 16;
      objects[objId] = obj;
      return objId;
    }
    function onStack(addr) {
      return addr >= stackBase && addr < stackBase + stack.length;
    }
    function readStack(addr, size) {
      var off = addr - stackBase;
      if (off < 0 || off + size > stack.length) return 0;
      var value = 0;
      var k;
      for (k = size - 1; k >= 0; k -= 1) value = value * 256 + stack[off + k];
      return value;
    }
    function writeStack(addr, value, size) {
      var off = addr - stackBase;
      if (off < 0 || off + size > stack.length) return;
      var k;
      for (k = 0; k < size; k += 1) stack[off + k] = Number((BigInt(value) >> BigInt(k * 8)) & 255n);
    }
    function load(addr, size) {
      if (onStack(addr)) return readStack(addr, size);
      if (size === 8) return mem.u64(addr);
      if (size === 4) return mem.u32(addr);
      if (size === 1) return mem.u8(addr);
      return 0;
    }
    function store(addr, value, size) {
      if (onStack(addr)) {
        writeStack(addr, value, size);
        return;
      }
      if (size === 8) mem.w64(addr, value);
      else if (size === 4) mem.w32(addr, value);
      else if (size === 1) mem.w8(addr, value & 255, 1);
    }
    function reg(i) {
      if (i === 31) return sp;
      return x[i] || 0;
    }
    function wreg(i, value) {
      if (i === 31) sp = value;
      else x[i] = value;
    }
    function textOf(addr) {
      if (!addr) return "";
      var obj = objects[addr];
      if (obj && obj.text !== undefined && obj.kind !== "view") return obj.text;
      var direct = mem.str(addr);
      if (direct) return direct;
      var ptr = mem.u64(addr + 16);
      return ptr ? mem.str(ptr) : "";
    }
    function remember(name) {
      if (!name) return;
      if (trace[trace.length - 1] !== name) trace.push(name);
      if (trace.length > 24) trace.shift();
    }
    function cstr(value) {
      var addr = bump;
      var bytes = value + "\0";
      var n;
      bump += bytes.length + 16;
      for (n = 0; n < bytes.length; n += 1) mem.w8(addr + n, bytes.charCodeAt(n), 1);
      return addr;
    }
    function fresh(kind, className) {
      return put({ kind: kind || "view", text: "", className: className || "", children: [] });
    }
    function call(addr) {
      var name = image.stubs[addr];
      redirect = 0;
      if (!name) {
        stop = "Unmapped call at " + addr.toString(16);
        return 0;
      }
      remember(name);
      if (name === "UIApplicationMain") {
        hitMain = true;
        var delegateName = textOf(x[3]);
        var cls = classes[delegateName];
        var imp = cls && cls.imps["application:didFinishLaunchingWithOptions:"];
        var app = fresh("application", "UIApplication");
        fresh("window", "UIWindow");
        if (imp) {
          x[0] = fresh("object", delegateName);
          x[1] = cstr("application:didFinishLaunchingWithOptions:");
          x[2] = app;
          x[3] = 0;
          x[30] = 1;
          redirect = imp;
        } else redirect = 1;
        return 0;
      }
      if (name === "objc_msgSend" || name === "objc_msgSendSuper" || name === "objc_msgSendSuper2" || name === "objc_msgSend_stret") {
        var sel = mem.str(x[1]) || textOf(x[1]);
        remember(sel);
        var obj = objects[x[0]];
        if (sel === "setText:" || sel === "setTitle:" || sel === "setString:") {
          var value = textOf(x[2]);
          if (obj) obj.text = value;
          if (value) views.push({ kind: "label", text: value });
          logs.push(sel + " " + value);
          return x[0];
        }
        if (sel === "alloc" || sel === "new") return fresh("view", textOf(x[0]) || "Object");
        if (sel === "init" || sel === "autorelease" || sel === "retain") return x[0];
        if (sel === "addSubview:" && obj && x[2]) {
          if (objects[x[2]] && objects[x[2]].text) views.push({ kind: "label", text: objects[x[2]].text });
          return x[0];
        }
        if (sel === "class") return x[0];
        if (sel === "processInfo") {
          if (!proc.procObj) proc.procObj = put({ kind: "process", text: String(proc.pid), className: "NSProcessInfo" });
          return proc.procObj;
        }
        if (sel === "processIdentifier") return proc.pid;
        if (sel === "mainBundle") {
          if (!proc.bundleObj) proc.bundleObj = put({ kind: "bundle", text: proc.bundleId, className: "NSBundle" });
          return proc.bundleObj;
        }
        if (sel === "bundleIdentifier" || sel === "bundlePath" || sel === "executablePath" || sel === "hostName" || sel === "operatingSystemVersionString") {
          var answered = proc.bundleId;
          if (sel === "bundlePath") answered = proc.bundlePath;
          if (sel === "executablePath") answered = proc.execPath;
          if (sel === "hostName") answered = proc.host;
          if (sel === "operatingSystemVersionString") answered = "Version " + proc.os + " (Build " + proc.osbuild + ")";
          return put({ kind: "string", text: answered, className: "NSString" });
        }
        if (sel === "objectForInfoDictionaryKey:") {
          var infoVal = proc.info[textOf(x[2])];
          return infoVal ? put({ kind: "string", text: String(infoVal), className: "NSString" }) : 0;
        }
        if (sel === "UTF8String" && obj && obj.text) return cstr(obj.text);
        return x[0];
      }
      if (name === "objc_alloc" || name === "objc_alloc_init" || name === "objc_opt_new") return fresh("view", "Object");
      if (name === "NSLog" || name === "os_log" || name === "os_log_with_type" || name === "printf" || name === "puts") {
        var line = textOf(x[0]) || textOf(x[2]) || name;
        if (line) logs.push(line);
        return 0;
      }
      if (name === "memset" || name === "bzero" || name === "__bzero") {
        mem.w8(x[0], name === "memset" ? x[1] : 0, Math.min(x[2] || (name === "memset" ? 0 : x[1]) || 0, 65536));
        return x[0];
      }
      if (name === "memcpy" || name === "memmove" || name === "bcopy") {
        mem.copy(x[0], x[1], Math.min(x[2] || 0, 65536));
        return x[0];
      }
      if (name === "strlen") return textOf(x[0]).length;
      if (name === "strcmp" || name === "strncmp") return textOf(x[0]) === textOf(x[1]) ? 0 : 1;
      if (name === "malloc" || name === "calloc") {
        var size = name === "calloc" ? (x[0] || 1) * (x[1] || 1) : (x[0] || 16);
        var ptr = bump;
        size = Math.min(Math.max(size, 16), 65536);
        bump += (size + 15) & ~15;
        return ptr;
      }
      if (name === "realloc") return x[0] || call.malloc || bump;
      if (name === "free") return 0;
      if (name === "__error") return 0x400000000;
      if (name === "dispatch_once_f") {
        if (x[0] && mem.u64(x[0]) === 0) {
          mem.w64(x[0], 1);
          if (x[2]) {
            redirect = x[2];
            x[0] = x[1];
            x[30] = 1;
          }
        }
        return 0;
      }
      if (name.indexOf("objc_retain") === 0 || name.indexOf("objc_autorelease") === 0 || name === "objc_opt_self" || name === "objc_opt_class" || name === "objc_opt_respondsToSelector" || name === "objc_opt_isKindOfClass") return x[0] || 1;
      if (name.indexOf("objc_release") === 0 || name === "objc_storeStrong" || name === "objc_autoreleasePoolPush" || name === "objc_autoreleasePoolPop") return 0;
      if (name === "sel_registerName" || name === "sel_getName" || name === "sel_getUid") return x[0];
      if (name === "objc_getClass" || name === "objc_lookUpClass") {
        var found = textOf(x[0]);
        return found ? put({ kind: "class", text: found, className: found }) : 0;
      }
      if (name === "exit" || name === "_exit" || name === "abort") {
        stop = name === "abort" ? "The guest aborted." : "";
        redirect = 1;
        return 0;
      }
      if (name === "__stack_chk_fail") {
        stop = "Stack check failed";
        redirect = 1;
        return 0;
      }
      if (name === "dyld_stub_binder") {
        stop = "A lazy bind was not resolved";
        redirect = 1;
        return 0;
      }
      if (name === "getpid" || name === "pthread_mach_thread_np") return proc.pid;
      if (name === "getppid") return proc.ppid;
      if (name === "getuid" || name === "geteuid") return proc.uid;
      if (name === "getgid" || name === "getegid") return proc.gid;
      if (name === "getprogname") return cstr(proc.display);
      if (name === "mach_task_self_" || name === "mach_task_self" || name === "mach_host_self") return proc.machTask;
      if (name === "pthread_self" || name === "mach_thread_self") {
        if (!proc.thread) {
          proc.thread = bump;
          bump += 256;
        }
        return proc.thread;
      }
      if (name === "getenv") {
        var key = textOf(x[0]);
        return proc.env && proc.env[key] !== undefined ? cstr(proc.env[key]) : 0;
      }
      if (name === "_NSGetEnviron") return proc.envArr || 0;
      if (name === "_NSGetArgv") return proc.argvArr || 0;
      if (name === "_NSGetExecutablePath") {
        if (!x[0]) return -1;
        var path = proc.execPath;
        var nch;
        for (nch = 0; nch < path.length; nch += 1) mem.w8(x[0] + nch, path.charCodeAt(nch), 1);
        mem.w8(x[0] + path.length, 0, 1);
        return 0;
      }
      if (name === "sysctlbyname") {
        var asked = textOf(x[0]);
        var table = {
          "hw.machine": proc.device,
          "hw.model": proc.model,
          "hw.product": proc.device,
          "kern.osproductversion": proc.os,
          "kern.osversion": proc.osbuild,
          "kern.osrelease": "23.5.0",
          "kern.hostname": proc.host
        };
        var val = table[asked];
        if (!val) return -1;
        if (x[1]) {
          var si;
          for (si = 0; si < val.length; si += 1) mem.w8(x[1] + si, val.charCodeAt(si), 1);
          mem.w8(x[1] + val.length, 0, 1);
        }
        if (x[2]) mem.w64(x[2], val.length + 1);
        return 0;
      }
      stop = "The guest calls " + name + ". This host does not provide that call.";
      redirect = 1;
      return 0;
    }
    function cond(code) {
      if (code === 0) return z === 1;
      if (code === 1) return z === 0;
      if (code === 2) return cflag === 1;
      if (code === 3) return cflag === 0;
      if (code === 4) return n === 1;
      if (code === 5) return n === 0;
      if (code === 8) return cflag === 1 && z === 0;
      if (code === 9) return !(cflag === 1 && z === 0);
      if (code === 10) return n === vflag;
      if (code === 11) return n !== vflag;
      if (code === 12) return z === 0 && n === vflag;
      if (code === 13) return z === 1 || n !== vflag;
      return true;
    }
    function takeBranch(addr, link) {
      if (link) x[30] = pc + 4;
      if (image.stubs[addr]) {
        x[0] = call(addr);
        pc = redirect || (link ? pc + 4 : 1);
      } else pc = addr;
      redirect = 0;
    }
    var envPairs = {
      HOME: proc.home,
      TMPDIR: proc.tmp,
      CFFIXED_USER_HOME: proc.home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      USER: "mobile",
      LOGNAME: "mobile",
      SHELL: "/bin/sh"
    };
    var envPtrs = [];
    Object.keys(envPairs).forEach(function (key) { envPtrs.push(cstr(key + "=" + envPairs[key])); });
    var arg0 = cstr(proc.execPath);
    var argvArr = bump;
    mem.w64(argvArr, arg0);
    mem.w64(argvArr + 8, 0);
    bump += 32;
    var envArr = bump;
    envPtrs.forEach(function (ptr, index) { mem.w64(envArr + index * 8, ptr); });
    mem.w64(envArr + envPtrs.length * 8, 0);
    bump += (envPtrs.length + 2) * 8;
    var apple0 = cstr("executable_path=" + proc.execPath);
    var apple1 = cstr("pfz=0x0");
    var appleArr = bump;
    mem.w64(appleArr, apple0);
    mem.w64(appleArr + 8, apple1);
    mem.w64(appleArr + 16, 0);
    bump += 48;
    proc.env = envPairs;
    proc.envArr = envArr;
    proc.argvArr = argvArr;
    x[0] = 1;
    x[1] = argvArr;
    x[2] = envArr;
    x[3] = appleArr;
    var guard = 0;
    while (!stop && guard < 1500000) {
      guard += 1;
      if (pc === 1) break;
      if (image.stubs[pc]) {
        x[0] = call(pc);
        pc = redirect || x[30] || 1;
        redirect = 0;
        continue;
      }
      var word = mem.u32(pc);
      if (!word && !mem.seg(pc)) {
        stop = "Left the executable";
        break;
      }
      var is = function (mask, value) { return ((word & mask) >>> 0) === value; };
      var rd = word & 31;
      var rn = (word >>> 5) & 31;
      var next = pc + 4;
      if (is(0xfffff01f, 0xd503201f)) {
        pc = next;
        continue;
      }
      if (word === 0xd65f0bff || word === 0xd65f0fff || is(0xfffffc1f, 0xd65f0000)) {
        pc = word === 0xd65f0bff || word === 0xd65f0fff ? (x[30] || 1) : (rn === 31 ? 0 : reg(rn));
        continue;
      }
      if (is(0xfffffc1f, 0xd63f0000) || is(0xfffffc1f, 0xd63f0800)) {
        takeBranch(reg(rn), true);
        continue;
      }
      if (is(0xfffffc1f, 0xd61f0000) || is(0xfffffc1f, 0xd61f0800)) {
        takeBranch(reg(rn), false);
        continue;
      }
      if (is(0xfc000000, 0x94000000)) {
        takeBranch(pc + sex(word & 0x3ffffff, 26) * 4, true);
        continue;
      }
      if (is(0xfc000000, 0x14000000)) {
        pc = pc + sex(word & 0x3ffffff, 26) * 4;
        continue;
      }
      if (is(0xff000010, 0x54000000)) {
        pc = cond(word & 15) ? pc + sex((word >>> 5) & 0x7ffff, 19) * 4 : next;
        continue;
      }
      if (is(0x7f000000, 0x34000000)) {
        var compared = (word & 0x80000000) ? reg(rd) : (reg(rd) & 0xffffffff);
        var take = (word & 0x01000000) ? compared !== 0 : compared === 0;
        pc = take ? pc + sex((word >>> 5) & 0x7ffff, 19) * 4 : next;
        continue;
      }
      if (is(0x9f000000, 0x90000000) || is(0x9f000000, 0x10000000)) {
        var imm = (((word >>> 5) & 0x7ffff) << 2) | ((word >>> 29) & 3);
        imm = sex(imm, 21);
        var page = pc - (pc % 0x1000);
        wreg(rd, (word & 0x80000000) ? page + imm * 0x1000 : pc + imm);
        pc = next;
        continue;
      }
      if (is(0x1f800000, 0x11000000)) {
        var wide = (word & 0x80000000) !== 0;
        var imm12 = ((word >>> 10) & 0xfff) << (((word >>> 22) & 1) ? 12 : 0);
        var base = reg(rn);
        var added = ((word >>> 30) & 1) ? base - imm12 : base + imm12;
        wreg(rd, wide ? added : (added >>> 0));
        if ((word & 0x20000000) !== 0) {
          var flagged = wide ? added : (added & 0xffffffff);
          z = flagged === 0 ? 1 : 0;
          n = added < 0 ? 1 : 0;
          cflag = ((word >>> 30) & 1) ? (base >= imm12 ? 1 : 0) : 1;
          vflag = 0;
        }
        pc = next;
        continue;
      }
      if (is(0xff800000, 0xd2800000) || is(0xff800000, 0x52800000) || is(0xff800000, 0xf2800000) || is(0xff800000, 0x72800000)) {
        var moved = ((word >>> 5) & 0xffff);
        var keep = is(0xff800000, 0xf2800000) || is(0xff800000, 0x72800000);
        var shift = ((word >>> 21) & 3) * 16;
        var current = keep ? BigInt(reg(rd) >>> 0) : 0n;
        if (keep && (word & 0x80000000)) current = BigInt(reg(rd));
        var wideMask = 0xffffn << BigInt(shift);
        var merged = (current & ~wideMask) | (BigInt(moved) << BigInt(shift));
        if ((word & 0x80000000) === 0) merged &= 0xffffffffn;
        wreg(rd, Number(merged));
        pc = next;
        continue;
      }
      if (is(0xffe0ffe0, 0xaa0003e0)) {
        var src = (word >>> 16) & 31;
        wreg(rd, src === 31 ? 0 : reg(src));
        pc = next;
        continue;
      }
      if (is(0xffc00000, 0xf9400000) || is(0xffc00000, 0xb9400000) || is(0xffc00000, 0x39400000)) {
        var scale = is(0xffc00000, 0xf9400000) ? 8 : is(0xffc00000, 0xb9400000) ? 4 : 1;
        var addr = reg(rn) + ((word >>> 10) & 0xfff) * scale;
        var loaded = load(addr, scale);
        if (rd !== 31) wreg(rd, scale === 4 ? loaded >>> 0 : loaded);
        pc = next;
        continue;
      }
      if (is(0xffc00000, 0xf9000000) || is(0xffc00000, 0xb9000000) || is(0xffc00000, 0x39000000)) {
        var stScale = is(0xffc00000, 0xf9000000) ? 8 : is(0xffc00000, 0xb9000000) ? 4 : 1;
        store(reg(rn) + ((word >>> 10) & 0xfff) * stScale, rd === 31 ? 0 : reg(rd), stScale);
        pc = next;
        continue;
      }
      if (is(0xffc00000, 0xa9000000) || is(0xffc00000, 0xa9400000) || is(0xffc00000, 0xa9800000) || is(0xffc00000, 0xa9c00000)) {
        var off = sex((word >>> 15) & 0x7f, 7) * 8;
        var rt2 = (word >>> 10) & 31;
        var writeback = is(0xffc00000, 0xa9800000) || is(0xffc00000, 0xa9c00000);
        var baseAddr = reg(rn) + off;
        if (is(0x00400000, 0x00400000)) {
          if (rd !== 31) wreg(rd, load(baseAddr, 8));
          if (rt2 !== 31) wreg(rt2, load(baseAddr + 8, 8));
        } else {
          if (rd !== 31) store(baseAddr, reg(rd), 8);
          if (rt2 !== 31) store(baseAddr + 8, reg(rt2), 8);
        }
        if (writeback) wreg(rn, baseAddr);
        pc = next;
        continue;
      }
      stop = "The guest stopped on an unknown instruction " + (word >>> 0).toString(16);
      break;
    }
    steps = guard;
    if (!stop && guard >= 1500000) stop = hitMain ? "" : "Paused inside the executable";
    var detail;
    var state = "stop";
    if (hitMain && stop.indexOf("does not provide") === -1 && stop.indexOf("Unknown") === -1 && stop !== "Left the executable" && stop !== "Stack check failed" && stop !== "The guest aborted.") {
      state = "run";
      detail = views.some(function (item) { return item.text; }) ? "On screen." : "UIApplicationMain is provided. The guest is on the run loop.";
    } else if (hitMain && stop) {
      state = "stop";
      detail = "UIApplicationMain is provided. The guest stopped after the call. " + stop;
    } else if (!stop) {
      state = "run";
      detail = "The entry returned.";
    } else detail = stop;
    if (state !== "run" && trace.length) detail += " Calls: " + trace.slice(-6).join(", ") + ".";
    return { state: state, detail: detail, views: views, logs: logs, steps: steps, proc: proc };
  }

  async function openIpa(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var files = await unzip(bytes, function (name) {
      if (name.endsWith("/")) return false;
      if (/^Payload\/[^/]+\.app\/Info\.plist$/.test(name)) return true;
      if (/^Payload\/[^/]+\.app\/[^/]*icon[^/]*\.png$/i.test(name)) return true;
      return /^Payload\/[^/]+\.app\/[^/]+$/.test(name) && !/\.(png|plist|mobileprovision|json|strings)$/i.test(name);
    });
    var info = files.filter(function (file) { return /\/Info\.plist$/.test(file.name); })[0];
    if (!info) throw new Error("No app bundle was found inside this IPA.");
    var meta = plist(info.data);
    var bundle = info.name.split("/")[1];
    var execName = String(meta[MARKS.executable] || bundle.replace(/\.app$/, ""));
    var executable = files.filter(function (file) { return file.name === "Payload/" + bundle + "/" + execName; })[0];
    var image = executable ? macho(executable.data) : null;
    var encrypted = !!(image && image.cryptid);
    var libraries = image ? image.libraries.filter(Boolean) : [];
    var entry = { name: "Entry", state: "stop", detail: "Not started." };
    var screen = null;
    var proc = null;
    var logs = [];
    if (image && encrypted) entry.detail = "Not started. Store encryption was left in place.";
    if (image && !encrypted) {
      proc = personality({
        bundleId: String(meta[MARKS.id] || ""),
        execName: execName,
        bundle: bundle,
        name: String(meta[MARKS.display] || meta[MARKS.name] || bundle.replace(/\.app$/, "")),
        system: String(meta[MARKS.system] || ""),
        plist: meta
      });
      try {
        var loaded = loadImage(executable.data);
        if (!loaded) entry.detail = "The executable could not be mapped.";
        else {
          var ran = runImage(loaded, proc);
          proc = ran.proc || proc;
          logs = (ran.logs || []).slice(0, 12);
          entry = { name: "Entry", state: ran.state === "run" ? "run" : "stop", detail: ran.detail };
          if (ran.state === "run") {
            screen = {
              views: ran.views.filter(function (item) { return item.text; }).slice(0, 12),
              logs: ran.logs.slice(0, 8)
            };
          }
        }
      } catch (err) {
        entry = { name: "Entry", state: "stop", detail: err && err.message ? err.message : "The guest could not be started." };
      }
    }
    var stages = [
      { name: "Container", state: "done", detail: bundle },
      { name: "Bundle", state: meta[MARKS.id] ? "done" : "stop", detail: String(meta[MARKS.id] || "Missing identifier") },
      { name: "Executable", state: image ? "done" : "stop", detail: image ? execName + " · " + image.filetype : "Missing or unreadable executable" },
      { name: "Encryption", state: image && !encrypted ? "done" : "stop", detail: !image ? "Unread." : encrypted ? "Store encryption is still on. It was not removed." : "No store encryption on this executable." },
      { name: "Libraries", state: image && !encrypted ? "done" : "stop", detail: image && !encrypted ? (libraries.slice(0, 8).join(", ") || "None listed") : "Unread." },
      entry
    ];
    return {
      name: String(meta[MARKS.display] || meta[MARKS.name] || bundle.replace(/\.app$/, "")),
      bundleId: String(meta[MARKS.id] || ""),
      version: String(meta[MARKS.version] || ""),
      system: String(meta[MARKS.system] || ""),
      icon: iconOf(files),
      stages: stages,
      screen: screen,
      proc: proc,
      libraries: libraries,
      logs: logs
    };
  }

  function el(tag, className, textValue) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue) node.textContent = textValue;
    return node;
  }

  function clock() {
    var now = new Date();
    var h = now.getHours();
    var m = String(now.getMinutes()).padStart(2, "0");
    return (h % 12 || 12) + ":" + m;
  }

  function elapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function svg(d) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    node.appendChild(path);
    return node;
  }

  function database() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("This browser cannot keep a shelf."));
        return;
      }
      var req = window.indexedDB.open("pygu-host", 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
        if (!db.objectStoreNames.contains("blob")) db.createObjectStore("blob", { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function start(mount) {
    mount.className = "host";
    mount.replaceChildren();
    var model = { tab: "now", guest: null, error: "", busy: false, shelf: [], booted: 0 };
    var icons = {
      now: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
      shelf: "M5 7h14M5 12h14M5 17h8",
      bench: "M6 19V6M12 19V10M18 19v-7"
    };
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".ipa,.zip,application/octet-stream";
    input.className = "file";
    var shell = el("div", "shell");
    var header = el("header");
    var main = el("main");
    var nav = el("nav");
    shell.appendChild(header);
    shell.appendChild(main);
    shell.appendChild(nav);
    shell.appendChild(input);
    mount.appendChild(shell);

    function entryOf(guest) {
      if (!guest) return null;
      var found = guest.stages.filter(function (stage) { return stage.name === "Entry"; })[0];
      return found || null;
    }

    function statusWord() {
      if (model.busy) return "Reading";
      var entry = entryOf(model.guest);
      if (!entry) return "Idle";
      return entry.state === "run" ? "Running" : "Stopped";
    }

    function remember(bytes, guest) {
      var id = guest.bundleId || guest.name;
      var meta = {
        id: id,
        name: guest.name,
        bundleId: guest.bundleId,
        version: guest.version,
        icon: guest.icon,
        added: Date.now()
      };
      return database().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(["meta", "blob"], "readwrite");
          tx.objectStore("meta").put(meta);
          tx.objectStore("blob").put({ id: id, bytes: bytes });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      }).then(loadShelf);
    }

    function loadShelf() {
      return database().then(function (db) {
        return new Promise(function (resolve) {
          var req = db.transaction("meta").objectStore("meta").getAll();
          req.onsuccess = function () {
            model.shelf = (req.result || []).sort(function (a, b) { return b.added - a.added; });
            resolve();
          };
          req.onerror = function () { resolve(); };
        });
      }).catch(function () {});
    }

    function forget(id) {
      database().then(function (db) {
        var tx = db.transaction(["meta", "blob"], "readwrite");
        tx.objectStore("meta").delete(id);
        tx.objectStore("blob").delete(id);
        tx.oncomplete = function () {
          if (model.guest && (model.guest.bundleId || model.guest.name) === id) {
            model.guest = null;
          }
          loadShelf().then(draw);
        };
      }).catch(function () {});
    }

    function showGuest(guest) {
      model.guest = guest;
      model.booted = Date.now();
      model.tab = "now";
      model.error = "";
    }

    function openBuffer(bytes, keep) {
      model.busy = true;
      model.error = "";
      model.tab = "now";
      draw();
      openIpa(bytes).then(function (guest) {
        showGuest(guest);
        if (keep) return remember(bytes, guest);
        return null;
      }).catch(function (err) {
        model.error = err && err.message ? err.message : "The IPA could not be read.";
      }).then(function () {
        model.busy = false;
        draw();
      });
    }

    function relaunch(id) {
      model.busy = true;
      model.error = "";
      model.tab = "now";
      draw();
      database().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = db.transaction("blob").objectStore("blob").get(id);
          req.onsuccess = function () { resolve(req.result && req.result.bytes); };
          req.onerror = function () { reject(req.error); };
        });
      }).then(function (bytes) {
        if (!bytes) throw new Error("That IPA is no longer on this device.");
        return openIpa(bytes);
      }).then(function (guest) {
        showGuest(guest);
      }).catch(function (err) {
        model.error = err && err.message ? err.message : "The IPA could not be opened.";
      }).then(function () {
        model.busy = false;
        draw();
      });
    }

    function tabButton(id, label) {
      var button = el("button", "tab" + (model.tab === id ? " on" : ""));
      button.type = "button";
      button.setAttribute("aria-pressed", model.tab === id ? "true" : "false");
      button.appendChild(svg(icons[id]));
      button.appendChild(el("span", "", label));
      button.addEventListener("click", function () {
        model.tab = id;
        draw();
      });
      return button;
    }

    function stageMark(stage) {
      if (stage.state === "run") return "Running";
      if (stage.state === "done") return "Done";
      return "Stopped";
    }

    function paintNow() {
      if (model.error) main.appendChild(el("p", "error", model.error));
      if (!model.guest) {
        var empty = el("section", "empty");
        empty.appendChild(el("p", "eyebrow", "Host"));
        empty.appendChild(el("h2", "", "An IPA you own, in a process of its own."));
        empty.appendChild(el("p", "lead", "Pygu gives it a pid, a container, and a screen. Store encryption is left where it is."));
        var open = el("button", "open", model.busy ? "Reading" : "Open IPA");
        open.type = "button";
        open.disabled = model.busy;
        open.addEventListener("click", function () { input.click(); });
        empty.appendChild(open);
        main.appendChild(empty);
        return;
      }
      var guest = model.guest;
      var entry = entryOf(guest);
      var who = el("div", "who");
      if (guest.icon) {
        var img = document.createElement("img");
        img.alt = "";
        img.src = guest.icon;
        who.appendChild(img);
      }
      var titles = el("div");
      titles.appendChild(el("h2", "", guest.name));
      titles.appendChild(el("p", "muted", [guest.bundleId, guest.version].filter(Boolean).join("  ·  ")));
      who.appendChild(titles);
      main.appendChild(who);
      var screen = el("div", "screen");
      var bar = el("div", "chrome");
      bar.appendChild(el("span", "clock", clock()));
      bar.appendChild(el("span", "", guest.name));
      screen.appendChild(bar);
      var views = guest.screen && guest.screen.views ? guest.screen.views : [];
      var body = el("div", views.length ? "body texts" : "body");
      if (views.length) {
        views.forEach(function (view) { body.appendChild(el("p", "label", view.text)); });
      } else if (entry && entry.state === "run") {
        if (guest.icon) {
          var launch = document.createElement("img");
          launch.alt = "";
          launch.className = "launch";
          launch.src = guest.icon;
          body.appendChild(launch);
        }
        body.appendChild(el("p", "launch-name", guest.name));
      } else {
        body.appendChild(el("p", "muted", entry ? entry.detail : "Not started."));
      }
      screen.appendChild(body);
      main.appendChild(screen);
      if (guest.proc) {
        var alive = entry && entry.state === "run";
        var card = el("div", "proc");
        card.appendChild(el("p", "kicker", "Process"));
        card.appendChild(el("p", alive ? "pid run" : "pid stop", String(guest.proc.pid)));
        card.appendChild(el("p", "meta", "parent " + guest.proc.ppid + "  ·  uid " + guest.proc.uid + "  ·  " + (alive ? "up " : "held ")));
        var up = card.querySelector(".meta");
        up.appendChild(el("span", "elapsed", elapsed(Date.now() - model.booted)));
        card.appendChild(el("p", "path", guest.proc.home));
        main.appendChild(card);
      }
    }

    function paintShelf() {
      main.appendChild(el("h2", "page-title", "Shelf"));
      main.appendChild(el("p", "lead", "Kept on this device. Nothing is uploaded."));
      if (!model.shelf.length) {
        main.appendChild(el("p", "muted", "Nothing kept yet. Open an IPA and it stays here."));
        return;
      }
      model.shelf.forEach(function (item) {
        var row = el("div", "shelf");
        var launch = el("button", "shelf-open");
        launch.type = "button";
        if (item.icon) {
          var img = document.createElement("img");
          img.alt = "";
          img.src = item.icon;
          launch.appendChild(img);
        }
        var text = el("span", "shelf-copy");
        text.appendChild(el("strong", "", item.name));
        text.appendChild(el("span", "muted", [item.bundleId, item.version].filter(Boolean).join("  ·  ")));
        launch.appendChild(text);
        launch.addEventListener("click", function () { relaunch(item.id); });
        var remove = el("button", "forget", "Remove");
        remove.type = "button";
        remove.addEventListener("click", function () { forget(item.id); });
        row.appendChild(launch);
        row.appendChild(remove);
        main.appendChild(row);
      });
    }

    function paintBench() {
      main.appendChild(el("h2", "page-title", "Bench"));
      if (!model.guest) {
        main.appendChild(el("p", "lead", "Open an IPA to inspect the process."));
        return;
      }
      var guest = model.guest;
      guest.stages.forEach(function (stage) {
        var row = el("div", "row");
        row.appendChild(el("span", "", stage.name));
        row.appendChild(el("span", stage.state, stageMark(stage)));
        main.appendChild(row);
        main.appendChild(el("p", "detail", stage.detail));
      });
      if (guest.proc && guest.proc.env) {
        main.appendChild(el("h3", "", "Environment"));
        Object.keys(guest.proc.env).forEach(function (key) {
          var line = el("p", "env");
          line.appendChild(el("span", "key", key));
          line.appendChild(document.createTextNode(guest.proc.env[key]));
          main.appendChild(line);
        });
      }
      if (guest.libraries && guest.libraries.length) {
        main.appendChild(el("h3", "", "Linked"));
        var chips = el("div", "chips");
        guest.libraries.forEach(function (name) { chips.appendChild(el("span", "chip", name)); });
        main.appendChild(chips);
      }
      if (guest.logs && guest.logs.length) {
        main.appendChild(el("h3", "", "Log"));
        guest.logs.forEach(function (line) { main.appendChild(el("p", "log", line)); });
      }
    }

    function draw() {
      header.replaceChildren();
      var brand = el("div", "brand");
      brand.appendChild(el("p", "word", "Pygu"));
      brand.appendChild(el("p", "clock", clock()));
      header.appendChild(brand);
      var status = el("p", "status " + (model.busy ? "stop" : statusWord() === "Running" ? "run" : statusWord() === "Stopped" ? "stop" : "idle"), statusWord());
      header.appendChild(status);
      var open = el("button", "open small", model.busy ? "Reading" : "Open");
      open.type = "button";
      open.disabled = model.busy;
      open.addEventListener("click", function () { input.click(); });
      if (!(model.tab === "now" && !model.guest)) header.appendChild(open);
      main.replaceChildren();
      if (model.tab === "shelf") paintShelf();
      else if (model.tab === "bench") paintBench();
      else paintNow();
      nav.replaceChildren();
      nav.appendChild(tabButton("now", "Now"));
      nav.appendChild(tabButton("shelf", "Shelf"));
      nav.appendChild(tabButton("bench", "Bench"));
    }

    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      file.arrayBuffer().then(function (bytes) { openBuffer(bytes, true); });
    });
    loadShelf().then(draw);
    draw();
    var timer = window.setInterval(function () {
      var face = mount.querySelector(".clock");
      if (face) face.textContent = clock();
      var up = mount.querySelector(".elapsed");
      if (up && model.booted) up.textContent = elapsed(Date.now() - model.booted);
    }, 1000);
    return function () {
      window.clearInterval(timer);
      mount.replaceChildren();
    };
  }

  function selfTest() {
    function movWide(rd, value) {
      var words = [];
      var parts = [value & 0xffff, (value / 65536) & 0xffff, (value / 4294967296) & 0xffff, (value / 281474976710656) & 0xffff];
      words.push(0xd2800000 | (parts[0] << 5) | rd);
      var h;
      for (h = 1; h < 4; h += 1) {
        if (!parts[h]) continue;
        words.push(0xf2800000 | (h << 21) | (parts[h] << 5) | rd);
      }
      return words;
    }
    function put32(buf, off, value) {
      buf[off] = value & 255;
      buf[off + 1] = (value >>> 8) & 255;
      buf[off + 2] = (value >>> 16) & 255;
      buf[off + 3] = (value >>> 24) & 255;
    }
    function put64(buf, off, value) {
      var n = BigInt(value);
      var i;
      for (i = 0; i < 8; i += 1) buf[off + i] = Number((n >> BigInt(i * 8)) & 255n);
    }
    var buf = new Uint8Array(0x4000);
    put32(buf, 0, 0xfeedfacf);
    put32(buf, 4, 0x0100000c);
    put32(buf, 12, 2);
    put32(buf, 16, 5);
    put32(buf, 20, 72 + 24 + 16 + 56 + 88);
    var seg = 32;
    put32(buf, seg, 0x19);
    put32(buf, seg + 4, 72);
    put64(buf, seg + 24, 0x100000000);
    put64(buf, seg + 32, 0x4000);
    put64(buf, seg + 40, 0);
    put64(buf, seg + 48, 0x4000);
    put32(buf, seg + 56, 7);
    put32(buf, seg + 60, 5);
    var main = seg + 72;
    put32(buf, main, 0x80000028);
    put32(buf, main + 4, 24);
    put64(buf, main + 8, 0x1000);
    var chained = main + 24;
    put32(buf, chained, 0x80000034);
    put32(buf, chained + 4, 16);
    put32(buf, chained + 8, 0x3000);
    put32(buf, chained + 12, 0x100);
    function dylib(at, path, size) {
      put32(buf, at, 0xc);
      put32(buf, at + 4, size);
      put32(buf, at + 8, 24);
      var i;
      for (i = 0; i < path.length; i += 1) buf[at + 24 + i] = path.charCodeAt(i);
    }
    dylib(chained + 16, "/usr/lib/libobjc.A.dylib", 56);
    dylib(chained + 16 + 56, "/System/Library/Frameworks/Foundation.framework/Foundation", 88);
    var code = [];
    code = code.concat(movWide(0, 0));
    code = code.concat(movWide(1, 0x100001800));
    code = code.concat(movWide(2, 0x100001820));
    code.push(0xb0000010);
    code.push(0xf9400210);
    code.push(0xd63f0200);
    code = code.concat(movWide(0, 0));
    code = code.concat(movWide(1, 0));
    code = code.concat(movWide(2, 0));
    code = code.concat(movWide(3, 0));
    code.push(0xb0000010);
    code.push(0xf9400610);
    code.push(0xd63f0200);
    code.push(0xd65f03c0);
    var at = 0x1000;
    code.forEach(function (word) {
      put32(buf, at, word);
      at += 4;
    });
    var sel = "setText:";
    var msg = "Hello from the guest";
    var n;
    for (n = 0; n < sel.length; n += 1) buf[0x1800 + n] = sel.charCodeAt(n);
    for (n = 0; n < msg.length; n += 1) buf[0x1820 + n] = msg.charCodeAt(n);
    put64(buf, 0x2000, (1n << 63n) | (2n << 51n));
    put64(buf, 0x2008, (1n << 63n) | 1n);
    put32(buf, 0x3000, 0);
    put32(buf, 0x3004, 32);
    put32(buf, 0x3008, 80);
    put32(buf, 0x300c, 96);
    put32(buf, 0x3010, 2);
    put32(buf, 0x3014, 1);
    put32(buf, 0x3020, 1);
    put32(buf, 0x3024, 8);
    put32(buf, 0x3028, 32);
    buf[0x302c] = 0x00;
    buf[0x302d] = 0x10;
    buf[0x302e] = 2;
    buf[0x302f] = 0;
    put64(buf, 0x3030, 0);
    put32(buf, 0x3038, 0);
    buf[0x303c] = 3;
    buf[0x303d] = 0;
    buf[0x303e] = 0xff;
    buf[0x303f] = 0xff;
    buf[0x3040] = 0xff;
    buf[0x3041] = 0xff;
    buf[0x3042] = 0;
    buf[0x3043] = 0;
    put32(buf, 0x3050, (0 << 9) | 1);
    put32(buf, 0x3054, (13 << 9) | 1);
    var names = "objc_msgSend\0UIApplicationMain\0";
    for (n = 0; n < names.length; n += 1) buf[0x3060 + n] = names.charCodeAt(n);
    var image = loadImage(buf);
    var ran = runImage(image);
    var shown = ran.views.some(function (item) { return item.text === "Hello from the guest"; });
    image.stubs[0x200000020] = "notAHostCall";
    var missing = runImage(image);
    return {
      ok: ran.state === "run" && shown && missing.state === "stop" && missing.detail.indexOf("notAHostCall") !== -1 && macho(buf).cryptid === 0 && ran.proc.ppid === 1 && ran.proc.uid === 501 && ran.proc.home.indexOf("/var/mobile/Containers/Data/Application/") === 0,
      ran: ran,
      missing: missing.detail,
      libs: macho(buf).libraries
    };
  }

  root.PyguHost = { openIpa: openIpa, start: start, selfTest: selfTest, loadImage: loadImage, runImage: runImage };
})(typeof globalThis !== "undefined" ? globalThis : this);
