#!/usr/bin/env python3
"""spec 모델 — 레포의 프로젝트 → 티켓 → 노드 → 행을 읽어 보드가 그릴 JSON으로 만든다.

sheet.py(보드 서버)와 node_state.py·migrate_format.py가 같은 파서를 쓰도록 머리 표·노드 파서를 여기 둔다 (D8).
읽기만 한다. 파일을 쓰는 쪽은 sheet.py의 잠금 아래다.

  spec_model.py [레포]     보드 JSON을 낸다 (기본: 현재 폴더)

모델은 가볍게 둔다 — 결정은 티켓 rows에만 있고(화면이 모은다), spec.md 전문은 실리지 않는다(`read_spec_md`, `/api/spec`).

계산하는 것 (저장하지 않는다)
  - 칸: 시작 가능 · 진행 · 확인 대기 · 기다림 · 끝남 (D7). `아직 안 함`은 앞 노드가 전부 끝났으면 시작 가능,
    아니면 기다림. 막힘·보류도 기다림이고 막힘이 맨 위다.
  - 화면 ID: 노드는 브리프 `**id**`(IB-8), 행은 `<ID 머리>-<행 id>`(IB-D11, IB-T19) (D9).
  - 불가능한 조합 경고 5종과 "담당 없음" 시나리오.

노드 상태의 원본은 브리프 `**상태**:` 한 곳이다 (D-R3). `## 노드 인덱스` 표 4열(상태)은 참고용이라 읽지 않는다 —
표는 어떤 브리프가 있는지·deps만 알려 준다. 브리프에 상태 줄이 없으면 `모름`이고 경고가 붙는다.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

# ── 상태 어휘 ─────────────────────────────────────────────────
# 저장 값은 D2의 여섯 — 아직 안 함·진행·확인 대기·막힘·보류·끝남. 여섯 값과 동의어 표는 states.json 한 곳이다 —
# node_state·migrate_format과 다른 도구도 같은 표를 쓴다. 여기에 값을 따로 적지 않는다.
# 티켓 머리 표만 재확인 필요를 더 쓰고, 못 읽거나 표에 없으면 모름.
STATES_FILE = Path(__file__).resolve().parent / "states.json"


def _load_vocab(path: Path = STATES_FILE) -> tuple[list[str], list[tuple[tuple[str, ...], str]], str]:
    d = json.loads(path.read_text(encoding="utf-8"))
    pairs = [(tuple(s.lower() for s in v), k) for k, v in d.get("ticket_only", {}).items()]
    pairs += [(tuple(s.lower() for s in d["synonyms"][k]), k) for k in d["six"]]
    return list(d["six"]), pairs, d.get("unknown", "모름")


SIX, NORMALIZE, UNKNOWN = _load_vocab()
STATES = ["재확인 필요", "진행", "확인 대기", "막힘", "아직 안 함", "보류", "끝남", UNKNOWN]

HEAD_KEYS = {"종류", "문제", "상위", "상위문제", "상태", "시작", "이슈"}
# 보드가 더 읽는 칸. HEAD_KEYS는 머리 표가 있는 스펙인지 가리는 기준이라 넓히지 않고 따로 둔다.
BOARD_HEAD_KEYS = HEAD_KEYS | {"ID 머리", "시안", "우선순위", "근거"}

# 보드 칸 (D7). 순서가 화면 순서다.
COLUMNS = ["시작 가능", "진행", "확인 대기", "기다림", "끝남"]
WAIT_ORDER = {"막힘": 0, "보류": 1, "아직 안 함": 2}  # 기다림 칸 안의 순서 — 막힘이 맨 위

# 사람 칸 (D3·D5). 화면은 이 칸만 쓴다.
VERDICTS = ("", "통과", "고쳐줘")
NODE_USER_KEYS = ("verdict", "fix")
TICKET_USER_KEYS = ("priority", "paused", "archived")
MAX_TEXT = 4000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def norm_state(raw: str) -> str:
    s = raw.strip().lower()
    for keys, out in NORMALIZE:
        if any(s.startswith(k) for k in keys):
            return out
    return UNKNOWN


# ── 머리 표·노드 브리프 파서 ─────────────────────

CELL = re.compile(r"^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$")


def head_table(lines: list[str], keys: set[str] = HEAD_KEYS) -> dict[str, str]:
    """제목 아래 첫 30줄 안의 `| 항목 | 값 |` 표를 읽는다."""
    out: dict[str, str] = {}
    for line in lines[:30]:
        m = CELL.match(line)
        if m and m.group(1) in keys:
            out[m.group(1)] = m.group(2)
        elif out and not line.startswith("|"):
            break
    return out


def title_of(lines: list[str], fallback: str) -> str:
    for line in lines[:5]:
        if line.startswith("# "):
            t = line[2:].strip()
            return re.sub(r"^Spec:\s*", "", t)
    return fallback


def plain(s: str) -> str:
    """표시용으로 마크다운 장식을 걷어 낸다."""
    s = re.sub(r"^[-*]\s+|^\d+\.\s+|^>\s*", "", s.strip())
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"\[(.+?)\]\(.*?\)", r"\1", s)
    return s


def first_line_under(lines: list[str], heading: str) -> str:
    """`## 문제` 아래 첫 문장. 주석·빈 줄은 건너뛴다. 제목의 ' — 결론'이 있으면 그걸 쓴다."""
    for i, line in enumerate(lines):
        if line.startswith("## ") and line[3:].strip().startswith(heading):
            rest = line[3:].strip()[len(heading):].strip()
            if rest.startswith("—"):
                return plain(rest.lstrip("— "))
            for nxt in lines[i + 1:]:
                s = nxt.strip()
                if not s or s.startswith("<!--"):
                    continue
                if s.startswith("#"):
                    return ""
                return plain(s)
    return ""


# ── 브리프 머리·노드 인덱스 표 ──────────────────────────────────

BRIEF_FIELD = re.compile(r"^\*\*(.+?)\*\*:\s*(.*)$")
COMMENT = re.compile(r"<!--.*?(?:-->|$)")


def brief_head(lines: list[str]) -> dict[str, str]:
    """`**키**: 값` 줄들. 뒤에 붙은 HTML 주석은 뗀다. 첫 본문 절(`## `) 앞까지만 본다."""
    out: dict[str, str] = {}
    for line in lines[:40]:
        if line.startswith("## "):
            break
        m = BRIEF_FIELD.match(line)
        if m and m.group(1) not in out:
            out[m.group(1)] = COMMENT.sub("", m.group(2)).strip()
    return out


ROW_RANGE = re.compile(r"\b([TD])(\d+)\s*[–~-]\s*\1?(\d+)\b")
ROW_REF = re.compile(r"\b([TD])(\d+)\b")


def row_ids(text: str) -> list[str]:
    """`T1, T4(괄호 부연), T9–T12` 같은 문장에서 행 ID를 뽑는다. 범위는 펴고, 중복은 첫 자리만 남긴다."""
    text = COMMENT.sub("", text)
    found: list[tuple[int, str]] = []
    for m in ROW_RANGE.finditer(text):
        a, b = int(m.group(2)), int(m.group(3))
        if a <= b <= a + 200:
            found += [(m.start(), f"{m.group(1)}{n}") for n in range(a, b + 1)]
    for m in ROW_REF.finditer(text):
        found.append((m.start(), f"{m.group(1)}{m.group(2)}"))
    seen: set[str] = set()
    out: list[str] = []
    for _, r in sorted(found, key=lambda x: x[0]):
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def split_list(cell: str) -> list[str]:
    cell = COMMENT.sub("", cell)
    return [t for t in re.split(r"[,·、/\s]+", cell.strip().strip("`"))
            if t and t not in ("—", "-", "없음", "없다", "none")]


def parse_node_index(lines: list[str]) -> list[dict]:
    """`## 노드 인덱스` 제목 뒤 첫 표. 열은 ID · 브리프 · deps · 상태(참고용 — 읽지 않는다). 쓰는 건 앞 셋뿐이다."""
    out: list[dict] = []
    inside, started = False, False
    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            inside = line[3:].strip().startswith("노드 인덱스")
            continue
        if not inside:
            continue
        if not line.startswith("|"):
            if started:
                break
            continue
        started = True
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(c) < 4 or c[0] in ("ID", "") or set(c[0]) <= set("-:"):
            continue
        link = re.search(r"\]\(([^)]+)\)", c[1])
        out.append({"key": c[0], "brief": (link.group(1) if link else c[1].strip("`")).strip(),
                    "deps": split_list(c[2])})
    return out


# ── 행·사람 칸 파일 ────────────────────────────────────────────

def json_files(d: Path, base: Path | None = None) -> list[Path]:
    """폴더의 *.json. 원자적 쓰기가 남기는 `.tmp-*`(쓰는 도중의 임시 파일)와 점 파일, 심볼릭 링크는 뺀다.
    base(티켓 폴더)를 주면 d까지 가는 길에 심볼릭 링크가 있거나 base 밖이면 빈 목록이다."""
    if base is not None and not clean_path(base, d):
        return []
    if d.is_symlink():
        return []
    return sorted(f for f in d.glob("*.json") if not f.name.startswith(".") and not f.is_symlink())


def brief_files(ticket: Path) -> list[Path]:
    """티켓 폴더의 노드 브리프(n<번호>*.md). 심볼릭 링크는 뺀다 — 폴더 밖 파일을 브리프로 읽지 않는다."""
    return sorted(p for p in ticket.glob("n[0-9]*.md") if not p.is_symlink())


def load_rows(sheet: Path) -> list[dict]:
    rows = []
    for f in json_files(sheet / "rows", sheet):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            r = {"id": f.stem, "kind": "task", "title": f"⚠ 읽기 실패: {e}", "status": "모름"}
        rows.append(r)
    return rows


def inside(base: Path, p: Path) -> Path | None:
    """p를 resolve()한 뒤 base 안이면 그 경로, 아니면 None. `..`·심볼릭 링크로 폴더 밖을 가리켜도 막힌다."""
    try:
        r = p.resolve()
        return r if r.is_relative_to(base.resolve()) else None
    except (OSError, RuntimeError, ValueError):
        return None


def clean_path(base: Path, p: Path) -> bool:
    """p가 base 아래의 실제 경로인가. base에서 p까지 어느 구간도 심볼릭 링크가 아니고 resolve()한 뒤에도 base 안이다.
    p는 base에서 이어 붙여 만든 경로여야 한다(`base / "rows" / ...`). 쓰기 전에도 같은 검사를 쓴다."""
    try:
        rel = p.relative_to(base)
    except ValueError:
        return False
    cur = base
    for part in rel.parts:
        cur = cur / part
        if cur.is_symlink():
            return False
    return inside(base, p) is not None


def brief_path(ticket: Path, rel: str) -> Path | None:
    """표가 가리키는 브리프 파일. 티켓 폴더 안의 실제 파일일 때만 — 표는 사람이 쓴 글이라 `../../`·심볼릭 링크가 올 수 있다."""
    if not rel or "\x00" in rel:
        return None
    p = ticket / rel
    return inside(ticket, p) if clean_path(ticket, p) else None


def _read_clean(base: Path, p: Path) -> str:
    """base 안의 실제 파일만 읽는다. 심볼릭 링크·폴더 밖이면 OSError — 호출한 쪽의 읽기 실패 처리로 간다."""
    if not clean_path(base, p):
        raise OSError(f"심볼릭 링크이거나 폴더 밖이다: {p.name}")
    return p.read_text(encoding="utf-8")


def node_file(ticket: Path, key: str) -> Path:
    if not ID_RE.match(key):
        raise ValueError("bad id")
    return ticket / "rows" / "nodes" / f"{key}.json"


def ticket_file(ticket: Path) -> Path:
    return ticket / "ticket.json"


def _user_of(f: Path, base: Path) -> dict:
    if not clean_path(base, f):   # 심볼릭 링크·폴더 밖 — 읽지 않는다
        return {}
    try:
        u = json.loads(f.read_text(encoding="utf-8")).get("user")
    except (OSError, ValueError, AttributeError):
        return {}
    return u if isinstance(u, dict) else {}


def clean_node_user(patch: dict) -> dict:
    """화면이 보낸 노드 사람 칸을 검사한다. verdict는 통과·고쳐줘·빈 값만."""
    if not isinstance(patch, dict):
        raise ValueError("user는 객체여야 한다")
    out = {}
    for k in NODE_USER_KEYS:
        if k not in patch:
            continue
        v = str(patch[k])
        if k == "verdict" and v not in VERDICTS:
            raise ValueError(f"verdict는 {' · '.join(repr(x) for x in VERDICTS)} 중 하나다")
        out[k] = v[:MAX_TEXT]
    return out


def clean_ticket_user(patch: dict) -> dict:
    """priority는 짧은 라벨(P0…), paused는 참·거짓."""
    if not isinstance(patch, dict):
        raise ValueError("user는 객체여야 한다")
    out: dict = {}
    if "priority" in patch:
        v = str(patch["priority"]).strip()
        if len(v) > 20 or "\n" in v:
            raise ValueError("priority는 20자 이하 한 줄이다")
        out["priority"] = v
    if "paused" in patch:
        if not isinstance(patch["paused"], bool):
            raise ValueError("paused는 true·false다")
        out["paused"] = patch["paused"]
    if "archived" in patch:
        if not isinstance(patch["archived"], bool):
            raise ValueError("archived는 true·false다")
        out["archived"] = patch["archived"]
    return out


# ── 티켓 찾기 ─────────────────────────────────────────────────

def find_tickets(root: Path) -> dict[str, Path]:
    """spec/ 아래 spec.md가 있는 폴더. README가 같이 있는 폴더는 줄기 자신이라 티켓이 아니다."""
    spec = root / "spec"
    if not spec.is_dir():
        return {}
    out = {}
    for md in sorted(spec.rglob("spec.md")):
        d = md.parent
        if d == spec or (d / "README.md").exists() or any(part.startswith(".") for part in d.relative_to(spec).parts):
            continue
        if not clean_path(spec, md):   # spec.md나 그 위 폴더가 심볼릭 링크 — 폴더 밖 글을 티켓으로 읽지 않는다
            continue
        out[str(d.relative_to(spec))] = d
    return out


def node_keys(ticket: Path) -> set[str]:
    """티켓이 가진 노드 key — 노드 인덱스 표와 브리프 파일 이름 앞토막. 쓰기 경로가 없는 노드에 파일을 만들지 않게 쓴다."""
    try:
        keys = {i["key"] for i in parse_node_index(_read_clean(ticket, ticket / "spec.md").splitlines())}
    except (OSError, UnicodeDecodeError):
        keys = set()
    return keys | {p.stem.split("-")[0] for p in brief_files(ticket)}


def project_of(spec: Path, ticket: Path) -> Path | None:
    """티켓 위쪽에서 README.md가 있는 가장 가까운 폴더 = 프로젝트(줄기)."""
    for p in ticket.parents:
        if p == spec or spec not in p.parents:
            return None
        if (p / "README.md").exists():
            return p
    return None


def board_version(root: Path) -> str:
    """보드가 읽는 파일 목록(경로·수정 시각·크기)의 해시 — 브리프·표·행·노드 사람 칸·ticket.json·줄기 README.
    가장 늦은 시각만 보면 파일을 지우거나 git이 옛 시각으로 파일을 들여올 때 놓친다. 목록 전체를 본다."""
    h = hashlib.sha1()
    for _, d in sorted(find_tickets(root).items()):
        files = [d.parent / "README.md", d / "spec.md", ticket_file(d), *brief_files(d),
                 *json_files(d / "rows", d), *json_files(d / "rows" / "nodes", d)]
        for f in files:
            try:
                st = f.stat()
            except OSError:
                continue
            rel = f.relative_to(root) if f.is_relative_to(root) else f   # 같은 레포를 /var·/private/var로 불러도 같은 버전
            h.update(f"{rel}\0{st.st_mtime_ns}\0{st.st_size}\n".encode())
    return h.hexdigest()[:16]


# ── 보드 계산 ─────────────────────────────────────────────────

def _natural(rid: str) -> tuple:
    m = re.match(r"^([A-Za-z]+)(\d+)$", rid)
    return (m.group(1), int(m.group(2))) if m else (rid, 0)


def _warn(code: str, text: str) -> dict:
    return {"code": code, "text": text}


def _norm_dep(tok: str, keys: set[str]) -> str:
    """브리프 deps는 `n2-ime-guard`처럼 이름이 붙어 있고 표는 `n2`다."""
    if tok in keys:
        return tok
    head = tok.split("-", 1)[0]
    return head if head in keys else tok


CHECK_ITEM = re.compile(r"^\s*[-*]\s+\[[ xX]\]\s+(.*\S)\s*$")


def checks_of(lines: list[str]) -> dict:
    """`## 확인할 것` 절 — 첫 문단은 안내(intro), `- [ ]` 항목은 사람이 볼 것(items). 절이 없으면 둘 다 빈 값."""
    out: dict = {"intro": "", "items": []}
    start = next((i for i, l in enumerate(lines) if l.startswith("## ") and l[3:].strip().startswith("확인할 것")), None)
    if start is None:
        return out
    intro: list[str] = []
    seen_item = False
    for l in lines[start + 1:]:
        if l.startswith("## "):
            break
        m = CHECK_ITEM.match(l)
        if m:
            seen_item = True
            out["items"].append(m.group(1))
        elif not seen_item and not out["items"]:
            s = l.strip()
            if s.startswith("<!--"):
                continue
            if not s:
                if intro:
                    seen_item = True   # 첫 문단이 끝났다 — 뒤 글은 안내가 아니다
                continue
            if s.startswith(("-", "*", "#", "|", ">")):
                seen_item = True
                continue
            intro.append(s)
    out["intro"] = " ".join(intro)
    return out


BULLET = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+(?!\[[ xX]\])(.*\S)\s*$")


def section_lines(lines: list[str], heading: str) -> list[str]:
    """`## <heading>` 절의 본문 줄(다음 `## `까지). 빈 줄·주석은 뺀다."""
    start = next((i for i, l in enumerate(lines) if l.startswith("## ") and l[3:].strip().startswith(heading)), None)
    if start is None:
        return []
    out: list[str] = []
    for l in lines[start + 1:]:
        if l.startswith("## "):
            break
        if l.strip() and not l.strip().startswith("<!--"):
            out.append(l)
    return out


def why_of(lines: list[str]) -> list[str]:
    """모달 「왜 했나」 — `## 문제`의 글머리 항목. 글머리가 없으면 문단 전체를 한 항목으로."""
    body = section_lines(lines, "문제")
    items = [plain(m.group(1)) for m in (BULLET.match(l) for l in body) if m]
    if items:
        return items
    text = " ".join(l.strip() for l in body if not l.strip().startswith(("#", "|", ">")))
    return [plain(text)] if text else []


def criteria_of(lines: list[str]) -> list[dict]:
    """모달 「완료 기준」 — `## 완료 기준`의 `- [ ]`·`- [x]` 항목. done은 체크 여부."""
    out = []
    for l in section_lines(lines, "완료 기준"):
        m = CHECK_ITEM.match(l)
        if m:
            out.append({"text": plain(m.group(1)), "done": bool(re.match(r"^\s*[-*]\s+\[[xX]\]", l))})
    return out


def _read_brief(path: Path) -> tuple[dict, str, str, str, dict, dict]:
    """(머리 칸들, 제목, 문제 첫 줄, 오류, 확인할 것, 모달 칸{why·criteria}). 못 읽으면 머리는 빈 dict, 오류에 이유."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as e:
        return {}, path.stem, "", f"읽기 실패: {e.__class__.__name__}", {"intro": "", "items": []}, {"why": [], "criteria": []}
    head = brief_head(lines)
    title = re.sub(r"^n\d+[-\w]*\s+—\s+", "", title_of(lines, path.stem))
    err = "" if ("상태" in head or "id" in head) else "읽기 실패: 머리 칸(**상태**·**id**)이 없다"
    return head, title, first_line_under(lines, "문제"), err, checks_of(lines), {"why": why_of(lines), "criteria": criteria_of(lines)}


