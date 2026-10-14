#!/usr/bin/env python3
"""노드 브리프 상태 쓰기 — runner가 자기 브리프의 `**상태**:`만 막힘·확인 대기로 쓴다.

노드 상태의 원본은 브리프 `**상태**:` 한 곳이다. 노드 인덱스 표의 상태 열은 참고용이라 누구도 읽지도 쓰지도 않는다
(병렬 runner가 같은 표를 고치면 서로 덮는다). 여기서는 runner가 아는 두 값(막힘·확인 대기)만 브리프에 남긴다.
브리프 잠금(`<브리프>.lock` flock)은 graph-run과 같은 파일을 잡는다.

  node_state.py set <브리프> <상태>
      `**상태**:` 한 줄만 바꾼다. 여섯 값 밖이면 거부한다.

  node_state.py block <브리프> --title <제목> --option A:<라벨> --option B:<라벨> [--recommend A]
      티켓 rows/D<다음 번호>.json 결정 행을 만들고 blocks에 이 노드를 넣은 뒤 상태를 막힘으로 쓴다.
      상태 줄이 없으면 행도 만들지 않는다. 같은 제목으로 이 노드만 막는 열린 결정이 있으면 새로 만들지 않고 재사용한다(`reused`).

  node_state.py review <브리프> [--evidence <경로> ...]
      근거를 evidence/<노드>/로 옮기고 상태를 확인 대기로 쓴다(D4). evidence는 git에서 제외한다.
      근거가 하나라도 없거나 상태 줄이 없으면 아무것도 옮기지 않고 거부한다. 중간에 실패하면 옮긴 것을 되돌린다.

  node_state.py verdict <브리프>
      사람이 보드에서 남긴 통과·고쳐줘(rows/nodes/<노드>.json)를 브리프에 반영하고 그 칸을 비운다(D-R1).
      통과 → 상태 끝남. 고쳐줘 → 상태 진행 + `## 구현 메모`에 fix 한 줄. 한 번만 반영한다 — 칸이 비었으면 아무것도 안 한다.
      통과·고쳐줘는 상태가 확인 대기·끝남일 때만 받는다(진행 중이면 칸을 그대로 두고 applied:false). 같은 fix는 날짜와
      상관없이 구현 메모에 한 번만 쌓는다.
      /go가 턴 시작에 apply가 낸 kind=node 항목마다 부른다.

티켓 폴더 = 브리프의 부모. rows/·evidence/가 그 밑에 있다. 노드 id는 브리프 파일 이름 앞토막(n7-... → n7).
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sheet  # 행 잠금(rows/.lock)과 원자적 JSON 쓰기는 보드 서버·apply와 같은 것을 쓴다
from spec_model import SIX, clean_path, node_file, norm_state   # 여섯 값은 states.json 한 곳

ID_RE = re.compile(r"^D(\d+)\.json$")


# ── 브리프 상태 줄 ────────────────────────────────────────────

def _split_comment(line: str) -> tuple[str, str]:
    i = line.find("<!--")
    if i == -1:
        return line.rstrip(), ""
    return line[:i].rstrip(), line[i:].rstrip()


def read_status(text: str) -> str | None:
    for line in text.split("\n"):
        if line.startswith("**상태**:"):
            body, _ = _split_comment(line)
            return body.split(":", 1)[1].strip()
    return None


def _replace_status(text: str, status: str) -> tuple[str, bool]:
    """`**상태**:` 줄 하나만 바꾼다. 뒤에 붙은 HTML 주석은 그대로 둔다."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("**상태**:"):
            body, comment = _split_comment(line)
            label = body.split(":", 1)[0]
            lines[i] = f"{label}: {status}" + (f" {comment}" if comment else "")
            return "\n".join(lines), True
    return text, False


def _write_atomic(path: Path, text: str) -> None:
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as w:
        w.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


@contextlib.contextmanager
def locked(brief: Path):
    """브리프 파일 잠금. graph-run(n6)도 같은 `<브리프>.lock`을 잡는다."""
    with sheet.open_lock(brief.with_name(brief.name + ".lock")) as lf:   # 잠금 자리가 심볼릭 링크면 거부
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def node_id(brief: Path) -> str:
    head = brief.stem.split("-", 1)[0]
    return head if re.fullmatch(r"[A-Za-z0-9_]+", head) else brief.stem


