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
      if (size === 2) return mem.u8(addr) | (mem.u8(addr + 1) << 8);
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
      else if (size === 2) {
        mem.w8(addr, value & 255, 1);
        mem.w8(addr + 1, (value >>> 8) & 255, 1);
      } else if (size === 1) mem.w8(addr, value & 255, 1);
    }
    function reg(i) {
      if (i === 31) return sp;
      return x[i] || 0;
    }
    function wreg(i, value) {
      if (i === 31) sp = value;
      else x[i] = value;
    }
    function gpr(i) {
      return i === 31 ? 0 : (x[i] || 0);
    }
    function wgpr(i, value) {
      if (i !== 31) x[i] = value;
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
    var retSlot = 0x210000010;
    var exitSlot = 0x210000018;
    var retStack = [];
    var swiftBusy = {};
    var typeCache = {};
    image.stubs[retSlot] = "hostReturn";
    image.stubs[exitSlot] = "guestExit";
    var vwtSlot = 0x210000300;
    var vwtName = ["vwtInitBuf", "vwtDestroy", "vwtInitCopy", "vwtAssignCopy", "vwtInitTake", "vwtAssignTake", "vwtGetSP", "vwtStoreSP", "vwtGetTag", "vwtProject"];
    var vi;
    for (vi = 0; vi < vwtName.length; vi += 1) image.stubs[vwtSlot + vi * 16] = vwtName[vi];
    var witnessSlot = 0x210000220;
    var lookupSlot = 0x210000230;
    image.stubs[witnessSlot] = "swiftWitness";
    image.stubs[lookupSlot] = "swiftLookup";
    x[30] = exitSlot;
    function sex32(at) {
      if (!mem.seg(at)) return 0;
      var u = mem.u32(at);
      var off = u & 0x80000000 ? u - 4294967296 : u;
      if (!off || off > 268435456 || off < -268435456) return 0;
      var target = at + off;
      return mem.seg(target) ? target : 0;
    }
    function allocMeta(desc, kind) {
      var ptr = bump;
      bump += 256;
      mem.w64(ptr + 8, kind || 1);
      if (desc) mem.w64(ptr + 16, desc);
      return ptr;
    }
    function singletonInit(desc) {
      if (!desc || !mem.seg(desc)) return null;
      var flags = mem.u32(desc);
      var kind = flags & 31;
      if (((flags >>> 16) & 3) !== 1 || (flags & 128) !== 0) return null;
      var cursor = 0;
      if (kind === 16) cursor = desc + 44 + (((flags >>> 16) & 8192) !== 0 ? 4 : 0);
      else if (kind === 17 || kind === 18) cursor = desc + 28;
      else return null;
      if (!mem.seg(cursor + 8)) return null;
      return { cache: sex32(cursor), incomplete: sex32(cursor + 4), completion: sex32(cursor + 8) };
    }
    function i32at(addr) {
      var u = mem.u32(addr);
      return u & 0x80000000 ? u - 4294967296 : u;
    }
    function metadataForDescriptor(desc) {
      var init = singletonInit(desc);
      if (init && init.cache) {
        var ready = mem.u64(init.cache);
        if (ready) return ready;
      }
      var meta = (init && init.incomplete) || allocMeta(desc, desc && (mem.u32(desc) & 31) === 16 ? 0 : 1);
      if (init && init.completion && !swiftBusy[desc]) {
        swiftBusy[desc] = 1;
        return callGuest(init.completion, meta, 0, 0, function () {
          swiftBusy[desc] = 0;
          if (init.cache) mem.w64(init.cache, meta);
          return { x0: meta, x1: 0 };
        });
      }
      if (init && init.cache) mem.w64(init.cache, meta);
      return meta;
    }
    function typeFromMangled(start, len, context) {
      if (start && mem.seg(start) && len >= 5) {
        var raw = mem.u8(start);
        var at = start + 1;
        if (raw >= 1 && raw <= 12 && mem.seg(at + 3)) {
          var target = at + i32at(at);
          if ((raw === 1 || raw === 2) && mem.seg(target)) {
            var desc = raw === 2 ? mem.u64(target) : target;
            if (desc && mem.seg(desc)) return metadataForDescriptor(desc);
          }
          if (raw === 9 && mem.seg(target)) {
            return callGuest(target, context || 0, 0, 0, function (result) {
              return { x0: result || allocMeta(context || 0, 1), x1: 0 };
            });
          }
        }
      }
      var key = String(start || 0) + "/" + String(len || 0) + "/" + String(context || 0);
      if (!typeCache[key]) typeCache[key] = allocMeta(context || 0, 1);
      return typeCache[key];
    }
    function alignBump() {
      bump = (bump + 15) & ~15;
    }
    function kindOfSymbol(name) {
      if (/4UUID|4DataV|SSMa$|12StaticString/.test(name)) return { kind: 0x200, size: 16 };
      if (/SiMa$|Si_/.test(name) || /s5Int64|s6UInt64|s5Int32|SdMa$|SfMa$/.test(name)) return { kind: 0x200, size: 8 };
      if (/SbMa$/.test(name)) return { kind: 0x200, size: 1 };
      if (/CMa$/.test(name)) return { kind: 0, size: 8 };
      if (/OMa$/.test(name)) return { kind: 0x201, size: 8 };
      return { kind: 0x200, size: 16 };
    }
    function shapeNamed(name) {
      var key = "shape:" + name;
      if (typeCache[key]) return typeCache[key];
      var spec = kindOfSymbol(name);
      alignBump();
      var vwt = bump;
      var meta = vwt + 128;
      bump = meta + 64;
      var slot;
      for (slot = 0; slot < 8; slot += 1) mem.w64(vwt + slot * 8, vwtSlot + slot * 16);
      mem.w64(vwt + 64, spec.size);
      mem.w64(vwt + 72, Math.max(spec.size, 1));
      mem.w32(vwt + 80, spec.size >= 8 ? 7 : Math.max(spec.size - 1, 0));
      mem.w32(vwt + 84, 0);
      mem.w64(vwt + 88, vwtSlot + 8 * 16);
      mem.w64(vwt + 96, vwtSlot + 9 * 16);
      mem.w64(meta - 8, vwt);
      mem.w64(meta, spec.kind);
      typeCache[key] = meta;
      return meta;
    }
    function witnessFor(name) {
      var key = "wit:" + name;
      if (typeCache[key]) return typeCache[key];
      alignBump();
      var ptr = bump;
      bump += 64;
      var slot;
      for (slot = 0; slot < 8; slot += 1) mem.w64(ptr + slot * 8, witnessSlot);
      typeCache[key] = ptr;
      return ptr;
    }
    function valueSize(metadata) {
      if (!metadata || !mem.seg(metadata - 8)) return 16;
      var vwt = mem.u64(metadata - 8);
      if (!vwt || !mem.seg(vwt + 64)) return 16;
      var size = mem.u64(vwt + 64);
      if (!size || size > 4096) return 16;
      return size;
    }
    function swiftSymbol(name) {
      var tail = name.slice(-2);
      if (tail === "Ma" || tail === "Mi") {
        x[1] = 0;
        return shapeNamed(name);
      }
      if (tail === "Mn" || tail === "Mf" || tail === "MH" || tail === "ML" || tail === "Mr" || tail === "Mp") return shapeNamed(name);
      if (tail === "Mu") return lookupSlot;
      if (tail === "Wl" || tail === "WA" || tail === "Wt" || name.slice(-3) === "Mc") return witnessFor(name);
      if (/fC$/.test(name) || /fc$/.test(name) || /fD$/.test(name)) return fresh("value", name);
      return 0;
    }
    function callGuest(fn, a0, a1, a2, done) {
      retStack.push({ back: x[30], done: done });
      redirect = fn;
      x[1] = a1 || 0;
      x[2] = a2 || 0;
      x[30] = retSlot;
      return a0 || 0;
    }
    function call(addr) {
      var name = image.stubs[addr];
      redirect = 0;
      if (!name) {
        stop = "Unmapped call at " + addr.toString(16);
        return 0;
      }
      if (name !== "hostReturn" && name !== "guestExit" && name.indexOf("vwt") !== 0 && name !== "swiftWitness") remember(name);
      if (name === "hostReturn") {
        var frame = retStack.pop();
        if (!frame) {
          redirect = 1;
          return 0;
        }
        var out = frame.done(x[0]) || { x0: 0 };
        x[1] = out.x1 || 0;
        x[2] = out.x2 || 0;
        redirect = frame.back || 1;
        return out.x0 || 0;
      }
      if (name.indexOf("vwt") === 0) {
        if (name === "vwtDestroy" || name === "vwtStoreSP" || name === "vwtProject") return 0;
        if (name === "vwtGetSP" || name === "vwtGetTag") return 0;
        var bytes = valueSize(name === "vwtInitBuf" ? x[2] : x[2]);
        if (x[0] && x[1]) mem.copy(x[0], x[1], bytes);
        return x[0];
      }
      if (name === "swiftWitness") return x[0];
      if (name === "swiftLookup") return 0;
      if (name === "guestExit") {
        redirect = 1;
        return x[0];
      }
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
      if (name === "memset" || name === "bzero" || name === "__bzero" || name === "__memset_chk") {
        mem.w8(x[0], name === "memset" || name === "__memset_chk" ? x[1] : 0, Math.min(x[2] || (name === "memset" || name === "__memset_chk" ? 0 : x[1]) || 0, 65536));
        return x[0];
      }
      if (name === "memcpy" || name === "memmove" || name === "bcopy" || name === "__memcpy_chk" || name === "__memmove_chk") {
        mem.copy(x[0], x[1], Math.min(x[2] || 0, 65536));
        return x[0];
      }
      if (name === "memcmp" || name === "bcmp") {
        var span = Math.min(x[2] || 0, 65536);
        var bi;
        for (bi = 0; bi < span; bi += 1) {
          var delta = mem.u8(x[0] + bi) - mem.u8(x[1] + bi);
          if (delta) return delta < 0 ? -1 : 1;
        }
        return 0;
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
      if (name === "dispatch_once_f" || name === "dispatch_once") {
        if (x[0] && mem.u64(x[0]) === 0) {
          mem.w64(x[0], 1);
          if (name === "dispatch_once_f" && x[2]) return callGuest(x[2], x[1], 0, 0, function () { return { x0: 0 }; });
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
      if (name === "swift_getSingletonMetadata") {
        var produced = metadataForDescriptor(x[1]);
        x[1] = 0;
        return produced;
      }
      if (name === "swift_checkMetadataState" || name === "swift_getForeignTypeMetadata") {
        var foundMeta = x[1];
        x[1] = 0;
        return foundMeta;
      }
      if (name === "swift_once") {
        if (x[0] && mem.u32(x[0]) === 0 && x[1]) {
          mem.w32(x[0], 1);
          return callGuest(x[1], x[2], 0, 0, function () { return { x0: 0 }; });
        }
        return 0;
      }
      if (name === "swift_allocObject" || name === "swift_allocBox") {
        var bytes = Math.min(Math.max(x[1] || 64, 16), 65536);
        var obj = bump;
        bump += (bytes + 15) & ~15;
        if (x[0]) mem.w64(obj, x[0]);
        return obj;
      }
      if (name === "swift_slowAlloc") {
        var heap = bump;
        bump += (Math.min(Math.max(x[0] || 16, 16), 65536) + 15) & ~15;
        return heap;
      }
      if (name === "swift_slowDealloc" || name === "swift_deallocObject" || name === "swift_deallocClassInstance" || name === "swift_deletedMethodError") return 0;
      if (name.indexOf("swift_retain") === 0 || name.indexOf("swift_bridgeObjectRetain") === 0 || name.indexOf("swift_unknownObjectRetain") === 0 || name === "swift_bridgeObjectRetain_n") return x[0];
      if (name.indexOf("swift_release") === 0 || name.indexOf("swift_bridgeObjectRelease") === 0 || name.indexOf("swift_unknownObjectRelease") === 0) return 0;
      if (name === "swift_getObjCClassFromMetadata" || name === "swift_getObjCClassMetadata" || name === "swift_getInitializedObjCClass") return x[0];
      if (name.indexOf("swift_getTypeByMangledName") === 0) {
        var inState = name.indexOf("InMetadataState") !== -1;
        return typeFromMangled(inState ? x[1] : x[0], inState ? x[2] : x[1], inState ? x[3] : x[2]);
      }
      if (name === "swift_getGenericMetadata") {
        var genericKey = String(x[2] || 0);
        if (!typeCache[genericKey]) typeCache[genericKey] = allocMeta(x[2], 1);
        return typeCache[genericKey];
      }
      if (name === "swift_initClassMetadata" || name === "swift_initClassMetadata2" || name === "swift_updateClassMetadata2" || name === "swift_initStructMetadata" || name === "swift_initEnumMetadataSinglePayload" || name === "swift_initEnumMetadataMultiPayload" || name === "swift_initStaticObject") return 0;
      if (name === "abort" || name === "__abort" || name === "swift_deletedMethodError") {
        stop = "The guest aborted.";
        redirect = 1;
        return 0;
      }
      if (name.indexOf("OBJC_CLASS_$") === 0 || name.indexOf("OBJC_METACLASS_$") === 0) {
        var clsName = name.slice(name.lastIndexOf("_") + 1);
        return put({ kind: "class", text: clsName, className: clsName });
      }
      if (name.indexOf("$s") === 0 || name.indexOf("$S") === 0) return swiftSymbol(name);
      if (name.indexOf("objc_") === 0 || name.indexOf("class_") === 0 || name.indexOf("object_") === 0 || name.indexOf("method_") === 0 || name.indexOf("sel_") === 0 || name.indexOf("ivar_") === 0 || name.indexOf("protocol_") === 0 || name.indexOf("property_") === 0 || name.indexOf("imp_") === 0 || name.indexOf("_Block_") === 0) {
        if (name.indexOf("release") !== -1 || name.indexOf("Release") !== -1 || name.indexOf("store") !== -1) return 0;
        return x[0] || 1;
      }
      if (name.indexOf("os_") === 0 || name.indexOf("pthread_") === 0 || name.indexOf("dispatch_") === 0 || name.indexOf("voucher_") === 0) return 0;
      if (name.indexOf("arc4random") === 0) return (Math.random() * 4294967296) >>> 0;
      if (name === "mach_absolute_time" || name === "clock_gettime_nsec_np") return Date.now() * 1000000;
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
    function sxLoad(value, bytes, narrow) {
      var bits = bytes * 8;
      if (bits >= 64) return value;
      var sign = bits === 32 ? 0x80000000 : 1 << (bits - 1);
      var span = bits === 32 ? 0x100000000 : sign * 2;
      if (value & sign) value -= span;
      if (narrow) value &= 0xffffffff;
      return value;
    }
    function big64(value) {
      var n = BigInt(Math.trunc(value || 0));
      if (n < 0n) n += 1n << 64n;
      return n & ((1n << 64n) - 1n);
    }
    function num64(value) {
      return Number(value & ((1n << 64n) - 1n));
    }
    function bitmask(immN, imms, immr, datasize) {
      var combined = ((immN & 1) << 6) | ((~imms) & 63);
      var len = -1;
      var bit;
      for (bit = 6; bit >= 0; bit -= 1) if ((combined >>> bit) & 1) { len = bit; break; }
      if (len < 1) return null;
      var size = 1 << len;
      if (size > datasize) return null;
      var levels = size - 1;
      var S = imms & levels;
      var R = immr & levels;
      if (S === levels) return null;
      var welem = (1n << BigInt(S + 1)) - 1n;
      var rot = R & (size - 1);
      var elem = rot ? ((welem >> BigInt(rot)) | (welem << BigInt(size - rot))) & ((1n << BigInt(size)) - 1n) : welem;
      var mask = 0n;
      var at;
      for (at = 0; at < datasize; at += size) mask |= elem << BigInt(at);
      return mask & ((1n << BigInt(datasize)) - 1n);
    }
    function shifted(value, kind, amount, wide) {
      var bits = wide ? 64 : 32;
      var n = big64(value) & ((1n << BigInt(bits)) - 1n);
      amount &= bits - 1;
      if (kind === 0) n <<= BigInt(amount);
      else if (kind === 1) n >>= BigInt(amount);
      else if (kind === 2) {
        var signed = n & (1n << BigInt(bits - 1)) ? n - (1n << BigInt(bits)) : n;
        n = signed >> BigInt(amount);
        if (n < 0n) n += 1n << BigInt(bits);
      } else if (amount) n = ((n >> BigInt(amount)) | (n << BigInt(bits - amount))) & ((1n << BigInt(bits)) - 1n);
      return n & ((1n << BigInt(bits)) - 1n);
    }
    function writeFlags(result, wide, carry, overflow) {
      var bits = wide ? 64 : 32;
      var masked = result & ((1n << BigInt(bits)) - 1n);
      z = masked === 0n ? 1 : 0;
      n = (masked >> BigInt(bits - 1)) & 1n ? 1 : 0;
      cflag = carry ? 1 : 0;
      vflag = overflow ? 1 : 0;
      return wide ? num64(masked) : Number(masked);
    }
    function moreArm(word) {
      var wide = (word & 0x80000000) !== 0;
      var rd = word & 31;
      var rn = (word >>> 5) & 31;
      var rm = (word >>> 16) & 31;
      if ((word & 0xffe0001f) === 0xd4000001 || (word & 0xffe0001f) === 0xd4000002 || (word & 0xffe0001f) === 0xd4000003) {
        x[0] = 0;
        logs.push("svc " + ((word >>> 5) & 0xffff));
        return true;
      }
      if ((word & 0xffe0001f) === 0xd4200000 || (word & 0xffe0001f) === 0xd4400000) {
        stop = (word & 0xffe0001f) === 0xd4200000 ? "The guest raised a breakpoint." : "The guest halted.";
        return false;
      }
      if ((word & 0xfff00000) === 0xd5300000) {
        wgpr(rd, proc && proc.thread ? proc.thread : 0x180001000);
        return true;
      }
      if ((word & 0xfff00000) === 0xd5100000 || (word >>> 20) === 0xdac || (word >>> 20) === 0xdad) return true;
      if ((word & 0x1f800000) === 0x12000000) {
        var mask = bitmask((word >>> 22) & 1, (word >>> 10) & 63, (word >>> 16) & 63, wide ? 64 : 32);
        if (mask === null) return false;
        var opc = (word >>> 29) & 3;
        var left = big64(gpr(rn));
        var out = opc === 1 ? (left | mask) : opc === 2 ? (left ^ mask) : (left & mask);
        if (!wide) out &= 0xffffffffn;
        if (opc === 3) wgpr(rd, writeFlags(out, wide, 0, 0));
        else wgpr(rd, wide ? num64(out) : Number(out));
        return true;
      }
      if ((word & 0x1f800000) === 0x13000000) {
        var bits = wide ? 64 : 32;
        var immr = (word >>> 16) & 63;
        var imms = (word >>> 10) & 63;
        var src = big64(gpr(rn)) & ((1n << BigInt(bits)) - 1n);
        var bopc = (word >>> 29) & 3;
        var rotated = immr ? ((src >> BigInt(immr)) | (src << BigInt(bits - immr))) & ((1n << BigInt(bits)) - 1n) : src;
        var outb;
        if (bopc === 2) {
          var width = imms + 1;
          outb = rotated & ((1n << BigInt(width > bits ? bits : width)) - 1n);
        } else if (bopc === 0) {
          var top = imms >= immr ? imms : bits - 1;
          var field = rotated & ((1n << BigInt(top + 1 > bits ? bits : top + 1)) - 1n);
          var signAt = Math.min(imms, bits - 1);
          if (field & (1n << BigInt(signAt))) field |= ~((1n << BigInt(signAt + 1)) - 1n);
          outb = field & ((1n << BigInt(bits)) - 1n);
        } else {
          var bot = imms >= immr ? imms : bits - 1;
          var keep = ((1n << BigInt(bot + 1)) - 1n) & ((1n << BigInt(bits)) - 1n);
          outb = (big64(gpr(rd)) & ~keep) | (rotated & keep);
        }
        wgpr(rd, wide ? num64(outb) : Number(outb & 0xffffffffn));
        return true;
      }
      if ((word & 0x1f200000) === 0x0b000000 && (word & 0x00200000) === 0) {
        var amount = (word >>> 10) & 63;
        var kind = (word >>> 22) & 3;
        var shiftedRm = shifted(gpr(rm), kind, amount, wide);
        var base = big64(gpr(rn));
        var sub = (word & 0x40000000) !== 0;
        var sum = sub ? base - shiftedRm : base + shiftedRm;
        var bitsn = wide ? 64 : 32;
        var outr = sum & ((1n << BigInt(bitsn)) - 1n);
        if ((word & 0x20000000) !== 0) {
          var carry = sub ? base >= shiftedRm : outr < (base & ((1n << BigInt(bitsn)) - 1n));
          var sb = (base >> BigInt(bitsn - 1)) & 1n;
          var sm = (shiftedRm >> BigInt(bitsn - 1)) & 1n;
          var so = (outr >> BigInt(bitsn - 1)) & 1n;
          var overflow = sub ? sb !== sm && sb !== so : sb === sm && sb !== so;
          wgpr(rd, writeFlags(outr, wide, carry, overflow));
        } else wgpr(rd, wide ? num64(outr) : Number(outr));
        return true;
      }
      if ((word & 0x1fe00000) === 0x0b200000) {
        var option = (word >>> 13) & 7;
        var ebits = option === 0 || option === 4 ? 8 : option === 1 || option === 5 ? 16 : option === 2 || option === 6 ? 32 : 64;
        var ext = big64(gpr(rm)) & ((1n << BigInt(ebits)) - 1n);
        if (option >= 4 && ext & (1n << BigInt(ebits - 1))) ext |= ~((1n << BigInt(ebits)) - 1n);
        var eshift = (word >>> 10) & 7;
        if (eshift > 4) return false;
        var extended = (ext << BigInt(eshift)) & ((1n << (wide ? 64n : 32n)) - 1n);
        var ebase = big64(rn === 31 ? reg(31) : gpr(rn));
        var esub = (word & 0x40000000) !== 0;
        var esum = (esub ? ebase - extended : ebase + extended) & ((1n << (wide ? 64n : 32n)) - 1n);
        if (rd === 31) wreg(31, num64(esum));
        else wgpr(rd, wide ? num64(esum) : Number(esum));
        return true;
      }
      if ((word & 0x1f000000) === 0x0a000000) {
        var lkind = (word >>> 22) & 3;
        var lamt = (word >>> 10) & 63;
        var lsrc = shifted(gpr(rm), lkind, lamt, wide);
        if ((word & 0x00200000) !== 0) lsrc = ~lsrc;
        var lbase = big64(gpr(rn));
        var lop = (word >>> 29) & 3;
        var lout = lop === 1 ? (lbase | lsrc) : lop === 2 ? (lbase ^ lsrc) : (lbase & lsrc);
        if (!wide) lout &= 0xffffffffn;
        if (lop === 3) wgpr(rd, writeFlags(lout, wide, 0, 0));
        else wgpr(rd, wide ? num64(lout) : Number(lout));
        return true;
      }
      if ((word & 0x1fe00000) === 0x1a800000) {
        var ok = cond((word >>> 12) & 15);
        var alt = gpr(rm);
        var chosen = ok ? gpr(rn) : alt;
        var c2 = (word >>> 10) & 3;
        var invert = (word & 0x40000000) !== 0;
        if (!ok && c2 === 1 && !invert) chosen = (alt + 1) | 0;
        if (!ok && invert && c2 === 0) chosen = ~alt;
        if (!ok && invert && c2 === 1) chosen = -alt;
        if (!wide) chosen >>>= 0;
        wgpr(rd, chosen);
        return true;
      }
      if ((word & 0x7fe08000) === 0x1b000000) {
        var prod = big64(gpr(rn)) * big64(gpr(rm));
        if ((word & 0x8000) !== 0) prod = -prod;
        var madd = (prod + big64(gpr((word >>> 10) & 31))) & ((1n << (wide ? 64n : 32n)) - 1n);
        wgpr(rd, wide ? num64(madd) : Number(madd));
        return true;
      }
      if ((word & 0x5fe00000) === 0x1ac00000) {
        var op2 = (word >>> 10) & 63;
        var lhs = big64(gpr(rn));
        var rhs = big64(gpr(rm));
        var bits2 = wide ? 64n : 32n;
        var div;
        if (op2 === 2 || op2 === 3) {
          if ((rhs & ((1n << bits2) - 1n)) === 0n) div = 0n;
          else if (op2 === 2) div = (lhs & ((1n << bits2) - 1n)) / (rhs & ((1n << bits2) - 1n));
          else {
            var sl = lhs & (1n << (bits2 - 1n)) ? lhs - (1n << bits2) : lhs;
            var sr = rhs & (1n << (bits2 - 1n)) ? rhs - (1n << bits2) : rhs;
            div = sr === 0n ? 0n : sl / sr;
            if (div < 0n) div += 1n << bits2;
          }
        } else if (op2 === 8) div = lhs << (rhs & (bits2 - 1n));
        else if (op2 === 9) div = (lhs & ((1n << bits2) - 1n)) >> (rhs & (bits2 - 1n));
        else if (op2 === 10) div = shifted(gpr(rn), 2, Number(rhs & (bits2 - 1n)), wide);
        else if (op2 === 11) div = shifted(gpr(rn), 3, Number(rhs & (bits2 - 1n)), wide);
        else return false;
        div &= (1n << bits2) - 1n;
        wgpr(rd, wide ? num64(div) : Number(div));
        return true;
      }
      if ((word & 0x5fe00000) === 0x5ac00000) {
        var one = (word >>> 10) & 63;
        var src1 = big64(gpr(rn));
        var bits1 = wide ? 64 : 32;
        var single = 0n;
        if (one === 0) {
          var rb;
          for (rb = 0; rb < bits1; rb += 1) if ((src1 >> BigInt(rb)) & 1n) single |= 1n << BigInt(bits1 - 1 - rb);
        } else if (one === 4 || one === 5) {
          var count = 0;
          var scan = one === 4 ? src1 : ~src1;
          var rs;
          for (rs = bits1 - 1; rs >= 0; rs -= 1) {
            if ((scan >> BigInt(rs)) & 1n) break;
            count += 1;
          }
          single = BigInt(count);
        } else if (one === 2 || one === 3) {
          var chunk = one === 3 || !wide ? bits1 : 32;
          var rc;
          for (rc = 0; rc < bits1; rc += 8) {
            var byte = (src1 >> BigInt(rc)) & 0xffn;
            var slot = rc - (rc % chunk) + (chunk - 8 - (rc % chunk));
            single |= byte << BigInt(slot);
          }
        } else return false;
        single &= (1n << BigInt(bits1)) - 1n;
        wgpr(rd, wide ? num64(single) : Number(single));
        return true;
      }
      return false;
    }
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
        var retTo = word === 0xd65f0bff || word === 0xd65f0fff || rn === 30 ? x[30] : reg(rn);
        if (!retTo) {
          stop = "The guest returned through an empty link register.";
          break;
        }
        pc = retTo;
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
      if (is(0x7e000000, 0x34000000)) {
        var compared = (word & 0x80000000) ? gpr(rd) : (gpr(rd) & 0xffffffff);
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
      if ((word & 0x3b000000) === 0x39000000 && (word & 0x04000000) === 0) {
        var usize = (word >>> 30) & 3;
        var uopc = (word >>> 22) & 3;
        var ubytes = 1 << usize;
        var uaddr = reg(rn) + ((word >>> 10) & 0xfff) * ubytes;
        if (uopc === 0) store(uaddr, rd === 31 ? 0 : gpr(rd), ubytes);
        else {
          var uload = load(uaddr, ubytes);
          if ((uopc & 2) !== 0) uload = sxLoad(uload, ubytes, (uopc & 1) !== 0);
          else if (ubytes < 8) uload >>>= 0;
          wgpr(rd, uload);
        }
        pc = next;
        continue;
      }
      if ((word & 0x3b000000) === 0x39000000 && (word & 0x04000000) !== 0) {
        var vsize = ((word >>> 30) & 3) | (((word >>> 22) & 2) << 1);
        var vbytes = 1 << vsize;
        var vaddr = reg(rn) + ((word >>> 10) & 0xfff) * vbytes;
        var vslot = (rd & 31) * 16;
        var vb;
        if (!image.vreg) image.vreg = new Uint8Array(32 * 16);
        if (((word >>> 22) & 1) === 0) {
          for (vb = 0; vb < vbytes; vb += 1) mem.w8(vaddr + vb, image.vreg[vslot + vb] || 0, 1);
        } else {
          for (vb = 0; vb < vbytes; vb += 1) image.vreg[vslot + vb] = mem.u8(vaddr + vb);
        }
        pc = next;
        continue;
      }
      if ((word & 0x3b200c00) === 0x38000000 || (word & 0x3b200c00) === 0x38000400 || (word & 0x3b200c00) === 0x38000c00) {
        var imm9 = sex((word >>> 12) & 0x1ff, 9);
        var modeBits = (word >>> 10) & 3;
        var maddr = reg(rn);
        var msize = 1 << ((word >>> 30) & 3);
        var mopc = (word >>> 22) & 3;
        if (modeBits === 3) maddr += imm9;
        if ((word & 0x04000000) === 0) {
          if (mopc === 0) store(maddr, rd === 31 ? 0 : gpr(rd), msize);
          else {
            var mload = load(maddr, msize);
            if ((mopc & 2) !== 0) mload = sxLoad(mload, msize, (mopc & 1) !== 0);
            else if (msize < 8) mload >>>= 0;
            wgpr(rd, mload);
          }
        }
        if (modeBits === 1) wreg(rn, reg(rn) + imm9);
        if (modeBits === 3) wreg(rn, maddr);
        pc = next;
        continue;
      }
      if ((word & 0x3b200c00) === 0x38200800 && (word & 0x04000000) === 0) {
        var rsize = 1 << ((word >>> 30) & 3);
        var ropc = (word >>> 22) & 3;
        var ropt = (word >>> 13) & 7;
        var ramount = ((word >>> 12) & 1) ? rsize : 1;
        var rval = gpr((word >>> 16) & 31);
        if (ropt === 0 || ropt === 4) rval &= 255;
        if (ropt === 1 || ropt === 5) rval &= 65535;
        if (ropt === 2 || ropt === 6) rval >>>= 0;
        if (ropt >= 4 && ropt <= 6) rval = sex(rval, ropt === 4 ? 8 : ropt === 5 ? 16 : 32);
        var raddr = reg(rn) + rval * ramount;
        if (ropc === 0) store(raddr, rd === 31 ? 0 : gpr(rd), rsize);
        else {
          var rload = load(raddr, rsize);
          if ((ropc & 2) !== 0) rload = sxLoad(rload, rsize, (ropc & 1) !== 0);
          else if (rsize < 8) rload >>>= 0;
          wgpr(rd, rload);
        }
        pc = next;
        continue;
      }
      if ((word & 0x3e000000) === 0x28000000) {
        var pmode = (word >>> 23) & 3;
        var pscale = (word & 0x80000000) ? 8 : 4;
        var poff = sex((word >>> 15) & 0x7f, 7) * pscale;
        var prt2 = (word >>> 10) & 31;
        var paddr = reg(rn);
        if (pmode === 2 || pmode === 3) paddr += poff;
        if ((word >>> 22) & 1) {
          wgpr(rd, pscale === 4 ? load(paddr, 4) >>> 0 : load(paddr, 8));
          wgpr(prt2, pscale === 4 ? load(paddr + pscale, 4) >>> 0 : load(paddr + pscale, 8));
        } else {
          store(paddr, gpr(rd), pscale);
          store(paddr + pscale, gpr(prt2), pscale);
        }
        if (pmode === 1) wreg(rn, reg(rn) + poff);
        if (pmode === 3) wreg(rn, paddr);
        pc = next;
        continue;
      }
      if ((word & 0x7e000000) === 0x36000000) {
        var tbit = ((word >>> 31) << 5) | ((word >>> 19) & 31);
        var tbig = BigInt(Math.trunc(gpr(rd) || 0));
        if (tbig < 0n) tbig += 1n << 64n;
        var tset = Number((tbig >> BigInt(tbit)) & 1n);
        var twant = (word & 0x01000000) ? 1 : 0;
        pc = tset === twant ? pc + sex((word >>> 5) & 0x3fff, 14) * 4 : next;
        continue;
      }
      if (moreArm(word)) {
        pc = next;
        continue;
      }
      if (stop) break;
      stop = "The guest stopped on an unknown instruction " + (word >>> 0).toString(16) + " at " + pc.toString(16);
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
      detail = "The entry returned before it drew a screen.";
    } else detail = stop;
    if (trace.length) detail += " Calls: " + trace.slice(-8).join(", ") + ".";
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
    var model = { tab: "apps", guest: null, error: "", busy: false, shelf: [], booted: 0, query: "", sort: "opened" };
    var icons = {
      apps: "M4 7h7v7H4zM13 7h7v7h-7zM4 16h7v4H4zM13 16h7v4h-7z",
      settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
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
      model.tab = "apps";
      model.error = "";
    }

    function openBuffer(bytes, keep) {
      model.busy = true;
      model.error = "";
      model.tab = "apps";
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
      model.tab = "apps";
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

    function buildStage() {
      var guest = model.guest;
      var stage = el("section", "stage");
      var glass = el("div", "glass");
      var views = guest.screen && guest.screen.views ? guest.screen.views : [];
      var body = el("div", views.length ? "body texts" : "body");
      views.forEach(function (view) { body.appendChild(el("p", "label", view.text)); });
      glass.appendChild(body);
      stage.appendChild(glass);
      return stage;
    }

    function syncStage() {
      var overlay = mount.querySelector(":scope > .stage");
      var views = model.guest && model.guest.screen && model.guest.screen.views ? model.guest.screen.views : [];
      if (model.tab !== "apps" || !views.length) {
        if (overlay) overlay.remove();
        return;
      }
      var stage = buildStage();
      if (overlay) overlay.replaceWith(stage);
      else mount.appendChild(stage);
    }

    function stageMark(stage) {
      if (stage.state === "run") return "Running";
      if (stage.state === "done") return "Done";
      return "Stopped";
    }

    function paintApps() {
      if (model.error) main.appendChild(el("p", "error", model.error));
      var bar = el("div", "bar");
      var plus = el("button", "plus", "+");
      plus.type = "button";
      plus.setAttribute("aria-label", "add");
      plus.disabled = model.busy;
      plus.addEventListener("click", function () { input.click(); });
      bar.appendChild(plus);
      var sort = document.createElement("select");
      sort.className = "sort";
      [["opened", "Last Opened"], ["az", "Name (A–Z)"], ["za", "Name (Z–A)"]].forEach(function (pair) {
        var option = document.createElement("option");
        option.value = pair[0];
        option.textContent = pair[1];
        if (model.sort === pair[0]) option.selected = true;
        sort.appendChild(option);
      });
      sort.addEventListener("change", function () {
        model.sort = sort.value;
        draw();
      });
      bar.appendChild(sort);
      main.appendChild(bar);
      main.appendChild(el("h1", "apps-title", "My Apps"));
      var search = document.createElement("input");
      search.className = "search";
      search.type = "search";
      search.placeholder = "Search";
      search.value = model.query || "";
      search.addEventListener("input", function () {
        model.query = search.value;
        draw();
        var field = mount.querySelector(".search");
        if (field) field.focus();
      });
      main.appendChild(search);
      var needle = (model.query || "").toLowerCase();
      var items = model.shelf.filter(function (item) {
        if (!needle) return true;
        return (item.name + " " + (item.bundleId || "")).toLowerCase().indexOf(needle) !== -1;
      });
      items.sort(function (a, b) {
        if (model.sort === "az") return a.name.localeCompare(b.name);
        if (model.sort === "za") return b.name.localeCompare(a.name);
        return (b.added || 0) - (a.added || 0);
      });
      if (!items.length) main.appendChild(el("p", "empty-note", model.shelf.length ? "No matching apps." : "Press the Plus Button to Install Apps."));
      items.forEach(function (item) {
        var card = el("article", "banner");
        if (item.icon) {
          var img = document.createElement("img");
          img.alt = "";
          img.src = item.icon;
          card.appendChild(img);
        } else card.appendChild(el("span", "banner-fallback", (item.name || "?").slice(0, 1)));
        var copy = el("div", "banner-copy");
        copy.appendChild(el("strong", "", item.name));
        copy.appendChild(el("span", "ver", [item.version, item.bundleId].filter(Boolean).join(" - ")));
        var same = model.guest && model.guest.bundleId === item.bundleId && model.guest.proc;
        copy.appendChild(el("span", "folder", same ? model.guest.proc.home : "Data folder not created yet"));
        card.appendChild(copy);
        var run = el("button", "run-pill", model.busy ? "…" : "Run");
        run.type = "button";
        run.disabled = model.busy;
        run.addEventListener("click", function (event) {
          event.stopPropagation();
          relaunch(item.id);
        });
        card.appendChild(run);
        card.addEventListener("dblclick", function () { model.tab = "settings"; draw(); });
        card.addEventListener("contextmenu", function (event) {
          event.preventDefault();
          forget(item.id);
        });
        main.appendChild(card);
      });
      var count = model.shelf.length;
      main.appendChild(el("p", "count", count === 1 ? "1 App in total" : count + " Apps in total"));
    }

    function paintSettings() {
      main.appendChild(el("h1", "apps-title", "Settings"));
      if (!model.guest) {
        main.appendChild(el("p", "empty-note", "Run an app to see its entry."));
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
      if (guest.libraries && guest.libraries.length) {
        main.appendChild(el("h3", "", "Linked"));
        var chips = el("div", "chips");
        guest.libraries.forEach(function (name) { chips.appendChild(el("span", "chip", name)); });
        main.appendChild(chips);
      }
      if (guest.proc && guest.proc.env) {
        main.appendChild(el("h3", "", "Environment"));
        Object.keys(guest.proc.env).forEach(function (key) {
          var line = el("p", "env");
          line.appendChild(el("span", "key", key));
          line.appendChild(document.createTextNode(guest.proc.env[key]));
          main.appendChild(line);
        });
      }
    }

    function draw() {
      header.replaceChildren();
      main.replaceChildren();
      if (model.tab === "settings") paintSettings();
      else paintApps();
      nav.replaceChildren();
      nav.appendChild(tabButton("apps", "Apps"));
      nav.appendChild(tabButton("settings", "Settings"));
      syncStage();
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
      mount.querySelectorAll(".clock").forEach(function (face) { face.textContent = clock(); });
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