def _read_ticket(slug: str, tdir: Path) -> dict:
    """티켓 하나. 파일이 깨져도 이 티켓만 `error`를 달고 나온다 — 보드 전체는 멈추지 않는다."""
    try:
        lines = _read_clean(tdir, tdir / "spec.md").splitlines()
    except (OSError, UnicodeDecodeError) as e:
        return {"slug": slug, "title": tdir.name, "problem": "", "state": "모름", "error": f"읽기 실패: {e.__class__.__name__}",
                "nodes": [], "rows": [], "warnings": [], "counts": {c: 0 for c in COLUMNS}, "unowned": [],
                "scenarios": {"total": 0, "passed": 0}, "priority": "", "paused": False, "archived": False, "head": {}, "id_head": ""}
    head = head_table(lines, BOARD_HEAD_KEYS)
    id_head = head.get("ID 머리", "").strip()
    prefix = id_head or slug.rsplit("/", 1)[-1]
    tj = _user_of(ticket_file(tdir), tdir)
    warnings: list[dict] = []
    if not id_head:
        warnings.append(_warn("no-id-head", "머리 표에 ID 머리가 없다 — 슬러그로 대신한다"))

    # 행
    rows = load_rows(tdir)
    rows.sort(key=lambda r: (r.get("kind") != "task", _natural(str(r.get("id", "")))))
    by_id = {str(r.get("id")): r for r in rows}

    # 노드: 표가 먼저, 표에 없는 브리프는 뒤에
    index = parse_node_index(lines)
    listed = {i["key"] for i in index}
    for p in brief_files(tdir):
        key = p.stem.split("-")[0]
        if key not in listed and all(i["brief"] != p.name for i in index):
            index.append({"key": key, "brief": p.name, "deps": None, "unlisted": True})
            listed.add(key)
    keys = {i["key"] for i in index}

    nodes: list[dict] = []
    for i in index:
        bhead, btitle, bproblem, err, bchecks, bextra = ({}, i["key"], "", "읽기 실패: 브리프 경로가 없다", {"intro": "", "items": []}, {"why": [], "criteria": []})
        if i["brief"]:
            bpath = brief_path(tdir, i["brief"])
            if bpath is None:   # 티켓 폴더 밖 — 읽지 않는다
                err = "읽기 실패: 브리프 경로가 티켓 폴더 밖이다"
            else:
                bhead, btitle, bproblem, err, bchecks, bextra = _read_brief(bpath)
        state = norm_state(bhead["상태"]) if "상태" in bhead else "모름"   # 원본은 브리프 한 곳 — 표 4열은 읽지 않는다
        deps_raw = i["deps"] if i["deps"] is not None else split_list(bhead.get("deps", ""))
        n_digits = re.match(r"^n(\d+)", i["key"])
        disp = bhead.get("id") or (f"{prefix}-{n_digits.group(1)}" if n_digits else f"{prefix}-{i['key']}")
        user = _user_of(node_file(tdir, i["key"]), tdir) if ID_RE.match(i["key"]) else {}
        ev_path = tdir / "evidence" / i["key"] if ID_RE.match(i["key"]) else None
        ev_dir = ev_path if ev_path is not None and clean_path(tdir, ev_path) else None   # 심볼릭 링크 폴더는 목록에 올리지 않는다
        evidence = sorted(p.name for p in ev_dir.iterdir()
                          if p.is_file() and not p.is_symlink() and not p.name.startswith(".")) if ev_dir and ev_dir.is_dir() else []
        need = bhead.get("사람 확인", "").strip()
        node = {
            "key": i["key"], "id": disp, "title": btitle, "problem": bproblem, "state": state,
            "brief": i["brief"], "agent": bhead.get("agent", ""), "rows": row_ids(bhead.get("담당 행", "")),
            "deps": [_norm_dep(t, keys) for t in deps_raw], "needs_check": need.startswith("필요"),
            "verdict": str(user.get("verdict", "")), "fix": str(user.get("fix", "")), "evidence": evidence,
            "checks": bchecks, "why": bextra["why"], "criteria": bextra["criteria"], "error": err, "warnings": [],
        }
        if i.get("unlisted"):
            node["warnings"].append(_warn("not-in-index", "노드 인덱스 표에 없다 — /go 루프(graph.py ready)가 띄우지 않는다"))
        if err:
            node["warnings"].append(_warn("read-failed", err))
        elif "상태" not in bhead:
            node["warnings"].append(_warn("no-status", "브리프에 **상태**: 줄이 없다 — 상태를 모름으로 본다"))
        nodes.append(node)
    node_by_key = {n["key"]: n for n in nodes}

    # 칸 — 앞 노드가 전부 끝났는지는 상태가 다 정해진 뒤에 본다
    for n in nodes:
        n["waiting_on"] = [d for d in n["deps"] if (node_by_key.get(d) or {}).get("state") != "끝남"]
        s = n["state"]
        if s == "끝남":
            col = "끝남"
        elif s in ("진행", "확인 대기"):
            col = s
        elif s == "아직 안 함" and not n["waiting_on"]:
            col = "시작 가능"
        else:
            col = "기다림"
        n["column"] = col
        n["wait_rank"] = WAIT_ORDER.get(s, 3) if col == "기다림" else 0

    # 열린 결정이 어느 노드를 막는가. blocks에는 노드 key·화면 ID·그 노드가 맡은 행 ID가 올 수 있다
    owners: dict[str, list[str]] = {}
    for n in nodes:
        for r in n["rows"]:
            owners.setdefault(r, []).append(n["key"])

    def blocked_nodes(dec: dict) -> list[str]:
        out: list[str] = []
        for b in dec.get("blocks") or []:
            b = str(b)
            for n in nodes:
                if b in (n["key"], n["id"]) and n["key"] not in out:
                    out.append(n["key"])
            for k in owners.get(b, []):
                if k not in out:
                    out.append(k)
        return out

    out_rows: list[dict] = []
    for r in rows:
        rid = str(r.get("id", ""))
        failed = str(r.get("title", "")).startswith("⚠ 읽기 실패")
        status = norm_state(str(r.get("status", "")))
        user = r.get("user") if isinstance(r.get("user"), dict) else {}
        o = {
            "id": rid, "display_id": f"{prefix}-{rid}", "kind": r.get("kind", "task"), "title": r.get("title", ""),
            "given": r.get("given", ""), "when": r.get("when", ""), "then": r.get("then", ""),
            "options": r.get("options") or [], "recommend": r.get("recommend", ""), "confidence": r.get("confidence", ""),
            "reversible": r.get("reversible"), "status": status, "blocks": [str(b) for b in r.get("blocks") or []],
            "user": {"answer": str(user.get("answer", "")), "fix": str(user.get("fix", ""))},
            "log": r.get("log") or [], "read_error": failed, "warnings": [],
        }
        if o["kind"] == "decision":
            o["open"] = status != "끝남"
            o["blocking"] = bool(o["open"] and r.get("reversible") is False and not o["user"]["answer"].strip())
            o["blocked_nodes"] = blocked_nodes(r)
            o["blocked_node_ids"] = [node_by_key[k]["id"] for k in o["blocked_nodes"]]
        else:
            o["owners"] = owners.get(rid, [])
        out_rows.append(o)
    row_out = {r["id"]: r for r in out_rows}

    # 노드 ↔ 막는 결정
    for n in nodes:
        n["blocked_by"] = [r["id"] for r in out_rows
                           if r["kind"] == "decision" and r["open"] and n["key"] in r["blocked_nodes"]]
        n["blocked_by_ids"] = [row_out[d]["display_id"] for d in n["blocked_by"]]
        n["rows_missing"] = [r for r in n["rows"] if r not in by_id]

    # 불가능한 조합 — 카드에 경고 칩을 붙인다
    for n in nodes:
        if n["state"] == "진행":
            if n["waiting_on"]:
                n["warnings"].append(_warn("progress-before-deps", f"진행인데 앞 노드 {', '.join(n['waiting_on'])}가 끝나지 않았다"))
        if n["state"] == "막힘" and not n["blocked_by"]:
            n["warnings"].append(_warn("blocked-without-decision", "막힘인데 이 노드를 막는 열린 결정이 없다"))
        if n["state"] == "끝남" and n["verdict"] == "고쳐줘":
            n["warnings"].append(_warn("done-with-fix", "끝남인데 확인 결과가 고쳐줘로 남아 있다"))
    for r in out_rows:
        if r["kind"] == "decision" and not r["open"]:
            still = [k for k in r["blocked_nodes"] if node_by_key[k]["state"] == "막힘"]
            for k in still:
                node_by_key[k]["warnings"].append(
                    _warn("decision-done-node-blocked", f"결정 {r['display_id']}가 끝났는데 이 노드는 아직 막힘이다"))
            if still:
                r["warnings"].append(_warn("decision-done-node-blocked", f"끝났는데 {', '.join(still)}가 아직 막힘이다"))

    # 시나리오 통과 = 행이 끝남이거나, 맡은 노드가 전부 끝남 (n13)
    tasks = [r for r in out_rows if r["kind"] == "task"]
    for r in tasks:
        own = r["owners"]
        r["passed"] = r["status"] == "끝남" or (bool(own) and all(node_by_key[k]["state"] == "끝남" for k in own))
    unowned = [r["id"] for r in tasks if not r["owners"]]
    scen = {"total": len(tasks), "passed": sum(1 for r in tasks if r["passed"])}

    if "상태" in head:
        state = norm_state(head["상태"])
    else:  # 머리가 없으면 노드가 가리키는 쪽으로 짐작한다
        st = [n["state"] for n in nodes if n["state"] != "모름"]
        state = "모름" if not st else "끝남" if all(s == "끝남" for s in st) else "아직 안 함" if all(s == "아직 안 함" for s in st) else "진행"
    if state == "끝남":
        open_sc = [r["id"] for r in tasks if not r["passed"]]
        if open_sc:
            warnings.append(_warn("done-with-open-scenarios", f"끝남인데 통과하지 않은 시나리오 행이 있다: {', '.join(open_sc)}"))

    nodes.sort(key=lambda n: (COLUMNS.index(n["column"]), n["wait_rank"], _natural(n["key"])))
    counts = {c: sum(1 for n in nodes if n["column"] == c) for c in COLUMNS}
    waves, wave_warns = read_waves(tdir)
    return {
        "slug": slug, "title": title_of(lines, tdir.name), "problem": head.get("문제", ""), "state": state,
        "head": head, "id_head": prefix, "priority": str(tj.get("priority", "") or head.get("우선순위", "")),
        "priority_user": str(tj.get("priority", "")), "paused": bool(tj.get("paused", False)), "archived": bool(tj.get("archived", False)),
        "counts": counts, "nodes": nodes, "rows": out_rows, "unowned": unowned, "scenarios": scen,
        "warnings": warnings + wave_warns, "error": "", "waves": waves,
    }


