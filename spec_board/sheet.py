#!/usr/bin/env python3
"""Working Board 서버 — 워크스페이스마다 spec/ 아래 티켓을 보드로 보여 주고, 사람 칸만 저장한다.

원본은 행·노드 사람 칸·ticket.json 파일이다. 칸 규칙은 skills/spec/rows.md.

  sheet.py [레포 ...] [--port 8790] [--host 127.0.0.1] [--allow-host <이름>]   서버
  sheet.py apply <스펙 폴더>                 사람이 찬 칸을 JSON으로 낸다. 비우지 않는다 (에이전트 턴 시작)
                                             kind: decision·task(rows/*.json) · node(rows/nodes/*.json: verdict·fix) ·
                                             ticket(ticket.json: priority·paused). 낸 내용은 ~/.cache/spec-sheet/applied/ 에도 남는다
  sheet.py pending <스펙 폴더>               반영할 사람 입력이 있는지만 본다 — id·kind 개수만 내고 사람 글은 내지 않는다. 기록도 안 남긴다
  sheet.py wait <스펙 폴더> [--timeout 초]   반영할 입력이 생기거나 멈춤이 바뀔 때까지 기다린다. 생기면 종료 0, 시간이 다 되면 3
  sheet.py patch <스펙 폴더> <id> '<json>'   user 밖 칸을 잠금 아래 고친다. id = 행 id · 노드 key · ticket. "log+"는 기록 한 줄 추가
                                             '<json>' 자리에 `-`를 주면 표준입력에서 읽는다 — 사람 글이 든 JSON은 이 길로
                                             "ack": <apply가 낸 그 항목의 user> — 반영을 마친 행 칸만 비운다
                                             (ticket은 서 있는 설정이라 안 비운다. 노드는 ack를 거부한다 — 반영은 node_state.py verdict)
  sheet.py link <스펙 폴더>                  폰에서 열 주소(보드 Inbox)
  GET  /api/board?w=<워크스페이스>            보드 모델(프로젝트→티켓→노드·행). spec_model.py가 계산한다. w가 없으면 워크스페이스 목록만
  GET  /api/version?w=<워크스페이스>          보드 버전만 {"v": …} — 화면이 몇 초마다 묻고 바뀌었을 때만 보드를 받는다
  GET  /w/<w>/api/spec?sheet=                                 티켓 spec.md 전문 (티켓 모달이 열릴 때)
  POST /w/<w>/api/user   {sheet,id,user:{answer,fix},base}    rows/<id>.json 사람 칸 (결정 답)
  POST /w/<w>/api/node   {sheet,id,user:{verdict,fix},base}   rows/nodes/<id>.json 사람 칸 (D3)
  POST /w/<w>/api/ticket {sheet,user:{priority,paused,archived},base}  ticket.json 사람 칸 (D5)
  GET  /w/<w>/api/commits?sheet=&id=                          노드 브리프에 적힌 커밋 해시를 git으로 확인해 낸다
  GET  /w/<w>/api/evidence?sheet=&id=&name=                   티켓 evidence/<노드>/ 안의 이미지(png·jpg·webp·gif)만. 그 밖은 404
  GET  /board/ · /w/<w>/board/                                보드 화면(board_web/)을 낸다. .html .js .css만, 폴더 밖은 404.
                                                              ETag·Last-Modified(304), Accept-Encoding: gzip이면 압축
  GET  /  · /w/<w>/                                           옛 결정 시트 주소 — 302로 /board/ · /w/<w>/board/
  sheet.py install-launchd                   로그인하면 서버가 뜨게 한다

워크스페이스 = ~/.config/spec-sheet/roots ∪ 인자. 5초마다 다시 읽는다. 등록은 `spec-board add <레포>`.
주소 키는 레포 폴더 이름이다. 링크된 워크트리는 늘 "<이름>-<워크트리 폴더>"(예: my-repo-d01e), 그 밖에 이름이 겹치면 "<상위폴더>-<이름>".
원격: `tailscale serve --bg --https=8443 8790` 로 tailnet에만 연다. 인증이 없으니 0.0.0.0에 바인딩하지 않는다.
응답마다 Content-Security-Policy(default-src 'self'; frame-ancestors 'none')·X-Content-Type-Options: nosniff를 붙이고,
요청은 10초 안에 오지 않으면 끊는다. POST는 Host·Origin·형식을 본 뒤에야 본문을 읽는다.
"""
from __future__ import annotations

import contextlib
import errno
import fcntl
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from email.utils import formatdate, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote

# 칸 규칙·사람 칸 검사·보드 계산은 spec_model이 갖는다 (D8)
from spec_model import (NODE_USER_KEYS, TICKET_USER_KEYS, board_version, brief_path, build_board, clean_node_user, sheet_summary,
                        clean_path, clean_ticket_user, find_tickets, json_files, node_file, node_keys, read_spec_md,
                        ticket_file)

HOME = Path.home()
CONF = HOME / ".config/spec-sheet/roots"
USER_KEYS = ("answer", "fix")
MAX_TEXT = 4000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
KEY_RE = re.compile(r"^[^/\\]{1,80}$")
LABEL = "com.spec-board"


class Conflict(Exception):
    def __init__(self, user: dict):
        self.user = user


# ── 레지스트리 ────────────────────────────────────────────────

