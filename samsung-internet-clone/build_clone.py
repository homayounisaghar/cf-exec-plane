#!/usr/bin/env python3
import hashlib
import struct
import sys
import zlib
import xml.etree.ElementTree as ET
from pathlib import Path

OLD_PKG = "com.sec.android.app.sbrowser"
NEW_PKG = "com.sec.android.app.sbrowse3"
ANDROID = "{http://schemas.android.com/apk/res/android}"

if len(OLD_PKG) != len(NEW_PKG):
    raise SystemExit("package remap must stay equal length")

def read_uleb128(buf, off):
    value = 0
    shift = 0
    start = off
    while True:
        b = buf[off]
        off += 1
        value |= (b & 0x7f) << shift
        if not (b & 0x80):
            return value, off, off - start
        shift += 7
        if shift > 35:
            raise ValueError("bad uleb128")

def dex_strings(path):
    data = bytearray(path.read_bytes())
    if data[:4] != b"dex\n":
        raise ValueError(f"not dex: {path}")
    size = struct.unpack_from("<I", data, 56)[0]
    off = struct.unpack_from("<I", data, 60)[0]
    out = []
    for i in range(size):
        s_off = struct.unpack_from("<I", data, off + i * 4)[0]
        _, p, prefix_len = read_uleb128(data, s_off)
        end = data.index(0, p)
        raw = bytes(data[p:end])
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", "surrogateescape")
        out.append({
            "index": i,
            "text": text,
            "data_off": s_off,
            "payload_off": p,
            "payload_len": end - p,
            "prefix_len": prefix_len,
        })
    return data, out

def utf16_key(s):
    b = s.encode("utf-16-be", "surrogatepass")
    return tuple((b[i] << 8) | b[i+1] for i in range(0, len(b), 2))

def ordered(prev_s, cur_s, next_s):
    ck = utf16_key(cur_s)
    if prev_s is not None and not (utf16_key(prev_s) < ck):
        return False
    if next_s is not None and not (ck < utf16_key(next_s)):
        return False
    return True

def load_dex_contexts(dex_paths):
    contexts = {}
    for p in dex_paths:
        data, strings = dex_strings(p)
        contexts[p] = (data, strings)
    return contexts

def occurrences(contexts, authority):
    hits = []
    for p, (_, strings) in contexts.items():
        for i, item in enumerate(strings):
            if authority in item["text"]:
                hits.append((p, i))
    return hits

def candidate_alias(authority, contexts, used):
    if authority == OLD_PKG:
        raise ValueError("root package must not be provider-remapped")

    preferred = []
    if authority.endswith(".mostvisited"):
        preferred.append(authority[:-1] + "3")

    last_dot = authority.rfind(".")
    positions = list(range(len(authority)-1, max(last_dot, 0), -1))
    chars = "3452678901abcdefghijklmnopqrstuvwxyz_"
    for pos in positions:
        orig = authority[pos]
        for ch in chars:
            if ch == orig:
                continue
            cand = authority[:pos] + ch + authority[pos+1:]
            if len(cand) != len(authority) or cand in used:
                continue
            preferred.append(cand)

    seen = set()
    for cand in preferred:
        if cand in seen or cand in used:
            continue
        seen.add(cand)
        ok = True
        for p, i in occurrences(contexts, authority):
            strings = contexts[p][1]
            old_text = strings[i]["text"]
            new_text = old_text.replace(authority, cand)
            prev_s = strings[i-1]["text"] if i > 0 else None
            next_s = strings[i+1]["text"] if i+1 < len(strings) else None
            if not ordered(prev_s, new_text, next_s):
                ok = False
                break
        if ok:
            return cand
    raise RuntimeError(f"no lexically safe equal-length alias for {authority}")

def patch_dexes(contexts, mapping):
    patched_counts = {}
    for p, (data, strings) in contexts.items():
        count = 0
        for item in strings:
            old_text = item["text"]
            new_text = old_text
            for old, new in mapping.items():
                if old in new_text:
                    new_text = new_text.replace(old, new)
            if new_text == old_text:
                continue
            old_raw = old_text.encode("utf-8", "surrogateescape")
            new_raw = new_text.encode("utf-8", "surrogateescape")
            if len(old_raw) != len(new_raw) or len(new_raw) != item["payload_len"]:
                raise RuntimeError(f"unsafe DEX string length change in {p.name}: {old_text!r}")
            start = item["payload_off"]
            data[start:start+len(new_raw)] = new_raw
            count += 1

        data[12:32] = hashlib.sha1(data[32:]).digest()
        checksum = zlib.adler32(data[12:]) & 0xffffffff
        struct.pack_into("<I", data, 8, checksum)
        p.write_bytes(data)
        patched_counts[p.name] = count

        _, new_strings = dex_strings(p)
        for i in range(1, len(new_strings)):
            if not utf16_key(new_strings[i-1]["text"]) < utf16_key(new_strings[i]["text"]):
                raise RuntimeError(
                    f"DEX string order broken in {p.name} at {i-1}/{i}: "
                    f"{new_strings[i-1]['text']!r} >= {new_strings[i]['text']!r}"
                )
    return patched_counts