def read_spec_md(tdir: Path) -> str:
    """티켓 spec.md 전문 — 티켓 모달이 열릴 때만 `/api/spec`으로 읽는다. 모델에는 싣지 않는다(크다). 못 읽으면 빈 문자열."""
    try:
        return _read_clean(tdir, tdir / "spec.md").rstrip("\n")
    except (OSError, UnicodeDecodeError):
        return ""


WAVE_HEAD = re.compile(r"^#\s*wave\s+(.+?)\s*·\s*스레드\s+(\S+)")
WAVE_KEY = re.compile(r"^[A-Za-z]+[-_]?\d+[A-Za-z0-9_-]*$")


def _wave_at(raw: str, fallback: str) -> str:
    """머리의 시각을 'YYYY-MM-DD HH:MM'(KST)로. UTC 표기는 +9시간, 시각이 없으면 날짜만, 못 읽으면 파일 이름."""
    from datetime import datetime, timedelta
    raw = raw.strip()
    m = re.match(r"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$", raw)
    if m:
        return "%s-%s-%s %s:%s" % m.groups()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(?::\d{2})?(?: (UTC))?)?$", raw)
    if m:
        day, hm, utc = m.groups()
        if hm and utc:
            d = datetime.strptime(f"{day} {hm}", "%Y-%m-%d %H:%M") + timedelta(hours=9)
            return d.strftime("%Y-%m-%d %H:%M")
        if not hm:  # 날짜만 있으면 파일 이름의 HHMM을 빌린다
            f = re.match(r"^\d{8}-(\d{2})(\d{2})", fallback)
            hm = f"{f.group(1)}:{f.group(2)}" if f else ""
        return f"{day} {hm}" if hm else day
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2})(?!\d))?", fallback)   # wave-20261013-wave3.md 같은 이름은 날짜만
    if m:
        y, mo, d, hh, mm = m.groups()
        return f"{y}-{mo}-{d} {hh}:{mm}" if hh else f"{y}-{mo}-{d}"
    return fallback


