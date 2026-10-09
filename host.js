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
      p += size;
    }
    var kind = filetype === 2 ? "MH_EXECUTE" : filetype === 6 ? "MH_DYLIB" : filetype === 8 ? "MH_BUNDLE" : "MH_" + filetype;
    return { filetype: kind, cryptid: cryptid, libraries: libs, entry: entry, cpu: "ARM64" };
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
    var stages = [
      { name: "Container", state: "done", detail: bundle },
      { name: "Bundle", state: meta[MARKS.id] ? "done" : "stop", detail: String(meta[MARKS.id] || "Missing identifier") },
      { name: "Executable", state: image ? "done" : "stop", detail: image ? execName + " · " + image.filetype : "Missing or unreadable executable" },
      { name: "Encryption", state: image && !encrypted ? "done" : "stop", detail: !image ? "Unread." : encrypted ? "Store encryption is still on. It was not removed." : "No store encryption on this executable." },
      { name: "Libraries", state: image && !encrypted ? "done" : "stop", detail: image && !encrypted ? (libraries.slice(0, 8).join(", ") || "None listed") : "Unread." },
      { name: "Entry", state: "stop", detail: image && !encrypted ? "The guest entry calls UIApplicationMain. This host does not provide that call." : "Not started." }
    ];
    return {
      name: String(meta[MARKS.display] || meta[MARKS.name] || bundle.replace(/\.app$/, "")),
      bundleId: String(meta[MARKS.id] || ""),
      version: String(meta[MARKS.version] || ""),
      system: String(meta[MARKS.system] || ""),
      icon: iconOf(files),
      stages: stages
    };
  }

  function el(tag, className, textValue) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue) node.textContent = textValue;
    return node;
  }

  function paint(mount, guest, error) {
    var out = mount.querySelector(".out");
    out.replaceChildren();
    if (error) {
      out.appendChild(el("p", "error", error));
      return;
    }
    if (!guest) return;
    var head = el("div", "guest");
    if (guest.icon) {
      var img = document.createElement("img");
      img.alt = "";
      img.src = guest.icon;
      head.appendChild(img);
    }
    var titles = el("div");
    titles.appendChild(el("h2", "", guest.name));
    titles.appendChild(el("p", "muted", [guest.bundleId, guest.version].filter(Boolean).join("  ·  ")));
    head.appendChild(titles);
    out.appendChild(head);
    guest.stages.forEach(function (stage) {
      var row = el("div", "row");
      row.appendChild(el("span", "", stage.name));
      var mark = el("span", stage.state, stage.state === "done" ? "Done" : "Stopped");
      row.appendChild(mark);
      out.appendChild(row);
      out.appendChild(el("p", "detail", stage.detail));
    });
  }

  function start(mount) {
    mount.className = "host";
    mount.replaceChildren();
    var wrap = el("div", "wrap");
    wrap.appendChild(el("h1", "", "Pygu"));
    wrap.appendChild(el("p", "lead", "Open an IPA you own. The host reads the bundle and does not remove store encryption."));
    var button = el("button", "open", "Open IPA");
    button.type = "button";
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".ipa,.zip,application/octet-stream";
    input.style.position = "fixed";
    input.style.left = "-100px";
    input.style.width = "1px";
    input.style.height = "1px";
    var out = el("div", "out");
    button.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      button.disabled = true;
      button.textContent = "Reading";
      file.arrayBuffer().then(openIpa).then(function (guest) {
        paint(mount, guest, "");
      }).catch(function (err) {
        paint(mount, null, err && err.message ? err.message : "The IPA could not be read.");
      }).finally(function () {
        button.disabled = false;
        button.textContent = "Open IPA";
      });
    });
    wrap.appendChild(button);
    wrap.appendChild(input);
    wrap.appendChild(out);
    mount.appendChild(wrap);
    return function () { mount.replaceChildren(); };
  }

  root.PyguHost = { openIpa: openIpa, start: start };
})(typeof globalThis !== "undefined" ? globalThis : this);