def assign_keys(paths: list[Path]) -> dict[str, Path]:
    """주소 키. 링크된 워크트리(.git이 파일)는 늘 "<이름>-<워크트리 폴더>"라 다른 워크트리가 생기거나 없어져도 주소가 그대로다.
    나머지는 폴더 이름, 겹치면 "<상위폴더>-<이름>"."""
    by_name: dict[str, list[Path]] = {}
    out: dict[str, Path] = {}
    for p in sorted(paths):
        if (p / ".git").is_file():
            k = f"{p.name}-{p.parent.name}"
            while k in out:
                k += "-2"
            out[k] = p
        else:
            by_name.setdefault(p.name, []).append(p)
    for name, ps in by_name.items():
        for n, p in enumerate(ps):
            k = name if n == 0 else f"{p.parent.name}-{name}"
            while k in out:
                k += "-2"
            out[k] = p
    return out


class Registry:
    def __init__(self, extra: list[Path]):
        self.extra = extra
        self._at, self._roots = 0.0, {}
        self._mu = threading.Lock()

    def roots(self) -> dict[str, Path]:
        with self._mu:
            if time.time() - self._at < 5:
                return self._roots
            paths: list[Path] = []
            if CONF.exists():
                paths += [Path(l.strip()).expanduser() for l in CONF.read_text().splitlines() if l.strip() and not l.startswith("#")]
            paths += self.extra
            seen, uniq = set(), []
            for p in paths:
                p = p.resolve()
                if p.is_dir() and p not in seen:
                    seen.add(p)
                    uniq.append(p)
            self._roots, self._at = assign_keys(uniq), time.time()
            return self._roots


_SHEETS: dict[str, tuple] = {}   # 워크스페이스 키 → (보드 버전, 시트 요약 목록)
_SHEETS_MU = threading.Lock()


def all_sheets(reg: "Registry") -> list[dict]:
    """사이드바용 시트 목록 — 워크스페이스마다 보드 버전이 바뀐 곳만 다시 읽는다. 마지막 웨이브가 최근인 순."""
    out = []
    for key, root in reg.roots().items():
        v = board_version(root)
        with _SHEETS_MU:
            hit = _SHEETS.get(key)
        if not hit or hit[0] != v:
            board = build_board(root)
            rows = [{**sheet_summary(t), "workspace": key, "repo": root.name}
                    for p in board["projects"] for t in p["tickets"]]
            hit = (v, rows)
            with _SHEETS_MU:
                _SHEETS[key] = hit
        out += hit[1]
    return sorted(out, key=lambda r: r["last"], reverse=True)


def repos_info(reg: "Registry", port: int) -> dict:
    """Repos & 서비스 화면 — 등록된 워크스페이스별 시트 수와 보드 서비스(포트·버전)."""
    try:
        from importlib.metadata import version
        ver = version("spec-board")
    except Exception:
        ver = ""
    sheets = all_sheets(reg)
    rows = []
    for key, root in reg.roots().items():
        mine = [x for x in sheets if x["workspace"] == key]
        rows.append({"workspace": key, "root": str(root), "repo": root.name, "sheets": len(mine),
                     "archived": sum(1 for x in mine if x.get("archived"))})
    return {"service": {"port": port, "version": ver}, "workspaces": rows}


def find_sheets(root: Path) -> dict[str, Path]:
    spec = root / "spec"
    if not spec.is_dir():
        return {}
    out = {}
    for p in sorted(spec.rglob("rows")):
        if p.is_dir() and clean_path(spec, p) and json_files(p, p.parent):   # 심볼릭 링크 rows/는 시트로 치지 않는다
            out[str(p.parent.relative_to(spec))] = p.parent
    return out


# ── 잠금과 쓰기 ───────────────────────────────────────────────