def parse_wave(text: str, fallback_at: str = "") -> dict | None:
    """웨이브 보고서 하나 → {at, thread, nodes:[{key,state}], dur}. 머리줄이 없으면 None.
    노드 줄은 '## 노드' 아래(없으면 머리와 첫 '## ' 사이)의 'ID | 상태 | …' — 앞뒤 파이프가 있든 없든 읽는다."""
    lines = text.splitlines()
    head = next((WAVE_HEAD.match(l) for l in lines if l.strip()), None)
    if not head:
        return None
    sec, body = "", {"": [], "노드": [], "소요": [], "review": []}
    for l in lines[1:]:
        if l.startswith("## "):
            sec = l[3:].strip()
            if sec.lower().startswith("/review"):
                sec = "review"
            continue
        if sec in body:
            body[sec].append(l)
    region = body["노드"] if body["노드"] else body[""]
    nodes = []
    for l in region:
        if "|" not in l:
            continue
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        if len(cells) >= 2 and WAVE_KEY.match(cells[0]):
            nodes.append({"key": cells[0], "state": norm_state(cells[1])})
    dur = " ".join(l.strip() for l in body["소요"] if l.strip())
    first = next((l.strip() for l in body["review"] if l.strip()), "")
    return {"at": _wave_at(head.group(1), fallback_at), "thread": head.group(2), "nodes": nodes, "dur": dur,
            "review": review_kind(first)}


