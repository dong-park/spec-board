#!/usr/bin/env python3
"""migrate_format.py — spec 형식 린트. 쓰지 않는다. 위반이 있으면 종료 코드 1.

  python3 migrate_format.py [--check] <줄기 폴더 또는 티켓 폴더>...

줄기 폴더는 티켓 폴더(`spec/<줄기>/<슬러그>/` = `spec.md` + `rows/`)들의 묶음이다. 티켓 폴더를 바로 줘도 된다.

본다:
- 티켓 머리 표 `상태`(여섯 값 + 재확인 필요)·`ID 머리`
- 노드 브리프 `**상태**:`(여섯 값)·`**id**:`·`**담당 행**:` 꼴(`없음` 또는 `T1, T2`)
- 행 `rows/*.json` `status`(여섯 값)
- 같은 레포 안 ID 머리·노드 id 중복

노드 인덱스 표의 상태 열은 참고용이라 보지 않는다 — 노드 상태의 원본은 브리프 `**상태**:` 한 곳이다.
값 뒤에 붙은 HTML 주석(`진행 <!-- 아직 안 함 | 진행 … -->`)은 값이 아니라서 떼고 비교한다.
읽을 수 없는 파일은 위반이 아니라 "건너뜀"으로 세어 알린다.

옛 형식을 새 형식으로 바꾸던 이행 코드는 지웠다 — 한 번 쓰고 끝난 일이고 git 기록에 남아 있다.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spec_model import SIX, brief_files, json_files   # 여섯 값은 states.json 한 곳

TICKET_OK = SIX + ["재확인 필요"]
NODE_OK = list(SIX)
ROW_OK = list(SIX)

STATE_LINE = re.compile(r"^(\*\*상태\*\*:\s*)(.*)$")
DAM_LINE = re.compile(r"^(\*\*담당 행\*\*:\s*)(.*)$")
TICKET_STATE = re.compile(r"^(\|\s*상태\s*\|\s*)([^|]*)(\|\s*)$")
HEAD_ROW = re.compile(r"^\|\s*ID 머리\s*\|")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)


def strip_comments(text: str) -> str:
    """HTML 주석을 뗀다. 줄 수는 그대로 둔다 — 위반 줄 번호가 원본과 맞게."""
    return HTML_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


# ── 줄기/티켓/레포 ────────────────────────────────────────────

def ticket_dirs(paths: list[Path]) -> list[Path]:
    out, seen = [], set()
    for raw in paths:
        p = Path(raw).expanduser()
        if p.is_file():
            p = p.parent
        cands: list[Path] = []
        if (p / "spec.md").is_file() and (p / "rows").is_dir():
            cands = [p]
        elif p.is_dir():
            cands = sorted(q.parent for q in p.rglob("rows")
                           if q.is_dir() and (q.parent / "spec.md").is_file())
        for c in cands:
            c = c.resolve()
            if c not in seen:
                seen.add(c)
                out.append(c)
    return out


def repo_root(ticket: Path) -> Path:
    for anc in [ticket.resolve(), *ticket.resolve().parents]:
        if (anc / ".git").exists():
            return anc
    for anc in [ticket.resolve(), *ticket.resolve().parents]:
        if anc.name == "spec":
            return anc.parent
    return ticket.parent


def repo_tickets(repo: Path) -> list[Path]:
    spec = repo / "spec"
    if not spec.is_dir():
        return []
    return sorted(q.parent.resolve() for q in spec.rglob("rows")
                  if q.is_dir() and (q.parent / "spec.md").is_file())


def ticket_head(spec_text: str) -> str:
    for l in strip_comments(spec_text).split("\n"):
        if HEAD_ROW.match(l):
            cells = _cells(l)
            return cells[1] if len(cells) >= 2 else ""
    return ""


def _iter_nodes(ticket: Path):
    return brief_files(ticket)   # 심볼릭 링크 브리프는 읽지 않는다


# ── 검사 ─────────────────────────────────────────────────────

def _first(text: str, pat: re.Pattern) -> tuple[int, str] | None:
    """(줄 번호, 값) — 값은 주석을 뗀 칸 내용."""
    for i, l in enumerate(text.split("\n"), 1):
        m = pat.match(l)
        if m:
            return i, m.group(2).strip()
    return None


def check(paths: list[Path], out=sys.stdout) -> int:
    tickets = ticket_dirs(paths)
    if not tickets:
        print("티켓 폴더를 못 찾았다 — spec.md + rows/가 있는 폴더를 줘라", file=out)
        return 1

    v: list[str] = []
    skipped: list[tuple[Path, str]] = []

    def bad(p: Path, msg: str, line: int | None = None) -> None:
        v.append(f"{p}:{line}: {msg}" if line else f"{p}: {msg}")

    for ticket in tickets:
        spec = ticket / "spec.md"
        if spec.is_symlink():
            skipped.append((spec, "심볼릭 링크 — 읽지 않는다"))
            continue
        try:
            txt = strip_comments(spec.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as e:
            skipped.append((spec, f"읽기 실패 — {e}"))
            continue
        # 티켓 머리 표 상태
        st = _first(txt, TICKET_STATE)
        if st is not None and st[1] not in TICKET_OK:
            bad(spec, f"어휘 밖 값 {st[1]!r}", st[0])
        if not ticket_head(txt):
            bad(spec, "ID 머리 없음")
        # 노드 브리프
        for node in _iter_nodes(ticket):
            try:
                nt = strip_comments(node.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError) as e:
                skipped.append((node, f"읽기 실패 — {e}"))
                continue
            ns = _first(nt, STATE_LINE)
            if ns is not None and ns[1] not in NODE_OK:
                bad(node, f"어휘 밖 값 {ns[1]!r}", ns[0])
            if not re.search(r"^\*\*id\*\*:", nt, re.M):
                bad(node, "id 없음")
            dm = _first(nt, DAM_LINE)
            if dm is None:
                bad(node, "담당 행 꼴 위반 — **담당 행** 줄이 없음")
            elif not re.fullmatch(r"없음|T\d+(?:, T\d+)*", dm[1]):
                bad(node, f"담당 행 꼴 위반 {dm[1]!r}", dm[0])
        # 행 JSON
        for row in json_files(ticket / "rows", ticket):
            try:
                r = json.loads(row.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
                skipped.append((row, f"깨진 행 — {e}"))
                continue
            raw_st = r.get("status") if isinstance(r, dict) else None
            if raw_st not in ROW_OK:
                bad(row, f"어휘 밖 값 {raw_st!r}")

    v += _dup_violations(tickets)

    print(f"검사: 티켓 {len(tickets)} · 위반 {len(v)}줄"
          + (f" · 건너뜀 {len(skipped)}" if skipped else ""), file=out)
    for line in v:
        print("  " + line, file=out)
    for p, why in skipped:
        print(f"  (건너뜀) {p}: {why}", file=out)
    return 1 if v else 0


def _dup_violations(tickets: list[Path]) -> list[str]:
    out: list[str] = []
    for repo in sorted({repo_root(t) for t in tickets}):
        rh: dict[str, list[Path]] = {}
        node_ids: dict[str, list[Path]] = {}
        for t in repo_tickets(repo):
            try:
                sp = t / "spec.md"
                txt = "" if sp.is_symlink() else sp.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                txt = ""
            h = ticket_head(txt)
            if h:
                rh.setdefault(h, []).append(t)
            for n in brief_files(t):
                try:
                    nt = strip_comments(n.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError):
                    continue
                mm = re.search(r"^\*\*id\*\*:\s*(\S+)", nt, re.M)
                if mm:
                    node_ids.setdefault(mm.group(1), []).append(n)
        for h, owners in rh.items():
            if len(owners) > 1:
                names = [o.name for o in owners]
                for o in owners:
                    out.append(f"{o / 'spec.md'}: ID 중복 — 머리 {h!r}가 {names}에 겹침")
        for nid, owners in node_ids.items():
            if len(owners) > 1:
                for n in owners:
                    out.append(f"{n}: ID 중복 — 노드 id {nid!r}가 겹침")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="spec 형식 린트 — 쓰지 않는다. 위반이 있으면 1")
    ap.add_argument("--check", action="store_true", help="(기본 동작이다. 예전 호출과 맞추려고 받는다)")
    ap.add_argument("paths", nargs="+", help="줄기 폴더 또는 티켓 폴더")
    a = ap.parse_args(argv)
    return check(a.paths)


if __name__ == "__main__":
    sys.exit(main())