def _require_real(brief: Path) -> None:
    """브리프가 심볼릭 링크면 읽지도 쓰지도 않는다 — 폴더 밖 파일을 브리프로 고치지 않게."""
    if brief.is_symlink():
        raise SystemExit(f"브리프가 심볼릭 링크다 — 건드리지 않는다: {brief}")


def _clean(ticket: Path, path: Path, what: str) -> None:
    """티켓 폴더 안의 실제 경로인지 본다. 아니면 아무것도 쓰기 전에 거부한다."""
    if not clean_path(ticket, path):
        raise SystemExit(f"{what}이(가) 심볼릭 링크이거나 티켓 폴더 밖이다 — 건드리지 않는다: {path}")


def _brief(arg: str) -> Path:
    raw = Path(arg).expanduser()
    p = raw.parent.resolve() / raw.name   # 폴더는 따라가되 브리프 파일 자체가 링크인지는 본다
    _require_real(p)
    if not p.is_file():
        raise SystemExit(f"브리프가 없다: {p}")
    return p


def set_status(brief: Path, status: str) -> str:
    if status not in SIX:
        raise SystemExit(f"여섯 값 밖이다: {status!r} — {' · '.join(SIX)}")
    _require_real(brief)
    with locked(brief):
        new, found = _replace_status(brief.read_text(encoding="utf-8"), status)
        if not found:
            raise SystemExit(f"`**상태**:` 줄이 없다: {brief}")
        _write_atomic(brief, new)
    return status


# ── 결정 행 만들기 ────────────────────────────────────────────

def _next_decision(rows: Path) -> str:
    nums = [int(m.group(1)) for f in rows.glob("D*.json") if (m := ID_RE.match(f.name))]
    return f"D{max(nums, default=0) + 1}"


def _parse_option(spec: str) -> dict:
    key, _, label = spec.partition(":")
    key = key.strip()
    if not key:
        raise SystemExit(f"선택지 key가 비었다: {spec!r}")
    return {"key": key, "label": label.strip(), "why": ""}


def _require_status_line(brief: Path) -> None:
    """상태 줄이 없으면 아무것도 만들기 전에 거부한다 — 행·근거만 남고 상태가 안 바뀌는 반쪽을 막는다."""
    if read_status(brief.read_text(encoding="utf-8")) is None:
        raise SystemExit(f"`**상태**:` 줄이 없다: {brief}")


def _find_open_decision(rows: Path, title: str, node: str) -> dict | None:
    """같은 제목으로 이 노드만 막는 열린 결정. 같은 막힘을 두 번 보고해도 행이 늘지 않게 한다."""
    for f in sorted(sheet.json_files(rows, rows.parent)):
        if not ID_RE.match(f.name):
            continue
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (isinstance(r, dict) and r.get("kind") == "decision" and r.get("title") == title
                and norm_state(str(r.get("status", ""))) != "끝남"
                and {str(b) for b in r.get("blocks") or []} == {node}):
            return r
    return None


def block(brief: Path, title: str, options: list[str], recommend: str = "",
          given: str = "", when: str = "", then: str = "", reversible: bool = False) -> dict:
    rows = brief.parent / "rows"
    if not rows.is_dir():
        raise SystemExit(f"rows/ 폴더가 없다: {rows}")
    _require_real(brief)
    _clean(brief.parent, rows, "rows/")
    opts = [_parse_option(o) for o in options]
    if not opts:
        raise SystemExit("선택지가 하나도 없다 — --option A:... 를 준다")
    _require_status_line(brief)
    node = node_id(brief)
    with sheet.locked(brief.parent):
        row = _find_open_decision(rows, title, node)
        reused = row is not None
        if row is None:
            rid = _next_decision(rows)
            row = {
                "id": rid, "kind": "decision", "title": title,
                "given": given, "when": when, "then": then,
                "options": opts, "recommend": recommend or opts[0]["key"],
                "confidence": "low", "reversible": reversible,
                "status": "아직 안 함", "blocks": [node],
                "user": {"answer": "", "fix": ""}, "log": [],
            }
            sheet.write_json(rows / f"{rid}.json", row)
    set_status(brief, "막힘")
    return {**row, "reused": reused}


# ── 확인 대기 ─────────────────────────────────────────────────