def review_kind(line: str) -> str:
    """'/review' 첫 줄 → ok(승인)·fix(수정 요청)·no(미실행)·skip(생략)·''(없음). 한 줄 서술이라 낱말로 가른다."""
    l = line.lower()
    if not l:
        return ""
    if "미실행" in l or "돌리지 않" in l or "부르지 못" in l:
        return "no"
    if "생략" in l:
        return "skip"
    if ("approve" in l or "승인" in l or "통과" in l) and "request_changes" not in l:
        return "ok"
    if "request_changes" in l or "수정 요청" in l or "고침" in l or "고쳐" in l or "p1" in l:
        return "fix"
    return ""


def read_waves(tdir: Path) -> tuple[list[dict], list[dict]]:
    """티켓 폴더의 wave-*.md → (오래된 순 waves, 경고). 번호 w는 1부터. 못 읽는 보고서는 건너뛰고 경고만."""
    waves, warns = [], []
    for f in sorted(tdir.glob("wave-*.md")):
        try:
            w = parse_wave(f.read_text(encoding="utf-8"), f.stem[len("wave-"):])
        except (OSError, UnicodeDecodeError):
            w = None
        if not w or not w["nodes"]:
            warns.append(_warn("wave-unreadable", f"웨이브 보고서를 읽지 못해 건너뜀: {f.name}"))
            continue
        w["file"] = f.name
        waves.append(w)
    waves.sort(key=lambda w: (w["at"] if len(w["at"]) > 10 else w["at"] + " 99:99", w["file"]))  # 시각 없는 날짜는 그날 맨 뒤
    for i, w in enumerate(waves, 1):
        w["w"] = i
    return waves, warns