def open_lock(path: Path):
    """잠금 파일을 연다. 그 자리가 심볼릭 링크면 따라가지 않고 거부한다 — 폴더 밖 파일을 만들거나 건드리지 않게."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o644)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise ValueError(f"잠금 파일이 심볼릭 링크다: {path.name}") from e
        raise
    return os.fdopen(fd, "a")


def require_clean(base: Path, f: Path) -> None:
    """읽기·쓰기 전에 f가 base 안의 실제 경로인지 본다. 심볼릭 링크거나 밖을 가리키면 ValueError(→ 400)."""
    if not clean_path(base, f):
        raise ValueError(f"심볼릭 링크이거나 폴더 밖이라 쓰지 않는다: {f.name}")


@contextlib.contextmanager
def locked(sheet: Path):
    require_clean(sheet, sheet / "rows")
    with open_lock(sheet / "rows" / ".lock") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def row_file(sheet: Path, row_id: str) -> Path:
    if not ID_RE.match(row_id):
        raise ValueError("bad id")
    f = sheet / "rows" / f"{row_id}.json"
    if not f.exists() or not clean_path(sheet, f):   # 심볼릭 링크 행은 없는 행이다
        raise KeyError(row_id)
    return f


def write_json(f: Path, r: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=f.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as w:
        json.dump(r, w, ensure_ascii=False, indent=2)
        w.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, f)


def save_user(sheet: Path, row_id: str, patch: dict, base: dict | None) -> dict:
    """base가 있으면 그 칸의 지금 값이 base와 같을 때만 쓴다 — 다른 곳에서 바꾼 답을 조용히 덮지 않는다."""
    f = row_file(sheet, row_id)
    with locked(sheet):
        r = json.loads(f.read_text(encoding="utf-8"))
        user = r.setdefault("user", {})
        if base:
            for k in USER_KEYS:
                if k in patch and k in base and user.get(k, "") != base[k]:
                    raise Conflict(user)
        for k in USER_KEYS:
            if k in patch:
                user[k] = str(patch[k])[:MAX_TEXT]
        write_json(f, r)
    return r


def save_extra(ticket: Path, f: Path, seed: dict, keys: tuple, defaults: dict, patch: dict, base: dict | None) -> dict:
    """노드 사람 칸(rows/nodes/nN.json)과 ticket.json 쓰기. 행 파일과 같은 잠금(rows/.lock)·같은 base 충돌 규칙이다.
    파일이 없으면 seed로 만든다 — 사람 칸 밖은 에이전트 몫이라 seed는 id뿐이다."""
    require_clean(ticket, ticket / "rows")
    require_clean(ticket, f)
    (ticket / "rows").mkdir(exist_ok=True)
    with locked(ticket):
        if f.exists():
            r = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(r, dict):
                raise ValueError(f"{f.name}이 객체가 아니다")
        else:
            r = dict(seed)
        # 칸이 빠진 파일도 완전한 모양으로 쓴다 — 읽는 쪽이 칸 유무를 가르지 않게
        user = r["user"] = {**defaults, **(r["user"] if isinstance(r.get("user"), dict) else {})}
        if base:
            for k in keys:
                if k in patch and k in base and user.get(k, defaults[k]) != base[k]:
                    raise Conflict({**defaults, **user})
        user.update(patch)
        f.parent.mkdir(parents=True, exist_ok=True)
        write_json(f, r)
    return r


def save_node_user(ticket: Path, key: str, patch: dict, base: dict | None) -> dict:
    if key not in node_keys(ticket):
        raise KeyError(f"node {key}")
    return save_extra(ticket, node_file(ticket, key), {"id": key}, NODE_USER_KEYS,
                      {"verdict": "", "fix": ""}, clean_node_user(patch), base)


def save_ticket_user(ticket: Path, patch: dict, base: dict | None) -> dict:
    ensure_ticket_ignored(ticket)   # 이 파일이 처음 생기기 전에 제외해 둔다
    return save_extra(ticket, ticket_file(ticket), {}, TICKET_USER_KEYS,
                      {"priority": "", "paused": False, "archived": False}, clean_ticket_user(patch), base)


# ── 접근 규칙 ────────────────────────────────────────────────
# 인증 없는 서버다. 요청마다 Host를 허용 목록과 대조해 DNS 재바인딩을 막고, 상태를 바꾸는 POST는 Origin이 있으면
# Host와 같아야 하며 application/json만 받는다(다른 사이트의 form·text/plain 단순 요청을 거른다).
# tailscale serve는 tailnet 요청을 127.0.0.1로 넘겨 주므로 접속 주소만 보면 원격이 로컬로 보인다.
# 그래서 Host가 루프백이고 프록시 머리말이 없을 때만 로컬로 친다.

LOOPBACK_IPS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
HOSTS_CONF = HOME / ".config/spec-sheet/hosts"   # 한 줄에 이름 하나. 서버를 다시 띄우면 읽는다
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded",
                 "tailscale-user-login", "tailscale-user-name")


def host_name(value: str) -> str:
    """Host 머리말에서 포트를 뗀 소문자 이름. `[::1]:8790` → `[::1]`."""
    h = (value or "").strip().lower()
    if h.startswith("["):
        return h[:h.find("]") + 1] if "]" in h else h
    return h.rsplit(":", 1)[0] if ":" in h else h


def load_allowed_hosts(extra=()) -> set[str]:
    """루프백 + 이 기기의 tailnet 이름(tailscale에서 읽는다).
    더하는 길: ~/.config/spec-sheet/hosts, SPEC_SHEET_HOSTS(쉼표), --allow-host."""
    out = set(LOOPBACK_HOSTS)
    try:
        st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=3).stdout)
        out.add(st["Self"]["DNSName"].rstrip(".").lower())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        pass
    names = list(extra) + [t for t in os.environ.get("SPEC_SHEET_HOSTS", "").split(",")]
    try:
        names += [l for l in HOSTS_CONF.read_text(encoding="utf-8").splitlines() if not l.lstrip().startswith("#")]
    except OSError:
        pass
    return out | {host_name(n) for n in names if n.strip()}


def host_allowed(headers, allowed: set[str]) -> bool:
    return host_name(headers.get("Host") or "") in allowed


def origin_matches(headers) -> bool:
    """Origin이 없으면(주소창·curl) 통과, 있으면 Host와 같은 곳에서 온 것만."""
    origin = headers.get("Origin")
    if origin is None:
        return True
    return origin.split("://", 1)[-1].strip().lower() == (headers.get("Host") or "").strip().lower()


def is_json_request(headers) -> bool:
    return (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() == "application/json"


def is_local_request(client_ip: str, headers) -> bool:
    if client_ip not in LOOPBACK_IPS:
        return False
    if any(headers.get(h) for h in PROXY_HEADERS):
        return False
    if host_name(headers.get("Host") or "") not in LOOPBACK_HOSTS:
        return False
    return origin_matches(headers)  # 다른 사이트가 이 주소로 쏜 요청을 거른다


# ── 보드 화면 · 커밋 ──────────────────────────────────────────

HASH_RE = re.compile(r"`([0-9a-f]{7,40})`")

# 보드 화면 파일 — board_web/ 바로 아래의 이 확장자만 낸다 (테스트·메모·다른 폴더는 안 나간다)
BOARD_WEB = Path(__file__).resolve().parent / "board_web"
BOARD_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
BOARD_PATH_RE = re.compile(r"(?:/w/([^/]+))?/board(?:/([^/]*))?")
BOARD_NAME_RE = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}")


def board_asset(name: str, root: Path | None = None) -> tuple[bytes, str, int] | None:
    """`/board/<name>`이 가리키는 파일 (내용, 형식, 수정 시각 ns). 허용 밖이면 None (→ 404). name은 디코딩하지 않은 그대로 받는다."""
    root = (root or BOARD_WEB).resolve()
    name = name or "index.html"
    if not BOARD_NAME_RE.fullmatch(name):   # 슬래시·퍼센트·점으로 시작하는 이름은 여기서 끝난다
        return None
    ctype = BOARD_TYPES.get(Path(name).suffix)
    if ctype is None:
        return None
    f = (root / name).resolve()
    if f.parent != root or not f.is_file():   # 심볼릭 링크로 밖을 가리켜도 막힌다
        return None
    try:
        return f.read_bytes(), ctype, f.stat().st_mtime_ns
    except OSError:
        return None


def board_node(root: Path, slug: str, key: str) -> dict:
    for p in build_board(root)["projects"]:
        for t in p["tickets"]:
            if t["slug"] == slug:
                for n in t["nodes"]:
                    if n["key"] == key:
                        return n
    raise KeyError(f"node {key}")


def node_commits(root: Path, ticket: Path, slug: str, key: str) -> list[dict]:
    """브리프에 `해시`로 적힌 커밋을 git으로 확인한다. 적힌 게 없으면 빈 목록이다 — 짐작하지 않는다."""
    brief = brief_path(ticket, board_node(root, slug, key)["brief"])
    if brief is None:   # 티켓 폴더 밖을 가리키는 표 — 읽지 않는다
        return []
    try:
        text = brief.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out, seen = [], set()
    for h in HASH_RE.findall(text):
        if h in seen:
            continue
        seen.add(h)
        r = subprocess.run(["git", "-C", str(root), "show", "-s", "--format=%h%x1f%s", h],
                           capture_output=True, text=True, timeout=10)
        short, _, subject = r.stdout.strip().partition("\x1f")
        out.append({"hash": short or h[:8], "subject": subject, "verified": r.returncode == 0 and bool(short)})
    return out


EVIDENCE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
EVIDENCE_MAX = 20 * 1024 * 1024


def evidence_image(ticket: Path, key: str, name: str) -> tuple[bytes, str]:
    """티켓의 evidence/<노드>/<이름> 이미지. 노드 id 꼴·이미지 확장자·폴더 안의 실제 파일이 아니면 KeyError(404)."""
    ctype = EVIDENCE_TYPES.get(Path(name).suffix.lower())
    if (ctype is None or not ID_RE.match(key) or not name or name.startswith(".")
            or any(c in name for c in "/\\\x00")):
        raise KeyError("evidence")
    f = ticket / "evidence" / key / name
    if not clean_path(ticket, f) or not f.is_file():   # 심볼릭 링크 구간·폴더 밖·없는 파일
        raise KeyError("evidence")
    if f.stat().st_size > EVIDENCE_MAX:
        raise KeyError("evidence")
    return f.read_bytes(), ctype


JOURNAL = HOME / ".cache/spec-sheet/applied"


def _load(f: Path) -> dict:
    r = json.loads(f.read_text(encoding="utf-8"))
    if not isinstance(r, dict):
        raise ValueError(f"{f.name}이 객체가 아니다")
    return r


def _filled(u: dict, keys: tuple) -> bool:
    return any(str(u.get(k, "")).strip() for k in keys)


def apply_sheet(sheet: Path) -> list[dict]:
    """사용자가 찬 칸을 낸다. 비우지 않는다 — 비우기는 반영을 마친 항목마다 patch의 "ack"가 한다.
    출력이 잘리거나 에이전트가 반영 전에 죽어도 답은 파일에 그대로 남고, 다시 apply하면 또 나온다.
    항목은 kind로 가른다.
      decision·task  rows/*.json           user.answer·user.fix
      node           rows/nodes/<노드>.json user.verdict·user.fix  (반영은 node_state.py verdict)
      ticket         ticket.json           user.priority·user.paused — 서 있는 설정이라 ack가 비우지 않는다
    낸 내용은 JOURNAL에도 한 벌 남긴다."""
    out = user_items(sheet)
    if out:
        JOURNAL.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^\w.-]+", "_", str(sheet.relative_to(sheet.anchor)))
        (JOURNAL / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(
            json.dumps({"sheet": str(sheet), "rows": out}, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def user_items(sheet: Path) -> list[dict]:
    """사람이 찬 칸을 읽기만 한다 — apply·pending·wait가 같이 쓴다."""
    out = []
    with locked(sheet):
        for f in json_files(sheet / "rows", sheet):
            r = _load(f)
            u = r.get("user") or {}
            if any(str(v).strip() for v in u.values()):
                out.append({k: r.get(k) for k in ("id", "kind", "title", "options", "recommend", "status")} | {"user": u})
        for f in json_files(sheet / "rows" / "nodes", sheet):
            r = _load(f)
            u = r.get("user") if isinstance(r.get("user"), dict) else {}
            if _filled(u, NODE_USER_KEYS):
                out.append({"id": str(r.get("id") or f.stem), "kind": "node", "user": {k: u.get(k, "") for k in NODE_USER_KEYS}})
        tf = ticket_file(sheet)
        if tf.exists() and clean_path(sheet, tf):
            u = _load(tf).get("user")
            u = u if isinstance(u, dict) else {}
            if str(u.get("priority", "")).strip() or u.get("paused") is True:
                out.append({"id": "ticket", "kind": "ticket", "standing": True,
                            "user": {"priority": str(u.get("priority", "")), "paused": u.get("paused") is True}})
    return out


def pending(sheet: Path) -> dict:
    """반영할 입력 요약. 서 있는 설정(ticket)은 세지 않고 paused만 따로 알린다. 사람 글은 싣지 않는다 —
    이 출력은 에이전트 명령 결과로 그대로 읽히니, 글은 apply 출력 파일로만 건넨다."""
    items = user_items(sheet)
    todo = [{"id": it["id"], "kind": it["kind"]} for it in items if not it.get("standing")]
    paused = any(it["kind"] == "ticket" and it["user"].get("paused") for it in items)
    return {"pending": len(todo), "items": todo, "paused": paused}


def wait_pending(sheet: Path, timeout: float, every: float = 2.0) -> tuple[dict, bool]:
    """반영할 입력이 생기거나 멈춤이 바뀔 때까지 본다. (요약, 시간 다 됨) 을 돌려준다."""
    first = pending(sheet)
    if first["pending"]:
        return first, False
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        time.sleep(min(every, max(0.0, end - time.monotonic())))
        now = pending(sheet)
        if now["pending"] or now["paused"] != first["paused"]:
            return now, False
    return pending(sheet), True


def ack_user(r: dict, seen: dict, keys: tuple = USER_KEYS) -> list[str]:
    """apply 때 본 값(seen)과 지금 값이 같은 칸만 비운다. 그 사이 사용자가 고친 칸은 남겨 다음 apply에 다시 나오게 한다.
    비운 값은 log에 남겨 답이 기록에서 사라지지 않게 한다."""
    if not isinstance(seen, dict):
        raise ValueError('"ack"에는 apply가 낸 그 항목의 user 객체를 그대로 넣는다')
    user = r.setdefault("user", {})
    kept = []
    for k in keys:
        now = user.get(k, "")
        if not str(now).strip():
            continue
        if k in seen and now == seen[k]:
            r.setdefault("log", []).append(f"{time.strftime('%Y-%m-%d')} user.{k} 반영: {now}")
            user[k] = ""
        else:
            kept.append(k)
    return kept


def locate(sheet: Path, item_id: str) -> tuple[str, Path]:
    """patch가 가리키는 파일. 행(rows/<id>.json) → 노드 사람 칸(rows/nodes/<id>.json) → `ticket`(ticket.json)."""
    if not ID_RE.match(item_id):
        raise ValueError("bad id")
    f = sheet / "rows" / f"{item_id}.json"
    if f.exists() and clean_path(sheet, f):
        return "row", f
    nf = sheet / "rows" / "nodes" / f"{item_id}.json"
    if nf.exists() and clean_path(sheet, nf):
        return "node", nf
    if item_id == "ticket" and ticket_file(sheet).exists() and clean_path(sheet, ticket_file(sheet)):
        return "ticket", ticket_file(sheet)
    raise KeyError(item_id)


def patch_row(sheet: Path, row_id: str, patch: dict) -> dict:
    """행·노드 사람 칸·ticket.json을 같은 잠금(rows/.lock) 아래 고친다. ack는 같은 값일 때만 비운다.
    ticket.json의 priority·paused는 서 있는 설정이다 — ack는 받되 비우지 않고 `_standing`으로 알린다."""
    kind, f = locate(sheet, row_id)
    kept: list[str] = []
    standing = False
    with locked(sheet):
        r = _load(f)
        for k, v in patch.items():
            if k == "user":
                raise ValueError('user 칸은 화면 몫이다 — 반영을 마쳤으면 "ack"로 비운다')
            if k == "ack":
                if kind == "node":   # 노드 칸은 브리프 반영과 한 묶음으로 비워야 한다 — ack만 하면 반영 없이 답이 사라진다
                    raise ValueError("노드 항목은 patch ack로 비우지 않는다 — "
                                     "node_state.py verdict <브리프>가 브리프에 반영하고 칸을 비운다")
                if kind == "ticket":
                    if not isinstance(v, dict):
                        raise ValueError('"ack"에는 apply가 낸 그 항목의 user 객체를 그대로 넣는다')
                    standing = True
                else:
                    kept = ack_user(r, v, USER_KEYS)
            elif k == "log+":
                r.setdefault("log", []).append(str(v))
            elif kind != "row":
                raise ValueError(f"{kind} 항목은 {'log+만' if kind == 'node' else 'ack·log+만'} 고친다: {k}")
            else:
                r[k] = v
        write_json(f, r)
    if kept:
        r["_kept"] = kept
    if standing:
        r["_standing"] = True
    return r


# ── HTTP ─────────────────────────────────────────────────────

GZIP_MIN = 1024   # 이보다 작으면 압축이 이득이 아니다


def accepts_gzip(header: str | None) -> bool:
    """Accept-Encoding에 gzip이 있고 q=0이 아닐 때."""
    for part in (header or "").split(","):
        name, _, params = part.strip().partition(";")
        if name.strip().lower() in ("gzip", "x-gzip"):
            q = re.search(r"q\s*=\s*([0-9.]+)", params)
            try:
                return float(q.group(1)) > 0 if q else True
            except ValueError:
                return True
    return False


# 모든 응답에 붙는다 — 자기 주소의 글만 불러오고, 다른 페이지에 끼워 넣지 못하게, 형식을 짐작하지 않게.
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
}
REQUEST_TIMEOUT = 10   # 초. 느리게 보내는 요청이 스레드를 붙잡지 못하게
MAX_BODY = 20000


class BoardServer(ThreadingHTTPServer):
    """기본 listen 대기열은 5칸이다. tailscale serve는 브라우저의 스크립트 12개를 한꺼번에 열어
    넘친 연결이 끊기고(502) 보드가 빈 화면이 된다. 대기열을 넉넉히 잡는다."""
    request_queue_size = 128
    daemon_threads = True

FORBIDDEN_HOST = {"error": "이 주소로는 열 수 없어요"}
SERVER_ERROR = {"error": "서버 오류가 났어요. 서버 로그를 보세요"}


def make_handler(reg: Registry, hosts: set[str] | None = None):
    allowed = hosts if hosts is not None else load_allowed_hosts()

    class H(BaseHTTPRequestHandler):
        timeout = REQUEST_TIMEOUT

        def log_message(self, *a):
            pass

        def end_headers(self):
            for k, v in SECURITY_HEADERS.items():   # send·304·리다이렉트 어디서든 같은 머리말
                self.send_header(k, v)
            super().end_headers()

        def fail(self, what: str) -> None:
            """예상 밖 오류 — 응답은 고정 문구, 상세는 서버 로그(stderr)에만 남긴다."""
            sys.stderr.write(f"[spec-sheet] {self.command} {self.path.split('?', 1)[0]} {what}\n{traceback.format_exc()}")
            sys.stderr.flush()
            self.send(500, SERVER_ERROR)

        def send(self, code: int, body, ctype="application/json; charset=utf-8", extra: dict | None = None,
                 cache: str = "no-store"):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", cache)
            if len(data) >= GZIP_MIN and not ctype.startswith("image/"):
                self.send_header("Vary", "Accept-Encoding")
                if accepts_gzip(self.headers.get("Accept-Encoding")):
                    data = gzip.compress(data, 5, mtime=0)
                    self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def send_asset(self, got: tuple[bytes, str, int]) -> None:
            """정적 파일 — ETag·Last-Modified로 조건부 요청을 받는다(304). 매번 검증하게 no-cache."""
            body, ctype, mtime_ns = got
            etag = f'"{len(body):x}-{mtime_ns:x}"'
            last = formatdate(mtime_ns / 1e9, usegmt=True)
            inm = self.headers.get("If-None-Match")
            fresh = False
            if inm:
                fresh = etag in [t.strip().removeprefix("W/") for t in inm.split(",")] or inm.strip() == "*"
            else:
                ims = self.headers.get("If-Modified-Since")
                if ims:
                    try:
                        fresh = int(mtime_ns // 1_000_000_000) <= int(parsedate_to_datetime(ims).timestamp())
                    except (TypeError, ValueError, OverflowError):
                        fresh = False
            validators = {"ETag": etag, "Last-Modified": last}
            if fresh:
                self.send_response(304)
                for k, v in validators.items():
                    self.send_header(k, v)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Vary", "Accept-Encoding")
                self.end_headers()
                return
            self.send(200, body, ctype, extra=validators, cache="no-cache")

        def redirect(self, to: str, code: int = 302) -> None:
            self.send_response(code)
            self.send_header("Location", to)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def local(self) -> bool:
            return is_local_request(self.client_address[0], self.headers)

        def ws(self, key: str) -> Path:
            key = unquote(key)
            root = reg.roots().get(key) if KEY_RE.match(key) else None
            if root is None:
                raise KeyError(f"workspace {key}")
            return root

        def do_GET(self):
            path, _, qs = self.path.partition("?")
            if not host_allowed(self.headers, allowed):   # DNS 재바인딩 — 목록 밖 Host는 읽기도 막는다
                return self.send(403, FORBIDDEN_HOST)
            try:
                if path == "/api/board":  # ?w=<워크스페이스>. local = 이 PC의 브라우저인가 (화면이 버튼을 숨긴다)
                    w = parse_qs(qs).get("w", [""])[0]
                    local = self.local()
                    if w:
                        return self.send(200, {**build_board(self.ws(w)), "workspace": w, "local": local})
                    # w가 없으면 보드를 계산하지 않고 목록만 낸다 — 화면이 고른 워크스페이스로 다시 요청한다
                    return self.send(200, {"workspaces": [
                        {"workspace": k, "root": str(root), "tickets": len(find_tickets(root)), "local": local}
                        for k, root in reg.roots().items()]})
                if path == "/api/sheets":   # 사이드바 — 모든 워크스페이스의 시트 요약. 버전이 그대로면 다시 계산하지 않는다
                    return self.send(200, {"sheets": all_sheets(reg)})
                if path == "/api/repos":    # Repos & 서비스 — 등록된 워크스페이스와 서비스 상태
                    return self.send(200, repos_info(reg, self.server.server_port))
                if path == "/api/version":   # 화면의 실시간 확인 — 보드를 계산하지 않고 버전만
                    return self.send(200, {"v": board_version(self.ws(parse_qs(qs).get("w", [""])[0]))})
                m = re.fullmatch(r"/w/([^/]+)/api/spec", path)
                if m:   # 티켓 모달이 열릴 때만 spec.md 전문을 읽는다
                    slug = parse_qs(qs).get("sheet", [""])[0]
                    ticket = find_tickets(self.ws(m.group(1))).get(slug)
                    if ticket is None:
                        raise KeyError(f"ticket {slug}")
                    return self.send(200, {"slug": slug, "spec_md": read_spec_md(ticket)})
                m = re.fullmatch(r"/w/([^/]+)/api/commits", path)
                if m:
                    q = parse_qs(qs)
                    slug, key = q.get("sheet", [""])[0], q.get("id", [""])[0]
                    root = self.ws(m.group(1))
                    ticket = find_tickets(root).get(slug)
                    if ticket is None:
                        raise KeyError(f"ticket {slug}")
                    return self.send(200, {"commits": node_commits(root, ticket, slug, key)})
                m = re.fullmatch(r"/w/([^/]+)/api/evidence", path)
                if m:
                    q = parse_qs(qs)
                    ticket = find_tickets(self.ws(m.group(1))).get(q.get("sheet", [""])[0])
                    if ticket is None:
                        raise KeyError("ticket")
                    data, ctype = evidence_image(ticket, q.get("id", [""])[0], q.get("name", [""])[0])
                    return self.send(200, data, ctype)
                m = BOARD_PATH_RE.fullmatch(path)
                if m:
                    if m.group(1):
                        self.ws(m.group(1))   # 없는 워크스페이스면 KeyError → 404
                    if m.group(2) is None:    # /board → /board/ (상대 경로 스크립트가 깨지지 않게)
                        return self.redirect(path + "/" + ("?" + qs if qs else ""), 301)
                    got = board_asset(m.group(2))
                    if got is None:
                        return self.send(404, {"error": "not found"})
                    return self.send_asset(got)
                if path == "/":   # 옛 결정 시트 화면은 없다 — 보드로 넘긴다
                    return self.redirect("/board/" + ("?" + qs if qs else ""))
                m = re.fullmatch(r"/w/([^/]+)/?", path)
                if m:
                    return self.redirect(f"/w/{m.group(1)}/board/" + ("?" + qs if qs else ""))
            except KeyError as e:
                return self.send(404, {"error": str(e)})
            except Exception as e:  # 읽기 실패는 카드로 나오고, 여기는 예상 밖이다 — 서버는 계속 산다
                return self.fail(e.__class__.__name__)
            self.send(404, {"error": "not found"})

        do_HEAD = do_GET   # 본문만 빼고 같은 머리말 (send가 HEAD면 본문을 안 쓴다)

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            m = re.fullmatch(r"/w/([^/]+)/api/(user|node|ticket)", path)
            if not m:
                return self.send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", 0))
            except ValueError:
                n = 0
            # 본문은 Host·Origin·형식을 본 뒤에 읽는다 — 허용 밖 요청의 본문은 읽지 않는다.
            # 거절하면 응답을 먼저 보내고, 연결이 리셋돼 사유가 안 보이지 않게 남은 본문을 한도 안에서 버린다.
            refusal = None
            if not host_allowed(self.headers, allowed):
                refusal = (403, FORBIDDEN_HOST)
            elif not origin_matches(self.headers):   # 다른 사이트의 브라우저가 쏜 요청
                refusal = (403, {"error": "다른 주소에서 온 요청이에요"})
            elif not is_json_request(self.headers):
                refusal = (415, {"error": "application/json만 받아요"})
            if refusal is not None:
                self.close_connection = True
                self.send(*refusal)
                try:
                    if 0 < n:
                        self.rfile.read(min(n, MAX_BODY))
                except OSError:
                    pass
                return
            raw = self.rfile.read(n) if 0 < n <= MAX_BODY else b""
            try:
                if n > MAX_BODY:
                    raise ValueError("too large")
                req = json.loads(raw)
                root = self.ws(m.group(1))
                if m.group(2) == "user":
                    sheet = find_sheets(root).get(str(req["sheet"]))
                    if sheet is None:  # 다른 워크스페이스의 시트 이름을 넣어도 여기서 끝난다
                        raise KeyError(f"sheet {req['sheet']}")
                    r = save_user(sheet, str(req["id"]), req.get("user") or {}, req.get("base"))
                else:
                    ticket = find_tickets(root).get(str(req["sheet"]))
                    if ticket is None:
                        raise KeyError(f"ticket {req['sheet']}")
                    if m.group(2) == "node":
                        r = save_node_user(ticket, str(req["id"]), req.get("user") or {}, req.get("base"))
                    else:
                        r = save_ticket_user(ticket, req.get("user") or {}, req.get("base"))
            except Conflict as c:
                return self.send(409, {"error": "conflict", "user": c.user})
            except KeyError as e:
                return self.send(404, {"error": str(e)})
            except (ValueError, TypeError, json.JSONDecodeError) as e:
                return self.send(400, {"error": str(e)})
            except Exception as e:
                return self.fail(e.__class__.__name__)
            self.send(200, {"ok": True, "user": r.get("user")})

    return H


# ── CLI ──────────────────────────────────────────────────────

def sheet_dir(arg: str) -> Path:
    p = Path(arg).expanduser().resolve()
    if not (p / "rows").is_dir():
        sys.exit(f"rows/ 폴더가 없다: {p}")
    return p


IGNORE_LINE = "spec/**/ticket.json"


