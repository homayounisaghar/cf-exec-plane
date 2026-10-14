"""Level-1 pixel helpers (no OCR, no AI): message direction + unread dot.

Calibrated on fixtures/receive_v1/screen.png (light theme, scale ~1.0409):
- message direction = which side of the row holds the avatar block
  (out: right zone ~1347 non-bg px, left 0; in: the mirror). Bubble color
  is NOT used (images/files are not green).
- unread = red badge pixels (R>200,G<120,B<120) near the avatar top-right
  of a chat-list row (dot rows: 44-47 px; others: 0).
Image source: one X11 window capture (import -> PPM), parsed in pure Python.
"""
from __future__ import annotations

import os
import subprocess
from typing import Optional

from engine import Node, Rect, UIBlocked

AVATAR_MIN = 300     # px of non-background inside a 48-px avatar zone
AVATAR_OTHER_MAX = 100
RED_MIN = 20


class Image:
    def __init__(self, width: int, height: int, data: bytes):
        if len(data) < width * height * 3:
            raise UIBlocked("IMAGE_DATA_SHORT")
        self.width, self.height, self.data = width, height, data

    def getpixel(self, xy):
        x, y = xy
        if not (0 <= x < self.width and 0 <= y < self.height):
            return (0, 0, 0)
        i = (y * self.width + x) * 3
        return (self.data[i], self.data[i + 1], self.data[i + 2])

    @classmethod
    def from_ppm(cls, raw: bytes) -> "Image":
        if not raw.startswith(b"P6"):
            raise UIBlocked("IMAGE_NOT_PPM")
        parts, pos = [], 2
        while len(parts) < 3:
            while raw[pos:pos + 1].isspace():
                pos += 1
            if raw[pos:pos + 1] == b"#":
                pos = raw.index(b"\n", pos) + 1
                continue
            end = pos
            while not raw[end:end + 1].isspace():
                end += 1
            parts.append(int(raw[pos:end]))
            pos = end
        pos += 1
        w, h, maxv = parts
        if maxv != 255:
            raise UIBlocked("IMAGE_PPM_DEPTH")
        return cls(w, h, raw[pos:pos + w * h * 3])


class PilAdapter:
    """Wrap a PIL image (tests / tooling)."""
    def __init__(self, im):
        self.im = im.convert("RGB")
        self.width, self.height = self.im.size
        self._px = self.im.load()

    def getpixel(self, xy):
        x, y = xy
        if not (0 <= x < self.width and 0 <= y < self.height):
            return (0, 0, 0)
        return self._px[x, y]


class Crop:
    """View of a root-screen capture as if it were the window image."""
    def __init__(self, img, x: int, y: int, w: int, h: int):
        self.img, self.x, self.y, self.width, self.height = img, x, y, w, h

    def getpixel(self, xy):
        px, py = xy
        if not (0 <= px < self.width and 0 <= py < self.height):
            return (0, 0, 0)
        return self.img.getpixel((px + self.x, py + self.y))


LAST_CAPTURE = {"method": None, "errors": []}


def _grab(cmd, shell=False):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           stdin=subprocess.DEVNULL, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        LAST_CAPTURE["errors"].append(type(e).__name__)
        return None
    if p.returncode == 0 and p.stdout.startswith(b"P6"):
        try:
            return Image.from_ppm(p.stdout)
        except UIBlocked as e:
            LAST_CAPTURE["errors"].append(e.code)
            return None
    LAST_CAPTURE["errors"].append("rc=%s:%s" % (p.returncode, p.stderr[:120].decode("utf8", "replace")))
    return None


def window_geometry(win_id: str):
    out = subprocess.run(("xdotool", "getwindowgeometry", "--shell", str(win_id)),
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                         timeout=5, check=False).stdout.decode()
    g = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    try:
        return int(g["X"]), int(g["Y"]), int(g["WIDTH"]), int(g["HEIGHT"])
    except (KeyError, ValueError):
        raise UIBlocked("WINDOW_GEOMETRY_UNKNOWN")


def capture_window(win_id: str):
    """One read-only capture of the WeChat main window. Tries the window
    itself, then the whole screen cropped to the window (proven to work live)."""
    LAST_CAPTURE["errors"] = []
    x, y, w, h = window_geometry(win_id)
    disp = os.environ.get("DISPLAY", "")
    if disp:   # ffmpeg is installed on the server; ImageMagick `import` is NOT
        img = _grab(("ffmpeg", "-nostdin", "-v", "error", "-f", "x11grab", "-draw_mouse", "0",
                     "-video_size", "%dx%d" % (w, h), "-i", "%s+%d,%d" % (disp, x, y),
                     "-frames:v", "1", "-f", "image2pipe", "-vcodec", "ppm", "-pix_fmt", "rgb24", "-"))
        if img is not None and img.width == w and img.height == h:
            LAST_CAPTURE["method"] = "ffmpeg_x11grab"
            return img
    img = _grab(("import", "-silent", "-depth", "8", "-window", str(win_id), "ppm:-"))
    if img is not None:
        LAST_CAPTURE["method"] = "window"
        return img
    root = _grab(("import", "-silent", "-depth", "8", "-window", "root", "ppm:-"))
    if root is None:
        root = _grab(("sh", "-c", "xwd -silent -root | convert xwd:- -depth 8 ppm:-"))
    if root is not None and root.width >= x + w and root.height >= y + h:
        LAST_CAPTURE["method"] = "root_crop"
        return Crop(root, x, y, w, h)
    raise UIBlocked("WINDOW_CAPTURE_FAILED")