def review(brief: Path, evidence: list[str]) -> dict:
    """근거를 evidence/<노드>/로 옮기고 확인 대기로 쓴다. 전부 갖춰졌을 때만 움직이고, 중간에 실패하면 되돌린다."""
    node = node_id(brief)
    dest = brief.parent / "evidence" / node
    _require_real(brief)
    _clean(brief.parent, dest, "evidence/")
    _require_status_line(brief)
    srcs = [Path(e).expanduser() for e in evidence]
    links = [str(p) for p in srcs if p.is_symlink()]
    if links:
        raise SystemExit(f"근거가 심볼릭 링크다: {', '.join(links)} — 아무것도 옮기지 않았다")
    missing = [str(p) for p in srcs if not p.exists()]
    if missing:
        raise SystemExit(f"근거가 없다: {', '.join(missing)} — 아무것도 옮기지 않았다")
    names = [p.name for p in srcs]
    dup = sorted({n for n in names if names.count(n) > 1})
    if dup:
        raise SystemExit(f"근거 파일 이름이 겹친다: {', '.join(dup)} — 서로 덮게 된다")
    moved: list[str] = []
    # [원래 자리, 옮긴 자리, 밀려난 이전 근거 백업, 옮겼는가] — 백업을 만든 직후에 등록해 두어야
    # 옮기다 실패해도 되돌릴 때 백업이 제자리로 돌아간다
    done: list[list] = []
    try:
        if srcs:
            dest.mkdir(parents=True, exist_ok=True)
        for p in srcs:
            target = dest / p.name
            if target.exists() and p.resolve() == target.resolve():   # 이미 그 자리에 있는 근거 — 옮길 것이 없다
                moved.append(str(target))
                continue
            entry: list = [p, target, None, False]
            if target.exists():   # 다시 확인 대기로 올릴 때 같은 이름은 새 것으로 바꾼다 — 실패하면 되돌릴 수 있게 백업
                entry[2] = dest / f".prev-{p.name}"
                os.replace(target, entry[2])
            done.append(entry)
            shutil.move(str(p), str(target))
            entry[3] = True
            moved.append(str(target))
        set_status(brief, "확인 대기")
    except BaseException:
        for src, target, backup, did_move in reversed(done):
            try:
                if did_move:
                    shutil.move(str(target), str(src))
            except OSError:
                pass
            try:
                if backup is not None and backup.exists():
                    os.replace(backup, target)
            except OSError:
                pass
        raise
    for _, _, backup, _ in done:
        if backup is not None:
            backup.unlink(missing_ok=True)
    return {"node": node, "status": "확인 대기", "evidence": moved, "dir": str(dest)}


# ── 사람 확인 반영 (D-R1) ─────────────────────────────────────

MEMO_HEAD = "## 구현 메모"
# 통과·고쳐줘를 받아들이는 지금 상태. 이 밖이면 칸을 두고 건너뛴다 — 칸은 사람이 쓴 것이라 조용히 버리지 않는다.
PASS_FROM = ("확인 대기", "끝남")
FIX_FROM = ("확인 대기", "끝남")   # 진행은 뺀다 — runner가 도는 중이거나 이미 되돌린 노드에 같은 요청이 겹쳐 들어오면 칸을 그대로 둔다
FIX_LINE = re.compile(r"^- 고쳐줘 \([^)]*\): (.*)$")


def _fix_recorded(text: str, fix: str) -> bool:
    """같은 fix가 구현 메모에 이미 있는가. 날짜는 키가 아니다 — 하루 지나도 같은 요청을 또 쌓지 않는다."""
    return any((m := FIX_LINE.match(l)) is not None and m.group(1).strip() == fix for l in text.split("\n"))


def _add_memo(text: str, line: str) -> tuple[str, bool]:
    """`## 구현 메모` 절 끝에 한 줄을 더한다. 절이 없으면 파일 끝에 만든다. 같은 줄이 이미 있으면 안 더한다."""
    if line in text.split("\n"):
        return text, False
    lines = text.split("\n")
    start = next((i for i, l in enumerate(lines) if l.strip().startswith(MEMO_HEAD)), None)
    if start is None:
        body = text.rstrip("\n")
        return f"{body}\n\n{MEMO_HEAD}\n\n{line}\n", True
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    at = end
    while at > start + 1 and not lines[at - 1].strip():
        at -= 1
    lines.insert(at, line)
    return "\n".join(lines), True