def ensure_ticket_ignored(where: Path) -> None:
    """ticket.json은 보드에서 사람이 바꾸는 로컬 설정(우선순위·멈춤·보관)이라 저장소에 올리지 않는다.
    커밋되지 않는 .git/info/exclude에 한 줄 넣는다 — 팀의 .gitignore는 건드리지 않고, 워크트리도 같이 덮는다.
    이미 .gitignore 등으로 가려져 있거나 ticket.json을 추적 중인 레포는 그 레포의 선택이라 넣지 않는다. 실패해도 조용히 넘어간다."""
    def git(*args: str):
        return subprocess.run(["git", "-C", str(where), *args], capture_output=True, text=True, timeout=5)
    try:
        if git("rev-parse", "--show-toplevel").returncode:
            return
        if git("check-ignore", "-q", "spec/x/ticket.json").returncode == 0:
            return
        if any(l.endswith("ticket.json") for l in git("ls-files", "--", "spec").stdout.splitlines()):
            return
        exclude = Path(git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude").stdout.strip())
        lines = exclude.read_text(encoding="utf-8").splitlines() if exclude.exists() else []
        if IGNORE_LINE in lines:
            return
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a", encoding="utf-8") as f:
            f.write(("" if not lines or lines[-1] == "" else "\n") + "# spec-board: 보드에서 바꾸는 로컬 설정\n" + IGNORE_LINE + "\n")
    except (OSError, subprocess.SubprocessError, ValueError):
        return


def register_root(root: Path) -> None:
    """서버가 모르는 레포면 CONF에 한 줄 적는다. 서버는 5초마다 CONF를 다시 읽는다.
    link가 준 주소가 바로 열리게."""
    root = root.resolve()
    ensure_ticket_ignored(root)
    known: list[Path] = []
    if CONF.exists():
        known += [Path(l.strip()).expanduser() for l in CONF.read_text().splitlines() if l.strip() and not l.startswith("#")]
    if any(p.resolve() == root for p in known):
        return
    CONF.parent.mkdir(parents=True, exist_ok=True)
    text = CONF.read_text() if CONF.exists() else ""
    CONF.write_text(text + ("" if not text or text.endswith("\n") else "\n") + f"{root}\n")


def link(sheet: Path, local: bool = False) -> str:
    """폰에서 보드 Inbox가 열리는 주소.
    local이면 이 PC에서 열 루프백 주소."""
    root = next((a.parent for a in sheet.parents if a.name == "spec"), None)
    if root is None:
        sys.exit("spec/ 아래 폴더가 아니다")
    register_root(root)
    keys = Registry([]).roots()   # 서버와 같은 출처(CONF)로 키를 매긴다 — 이 호출에만 있는 키를 만들지 않는다
    key = next(k for k, p in keys.items() if p == root.resolve())
    from urllib.parse import quote
    if local:
        return f"http://127.0.0.1:8790/w/{quote(key)}/board/"
    base = os.environ.get("SPEC_SHEET_URL")
    if not base:
        try:
            st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=3).stdout)
            base = f"https://{st['Self']['DNSName'].rstrip('.')}:8443"
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            base = "http://127.0.0.1:8790"
    return f"{base}/w/{quote(key)}/board/#inbox"