class Mapper:
    """logical AT-SPI screen coords -> window-relative physical pixels."""
    def __init__(self, frame: Rect, scale: float):
        if frame is None or not (0.5 <= scale <= 3.0):
            raise UIBlocked("MAPPER_ARGS")
        self.frame, self.s = frame, scale

    def box(self, r: Rect, clip: Optional[Rect] = None):
        x0, y0, x1, y1 = r.x, r.y, r.x + r.w, r.y + r.h
        if clip is not None:
            x0, y0 = max(x0, clip.x), max(y0, clip.y)
            x1, y1 = min(x1, clip.x + clip.w), min(y1, clip.y + clip.h)
        f, s = self.frame, self.s
        return (int((x0 - f.x) * s), int((y0 - f.y) * s), int((x1 - f.x) * s), int((y1 - f.y) * s))


def _nonbg(c, bg) -> bool:
    return abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) > 30


def message_direction(img, mapper: Mapper, row: Node, viewport: Rect) -> dict:
    """{"direction": "out"|"in"|"unknown", "left": n, "right": n}."""
    if row.rect is None:
        return {"direction": "unknown", "left": 0, "right": 0}
    x0, y0, x1, y1 = mapper.box(row.rect, viewport)
    if y1 - y0 < 36 or x1 - x0 < 200:
        return {"direction": "unknown", "left": 0, "right": 0}
    bg = img.getpixel((x0 + 4, y0 + 2))
    left = right = 0
    for yy in range(y0, y1):
        for xx in range(x0 + 16, x0 + 65):
            if _nonbg(img.getpixel((xx, yy)), bg):
                left += 1
        for xx in range(x1 - 64, x1 - 15):
            if _nonbg(img.getpixel((xx, yy)), bg):
                right += 1
    if right >= AVATAR_MIN and left <= AVATAR_OTHER_MAX:
        d = "out"
    elif left >= AVATAR_MIN and right <= AVATAR_OTHER_MAX:
        d = "in"
    else:
        d = "unknown"
    return {"direction": d, "left": left, "right": right}


def chat_unread_dot(img, mapper: Mapper, row: Node) -> dict:
    """{"unread_dot": bool|None, "red": n} for one chat-list row."""
    if row.rect is None:
        return {"unread_dot": None, "red": 0}
    x0, y0, x1, y1 = mapper.box(row.rect)
    if y1 - y0 < 40:
        return {"unread_dot": None, "red": 0}
    red = 0
    for yy in range(y0 + 2, y0 + 28):
        for xx in range(x0 + 36, x0 + 62):
            r, g, b = img.getpixel((xx, yy))
            if r > 200 and g < 120 and b < 120:
                red += 1
    return {"unread_dot": red >= RED_MIN, "red": red}


def main_window_and_scale(frame: Rect):
    """Find the unique WeChat X11 window matching frame*scale (read-only)."""
    import os
    pids = subprocess.run(("pgrep", "-u", str(os.getuid()), "-x", "wechat"), stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=5, check=False).stdout.decode().split()
    if len(pids) != 1:
        raise UIBlocked("WECHAT_PID_NOT_UNIQUE")
    wins = subprocess.run(("xdotool", "search", "--onlyvisible", "--pid", pids[0]), stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=5, check=False).stdout.decode().split()
    hits = []
    for w in wins[:20]:
        out = subprocess.run(("xdotool", "getwindowgeometry", "--shell", w), stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=5, check=False).stdout.decode()
        g = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
        try:
            gx, gy, gw, gh = int(g["X"]), int(g["Y"]), int(g["WIDTH"]), int(g["HEIGHT"])
        except (KeyError, ValueError):
            continue
        sx, sy = gw / frame.w, gh / frame.h
        if 0.5 <= sx <= 3 and abs(sx - sy) <= 0.005 and abs(gx - frame.x * sx) <= 3 and abs(gy - frame.y * sx) <= 3:
            hits.append((w, (sx + sy) / 2))
    if len(hits) != 1:
        raise UIBlocked("MAIN_WINDOW_NOT_UNIQUE")
    return hits[0]