def git_branch(root: Path) -> str:
    """레포의 지금 브랜치. .git이 파일(링크된 워크트리)이면 gitdir을 따라간다. 못 읽거나 분리 HEAD면 ''."""
    g = root / ".git"
    try:
        if g.is_file():
            m = re.match(r"gitdir:\s*(.+)", g.read_text(encoding="utf-8").strip())
            g = (root / m.group(1).strip()).resolve() if m else g
        head = (g / "HEAD").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""
    return head[len("ref: refs/heads/"):] if head.startswith("ref: refs/heads/") else ""


def sheet_state(t: dict) -> str:
    """사이드바 묶음 — 진행 중 · 준비 · 끝남. 상태 칸은 덮지 않는다: 노드가 다 끝났거나 머리 상태가 끝남이면 끝남."""
    nodes = [n for n in t.get("nodes", []) if not n.get("error")]
    if t.get("state") == "끝남" or (nodes and all(n["state"] == "끝남" for n in nodes)):
        return "끝남"
    if not nodes or all(n["state"] == "아직 안 함" for n in nodes) and not t.get("waves"):
        return "준비"
    return "진행 중"


def sheet_summary(t: dict) -> dict:
    """사이드바 줄 하나 — 제목·상태 묶음·n/m·막는 결정·확인 대기·마지막 웨이브 시각."""
    nodes = [n for n in t.get("nodes", []) if not n.get("error")]
    waves = t.get("waves") or []
    return {
        "slug": t["slug"], "title": t.get("title", t["slug"]), "group": sheet_state(t),
        "done": sum(1 for n in nodes if n["state"] == "끝남"), "total": len(nodes),
        "blocking": sum(1 for r in t.get("rows", []) if r.get("kind") == "decision" and r.get("blocking")),
        "to_check": sum(1 for n in nodes if n["state"] == "확인 대기"),
        "last": waves[-1]["at"] if waves else "", "archived": bool(t.get("archived")),
    }


