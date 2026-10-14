"""spec-board install-skills — 같이 들어 있는 에이전트 스킬을 Claude Code·Codex 등의 스킬 폴더에 설치한다.

  spec-board install-skills                         대상을 고르는 TUI(터미널이면). ↑↓ 이동 · space 선택 · a 전체 · enter 적용 · q 취소
  spec-board install-skills --target claude,codex   고른 곳에 바로 설치 (claude · codex · agents · 또는 폴더 경로)
  spec-board install-skills --list                  어디에 설치돼 있는지만 본다
  spec-board install-skills --uninstall --target …  이 명령이 설치한 것만 지운다

복사본을 둔다(링크가 아니다). 패키지를 갱신한 뒤 다시 실행하면 새 내용으로 바꾼다.
이 명령이 만들지 않은 같은 이름의 폴더는 덮어쓰지 않는다(--force가 있어야 한다).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import unicodedata
from pathlib import Path

SKILL = "spec-board"
MARKER = ".spec-board-skill"
TARGETS = {"claude": "~/.claude/skills", "codex": "~/.codex/skills", "agents": "~/.agents/skills"}
LABEL = {"claude": "Claude Code", "codex": "Codex", "agents": "공용(~/.agents)"}


def pad(text: str, width: int) -> str:
    """표시 폭(한글 2칸) 기준으로 오른쪽을 채운다."""
    w = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)
    return text + " " * max(width - w, 1)


def bundle() -> Path:
    return Path(__file__).resolve().parent / "skills" / SKILL


def bundle_hash() -> str:
    """번들 내용의 지문 — 설치본이 최신인지 가른다."""
    h = hashlib.sha256()
    for f in sorted(p for p in bundle().rglob("*") if p.is_file()):
        h.update(str(f.relative_to(bundle())).encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:16]


def root_of(target: str) -> Path:
    """대상 이름(claude·codex·agents) 또는 폴더 경로 → 스킬 폴더."""
    return Path(os.path.expanduser(TARGETS.get(target, target))).resolve() if target in TARGETS else Path(os.path.expanduser(target)).resolve()


def dest_of(target: str) -> Path:
    return root_of(target) / SKILL


def state(target: str) -> str:
    """none(없음) · current(최신) · stale(갱신 필요) · foreign(이 명령이 만들지 않은 폴더)."""
    d = dest_of(target)
    if not d.exists():
        return "none"
    m = d / MARKER
    if not m.is_file():
        return "foreign"
    return "current" if m.read_text(encoding="utf-8").strip() == bundle_hash() else "stale"


STATE_TEXT = {"none": "설치 안 됨", "current": "설치됨(최신)", "stale": "설치됨(갱신 필요)", "foreign": "같은 이름 폴더가 있음(덮어쓰지 않음)"}


def install(target: str, force: bool = False) -> str:
    """설치하고 결과 문장을 돌려준다. 못 하면 ValueError."""
    s = state(target)
    d = dest_of(target)
    if s == "foreign" and not force:
        raise ValueError(f"{d}에 이 명령이 만들지 않은 폴더가 있다 — 덮어쓰지 않는다(--force)")
    if s == "current":
        return f"이미 최신: {d}"
    if d.exists():
        shutil.rmtree(d)
    d.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(bundle(), d, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
    (d / MARKER).write_text(bundle_hash() + "\n", encoding="utf-8")
    return f"{'갱신' if s == 'stale' else '설치'}: {d}"


def uninstall(target: str) -> str:
    s = state(target)
    d = dest_of(target)
    if s == "none":
        return f"설치돼 있지 않다: {d}"
    if s == "foreign":
        raise ValueError(f"{d}는 이 명령이 만든 폴더가 아니다 — 지우지 않는다")
    shutil.rmtree(d)
    return f"삭제: {d}"


# ── 고르기 ────────────────────────────────────────────────────

def rows() -> list[dict]:
    """고를 수 있는 대상. 홈 아래 스킬 폴더의 부모(~/.claude 등)가 있는 곳을 미리 고른다."""
    out = []
    for t in TARGETS:
        parent = root_of(t).parent
        out.append({"key": t, "label": LABEL[t], "path": str(dest_of(t)), "state": state(t), "on": parent.is_dir() and state(t) != "foreign"})
    return out


def step(items: list[dict], cur: int, key: str) -> tuple[int, str]:
    """키 하나를 반영한다. 돌려주는 값: (커서, 결과 '' | 'apply' | 'cancel'). items의 on을 바꾼다."""
    n = len(items)
    if key in ("up", "k"):
        return (cur - 1) % n, ""
    if key in ("down", "j"):
        return (cur + 1) % n, ""
    if key == "space":
        items[cur]["on"] = not items[cur]["on"]
        return cur, ""
    if key == "a":
        on = not all(i["on"] for i in items)
        for i in items:
            i["on"] = on
        return cur, ""
    if key == "enter":
        return cur, "apply"
    if key in ("q", "esc"):
        return cur, "cancel"
    return cur, ""


def _tui(items: list[dict]) -> bool:
    import curses

    keymap = {curses.KEY_UP: "up", curses.KEY_DOWN: "down", ord(" "): "space", 10: "enter", 13: "enter", 27: "esc", ord("q"): "q",
              ord("a"): "a", ord("j"): "j", ord("k"): "k"}

    def run(scr) -> bool:
        curses.curs_set(0)
        cur = 0
        while True:
            scr.erase()
            scr.addstr(0, 0, "spec-board 스킬을 설치할 곳")
            scr.addstr(1, 0, "↑↓ 이동 · space 선택 · a 전체 · enter 적용 · q 취소", curses.A_DIM)
            for i, it in enumerate(items):
                line = f" [{'x' if it['on'] else ' '}] {pad(it['label'], 16)}{STATE_TEXT[it['state']]}"
                scr.addstr(3 + 2 * i, 0, line, curses.A_REVERSE if i == cur else curses.A_NORMAL)
                scr.addstr(4 + 2 * i, 6, it["path"], curses.A_DIM)
            scr.refresh()
            cur, res = step(items, cur, keymap.get(scr.getch(), ""))
            if res:
                return res == "apply"

    return curses.wrapper(run)


def _prompt(items: list[dict]) -> bool:
    for i, it in enumerate(items, 1):
        print(f"  {i}. {pad(it['label'], 16)}{STATE_TEXT[it['state']]}  {it['path']}")
    raw = input("설치할 번호(쉼표, 전체는 a, 취소는 빈 줄): ").strip().lower()
    if not raw:
        return False
    for it in items:
        it["on"] = False
    picks = range(1, len(items) + 1) if raw == "a" else [int(x) for x in raw.replace(" ", "").split(",") if x.isdigit()]
    for p in picks:
        if 1 <= p <= len(items):
            items[p - 1]["on"] = True
    return True


def choose(items: list[dict]) -> bool:
    try:
        import curses  # noqa: F401
        if os.environ.get("TERM", "dumb") != "dumb":
            return _tui(items)
    except ImportError:
        pass
    return _prompt(items)


# ── 명령 ──────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    targets: list[str] = []
    do_list = do_un = force = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--target" and i + 1 < len(argv):
            targets += [t for t in argv[i + 1].split(",") if t]
            i += 1
        elif a == "--list":
            do_list = True
        elif a == "--uninstall":
            do_un = True
        elif a == "--force":
            force = True
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            sys.exit(f"모르는 옵션: {a} (spec-board install-skills --help)")
        i += 1
    if not (bundle() / "SKILL.md").is_file():
        sys.exit("패키지에 스킬이 들어 있지 않다")
    if do_list:
        for it in rows():
            print(f"{it['key']}\t{STATE_TEXT[it['state']]}\t{it['path']}")
        return 0
    if not targets:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            sys.exit("대상을 --target claude,codex,agents(또는 폴더 경로)로 알려 준다. 터미널에서는 TUI가 뜬다.")
        items = rows()
        if not choose(items):
            print("취소")
            return 1
        targets = [it["key"] for it in items if it["on"]]
        if not targets:
            print("고른 곳이 없다")
            return 1
    code = 0
    for t in targets:
        try:
            print((uninstall if do_un else lambda x: install(x, force))(t))
        except ValueError as e:
            print(f"건너뜀: {e}", file=sys.stderr)
            code = 1
    return code