def install_launchd() -> None:
    plist = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
    log = HOME / "Library/Logs/spec-board.log"
    path = f"{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    plist.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{sys.executable}</string><string>-m</string><string>spec_board</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
""")
    dom = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{dom}/{LABEL}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", dom, str(plist)], check=True)
    print(f"{plist}\n로그: {log}\n끄기: launchctl bootout {dom}/{LABEL}")


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["apply"] and len(args) == 2:
        print(json.dumps(apply_sheet(sheet_dir(args[1])), ensure_ascii=False, indent=2))
        return 0
    if args[:1] == ["pending"] and len(args) == 2:
        print(json.dumps(pending(sheet_dir(args[1])), ensure_ascii=False))
        return 0
    if args[:1] == ["wait"] and len(args) in (2, 4) and (len(args) == 2 or args[2] == "--timeout"):
        got, timed_out = wait_pending(sheet_dir(args[1]), float(args[3]) if len(args) == 4 else 300)
        print(json.dumps({**got, "timeout": timed_out}, ensure_ascii=False))
        return 3 if timed_out else 0
    if args[:1] == ["patch"] and len(args) == 4:
        raw = sys.stdin.read() if args[3] == "-" else args[3]   # `-`면 표준입력 — 사람 글이 든 JSON을 명령 인자에 싣지 않는다
        r = patch_row(sheet_dir(args[1]), args[2], json.loads(raw))
        print(json.dumps({k: r.get(k) for k in ("id", "status", "confidence", "recommend", "_kept", "_standing") if k in r}, ensure_ascii=False))
        return 0
    if args[:1] == ["link"]:   # 행 id를 줘도 받는다 — 보드 Inbox가 열릴 뿐 행으로 가지는 않는다
        local = "--local" in args
        rest = [a for a in args[1:] if a != "--local"]
        if len(rest) not in (1, 2):
            sys.exit("사용법: sheet.py link <스펙 폴더> [행 id] [--local]")
        print(link(sheet_dir(rest[0]), local))
        return 0
    if args[:1] in (["install-launchd"], ["install-service"]):
        install_launchd()
        return 0
    port, host, repos, extra_hosts = 8790, "127.0.0.1", [], []
    i = 0
    while i < len(args):
        if args[i] == "--port":
            port = int(args[i + 1]); i += 2
        elif args[i] == "--host":
            host = args[i + 1]; i += 2
        elif args[i] == "--allow-host":
            extra_hosts.append(args[i + 1]); i += 2
        else:
            repos.append(Path(args[i]).expanduser().resolve()); i += 1
    reg = Registry(repos)
    roots = reg.roots()
    for p in roots.values():
        ensure_ticket_ignored(p)
    print(f"워크스페이스 {len(roots)}개", *[f"  /w/{k}/  {p}  시트 {len(find_sheets(p))}" for k, p in roots.items()], sep="\n")
    srv = BoardServer((host, port), make_handler(reg, load_allowed_hosts(extra_hosts)))   # 포트를 연 뒤에 주소를 알린다
    print(f"http://{host}:{port}/", flush=True)
    srv.serve_forever()
    return 0

if __name__ == "__main__":
    sys.exit(main())