def build_board(root: Path) -> dict:
    """한 레포의 보드 모델. 프로젝트(줄기) → 티켓 → 노드·행. 결정은 티켓의 rows에만 있다 — 화면이 거기서 모은다."""
    spec = root / "spec"
    projects: dict[str, dict] = {}
    for slug, tdir in find_tickets(root).items():
        try:
            t = _read_ticket(slug, tdir)
        except Exception as e:  # 한 티켓이 깨져도 보드는 그린다
            t = {"slug": slug, "title": tdir.name, "problem": "", "state": "모름", "error": f"읽기 실패: {e.__class__.__name__}: {e}",
                 "nodes": [], "rows": [], "warnings": [], "counts": {c: 0 for c in COLUMNS}, "unowned": [],
                 "scenarios": {"total": 0, "passed": 0}, "priority": "", "paused": False, "archived": False, "head": {}, "id_head": "", "waves": []}
        pdir = project_of(spec, tdir)
        pkey = str(pdir.relative_to(spec)) if pdir else ""
        if pkey not in projects:
            ptitle, pproblem, pstate, poutcome = "줄기 없음", "", "", ""
            if pdir:
                try:
                    pl = _read_clean(spec, pdir / "README.md").splitlines()
                    h = head_table(pl)
                    ptitle, pproblem = title_of(pl, pdir.name), h.get("문제", "")
                    pstate = norm_state(h["상태"]) if "상태" in h else ""
                    poutcome = first_line_under(pl, "끝난 모습")
                except (OSError, UnicodeDecodeError):
                    ptitle = pdir.name
            projects[pkey] = {"key": pkey, "title": ptitle, "problem": pproblem, "outcome": poutcome,
                              "state": pstate, "tickets": []}
        t["project"] = pkey
        projects[pkey]["tickets"].append(t)
    ordered = [projects[k] for k in sorted(projects, key=lambda k: (k == "", k))]
    live = [t for p in ordered for t in p["tickets"] if not t.get("archived")]   # 보관한 시트는 Inbox·Decisions 숫자에 넣지 않는다
    all_nodes = [n for t in live for n in t["nodes"]]
    decisions = [r for t in live for r in t["rows"] if r["kind"] == "decision"]
    return {
        "v": board_version(root), "root": str(root), "branch": git_branch(root), "projects": ordered,
        "summary": {
            "tickets": sum(len(p["tickets"]) for p in ordered), "nodes": len(all_nodes),
            "decisions_open": sum(1 for d in decisions if d["open"]),
            "decisions_blocking": sum(1 for d in decisions if d["blocking"]),
            "to_check": sum(1 for n in all_nodes if n["state"] == "확인 대기"),
            "warnings": sum(len(n["warnings"]) for n in all_nodes) + sum(len(t["warnings"]) for t in live),
        },
    }


def main(argv: list[str]) -> int:
    root = Path(argv[0]).expanduser().resolve() if argv else Path.cwd()
    print(json.dumps(build_board(root), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