def verdict(brief: Path, today: str | None = None) -> dict:
    """노드 사람 칸의 verdict·fix를 브리프에 반영하고 비운다. 브리프 잠금 → 행 잠금 순서로 잡는다."""
    today = today or time.strftime("%Y-%m-%d")
    ticket, key = brief.parent, node_id(brief)
    f = node_file(ticket, key)
    base = {"node": key, "applied": False}
    _require_real(brief)
    if not f.exists():
        return {**base, "reason": "사람 칸 파일이 없다"}
    if not clean_path(ticket, f):   # rows/·rows/nodes/·칸 파일이 심볼릭 링크 — 읽지도 쓰지도 않는다
        return {**base, "reason": "사람 칸 파일이 심볼릭 링크이거나 티켓 폴더 밖이다 — 칸을 그대로 둔다"}
    with locked(brief), sheet.locked(ticket):
        r = json.loads(f.read_text(encoding="utf-8"))
        user = r.get("user") if isinstance(r.get("user"), dict) else {}
        v, fix = str(user.get("verdict", "")).strip(), " ".join(str(user.get("fix", "")).split())
        if not v and not fix:
            return {**base, "reason": "반영할 칸이 비어 있다"}
        if v not in ("통과", "고쳐줘"):
            return {**base, "reason": f"verdict 없이 fix만 있다 — 칸을 그대로 둔다" if not v else f"모르는 verdict: {v!r}"}
        text = brief.read_text(encoding="utf-8")
        raw = read_status(text)
        if raw is None:
            return {**base, "reason": "브리프에 `**상태**:` 줄이 없다"}
        now = norm_state(raw)
        target, allowed = ("끝남", PASS_FROM) if v == "통과" else ("진행", FIX_FROM)
        fix_text = fix or "(내용 없음)"
        # 브리프엔 반영됐는데 칸을 못 비우고 죽은 경우 — 상태는 이미 진행이고 같은 fix가 메모에 있다. 칸만 비운다
        repair = v == "고쳐줘" and now == "진행" and _fix_recorded(text, fix_text)
        if now not in allowed and not repair:
            return {**base, "verdict": v, "status": now,
                    "reason": f"{v}는 상태가 {' · '.join(allowed)}일 때만 받는다 (지금 {now}) — 칸을 그대로 둔다"}
        new, _ = _replace_status(text, target)
        memo = False
        if v == "고쳐줘" and not _fix_recorded(new, fix_text):
            new, memo = _add_memo(new, f"- 고쳐줘 ({today}): {fix_text}")
        if new != text:
            _write_atomic(brief, new)
        # 브리프에 반영한 뒤에 비운다 — 여기서 죽으면 다음 호출이 같은 값을 다시 받아 같은 결과(멱등)로 끝난다
        log = r.setdefault("log", [])
        for k in ("verdict", "fix"):
            if str(user.get(k, "")).strip():
                log.append(f"{today} user.{k} 반영: {user[k]}")
                user[k] = ""
        r["user"] = user
        sheet.write_json(f, r)
    return {**base, "applied": True, "verdict": v, "status": target, "memo": memo}


# ── CLI ──────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="node_state.py", description="노드 브리프 상태 쓰기")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("set", help="`**상태**:` 한 줄만 바꾼다")
    s.add_argument("brief")
    s.add_argument("status")

    b = sub.add_parser("block", help="결정 행을 만들고 막힘으로 쓴다")
    b.add_argument("brief")
    b.add_argument("--title", required=True)
    b.add_argument("--option", action="append", default=[], metavar="KEY:LABEL")
    b.add_argument("--recommend", default="")
    b.add_argument("--given", default="")
    b.add_argument("--when", default="")
    b.add_argument("--then", default="")
    b.add_argument("--reversible", action="store_true")

    r = sub.add_parser("review", help="근거를 옮기고 확인 대기로 쓴다")
    r.add_argument("brief")
    r.add_argument("--evidence", action="append", default=[])

    v = sub.add_parser("verdict", help="사람의 통과·고쳐줘를 브리프에 반영하고 칸을 비운다")
    v.add_argument("brief")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    brief = _brief(args.brief)
    if args.cmd == "set":
        print(set_status(brief, args.status))
    elif args.cmd == "block":
        row = block(brief, args.title, args.option, args.recommend,
                    args.given, args.when, args.then, args.reversible)
        print(json.dumps({k: row[k] for k in ("id", "status", "blocks", "recommend", "reused")}, ensure_ascii=False))
    elif args.cmd == "review":
        print(json.dumps(review(brief, args.evidence), ensure_ascii=False))
    elif args.cmd == "verdict":
        print(json.dumps(verdict(brief), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