def patch_manifest(manifest_path, mapping):
    ET.register_namespace("android", "http://schemas.android.com/apk/res/android")
    tree = ET.parse(manifest_path)
    root = tree.getroot()
    if root.attrib.get("package") != OLD_PKG:
        raise RuntimeError(f"unexpected manifest package: {root.attrib.get('package')}")
    root.set("package", NEW_PKG)

    root.attrib.pop(ANDROID + "sharedUserId", None)
    root.attrib.pop(ANDROID + "sharedUserLabel", None)

    for tag in ("permission", "permission-tree", "permission-group",
                "uses-permission", "uses-permission-sdk-23", "uses-permission-sdk-m"):
        for el in root.findall(tag):
            name = el.attrib.get(ANDROID + "name", "")
            if name.startswith(OLD_PKG + "."):
                el.set(ANDROID + "name", NEW_PKG + name[len(OLD_PKG):])

    app = root.find("application")
    if app is None:
        raise RuntimeError("application missing")

    app.set(ANDROID + "label", "Samsung Internet Green Clone")

    provider_count = 0
    for provider in app.findall("provider"):
        auth = provider.attrib.get(ANDROID + "authorities")
        if auth:
            parts = auth.split(";")
            changed = False
            for i, part in enumerate(parts):
                if part in mapping:
                    parts[i] = mapping[part]
                    changed = True
            if changed:
                provider.set(ANDROID + "authorities", ";".join(parts))
                provider_count += 1

        for attr in ("permission", "readPermission", "writePermission"):
            key = ANDROID + attr
            val = provider.attrib.get(key, "")
            if val.startswith(OLD_PKG + ".permission."):
                provider.set(key, NEW_PKG + val[len(OLD_PKG):])

    for el in list(app):
        key = ANDROID + "permission"
        val = el.attrib.get(key, "")
        if val.startswith(OLD_PKG + ".permission."):
            el.set(key, NEW_PKG + val[len(OLD_PKG):])

    tree.write(manifest_path, encoding="utf-8", xml_declaration=True)
    return provider_count

def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: build_clone.py <apktool-decoded-dir>")
    work = Path(sys.argv[1])
    manifest = work / "AndroidManifest.xml"
    dex_paths = sorted(work.glob("classes*.dex"))
    if not manifest.exists() or not dex_paths:
        raise SystemExit("decoded manifest/dex missing")

    tree = ET.parse(manifest)
    root = tree.getroot()
    app = root.find("application")
    authorities = []
    if app is None:
        raise RuntimeError("application missing")
    for provider in app.findall("provider"):
        raw = provider.attrib.get(ANDROID + "authorities", "")
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(OLD_PKG + ".") and "\${" not in part and "@" not in part:
                authorities.append(part)
    authorities = sorted(set(authorities))

    contexts = load_dex_contexts(dex_paths)
    active = [a for a in authorities if occurrences(contexts, a)]
    used = set(authorities)
    mapping = {}
    for authority in active:
        alias = candidate_alias(authority, contexts, used)
        mapping[authority] = alias
        used.add(alias)

    for authority in authorities:
        if authority in mapping:
            continue
        last = authority[-1]
        cand = authority[:-1] + ("3" if last != "3" else "4")
        n = 4
        while cand in used or len(cand) != len(authority):
            cand = authority[:-1] + str(n % 10)
            n += 1
        mapping[authority] = cand
        used.add(cand)

    mv = OLD_PKG + ".mostvisited"
    if mv in mapping and mapping[mv] != OLD_PKG + ".mostvisite3":
        raise RuntimeError(f"mostvisited mapping drift: {mapping[mv]}")

    patched = patch_dexes(contexts, mapping)
    provider_count = patch_manifest(manifest, mapping)

    tree2 = ET.parse(manifest)
    app2 = tree2.getroot().find("application")
    collisions = []
    if app2 is not None:
        for p in app2.findall("provider"):
            for part in p.attrib.get(ANDROID + "authorities", "").split(";"):
                if part in authorities:
                    collisions.append(part)
    if collisions:
        raise RuntimeError(f"provider authority collisions remain: {collisions}")

    report = work / "CLONE_PATCH_REPORT.txt"
    lines = [
        f"package={NEW_PKG}",
        f"source_package={OLD_PKG}",
        f"dex_files={len(dex_paths)}",
        f"provider_authorities_total={len(authorities)}",
        f"provider_authorities_active_in_dex={len(active)}",
        f"providers_manifest_changed={provider_count}",
        "runtime_root_package_literal_broad_rewrite=false",
        "external_queries_provider_rewrite=false",
        "",
        "[provider_mapping]",
    ]
    lines += [f"{k} -> {v}" for k, v in sorted(mapping.items())]
    lines += ["", "[dex_string_patch_counts]"]
    lines += [f"{k}={v}" for k, v in sorted(patched.items())]
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(report.read_text())

if __name__ == "__main__":
    main()
