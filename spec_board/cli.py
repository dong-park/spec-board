"""spec-board — 사람과 AI가 같은 그래프 작업(프로젝트 → 티켓 → 노드 → 결정)을 보고 답하는 로컬 보드.

  spec-board serve [레포 ...] [--port 8790] [--host 127.0.0.1] [--allow-host <이름>]   보드 서버
  spec-board install-service                    로그인하면 서버가 뜨게 한다 (macOS launchd)
  spec-board add <레포> · remove <레포> · list    보드에 보일 레포 등록 (~/.config/spec-sheet/roots)
  spec-board install-skills                     에이전트 스킬을 Claude Code·Codex 등에 설치 (TUI · --target · --list · --uninstall)

  에이전트용 — 사람 칸 읽기·반영 (규칙: 행의 user 칸은 사람만, 나머지는 에이전트만 쓴다)
  spec-board apply <스펙 폴더>                  사람이 찬 칸을 JSON으로 낸다. 비우지 않는다
  spec-board pending <스펙 폴더>                반영할 입력 개수와 id·kind만
  spec-board wait <스펙 폴더> [--timeout 초]    입력이 생기면 종료 0, 시간이 다 되면 3
  spec-board patch <스펙 폴더> <id> <json|->    user 밖 칸을 잠금 아래 고친다
  spec-board link <스펙 폴더> [--local]         보드 주소
  spec-board node set|block|review|verdict ...  노드 브리프 상태 쓰기
  spec-board ready <spec.md>                    DAG에서 지금 띄울 노드
  spec-board lint <폴더>...                     spec 형식 검사 (쓰지 않는다)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # 안쪽 모듈은 서로를 맨이름(sheet, spec_model)으로 부른다

SHEET_CMDS = {"apply", "pending", "wait", "patch", "link", "install-service", "install-launchd"}


def _conf_lines(conf: Path) -> list[str]:
    return [l.strip() for l in conf.read_text().splitlines() if l.strip() and not l.startswith("#")] if conf.exists() else []


def roots_cmd(cmd: str, args: list[str]) -> int:
    import sheet
    if cmd == "list":
        for k, p in sheet.Registry([]).roots().items():
            print(f"{k}\t{p}")
        return 0
    if len(args) != 1:
        sys.exit(f"사용법: spec-board {cmd} <레포 폴더>")
    root = Path(args[0]).expanduser().resolve()
    if cmd == "add":
        if not root.is_dir():
            sys.exit(f"폴더가 없다: {root}")
        sheet.register_root(root)
        print(root)
        return 0
    keep = [l for l in _conf_lines(sheet.CONF) if Path(l).expanduser().resolve() != root]
    sheet.CONF.write_text("".join(f"{l}\n" for l in keep)) if sheet.CONF.exists() else None
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    cmd, rest = args[0], args[1:]
    if cmd == "serve":
        import sheet
        sys.argv = ["spec-board", *rest]
        return sheet.main()
    if cmd in SHEET_CMDS:
        import sheet
        sys.argv = ["spec-board", *args]
        return sheet.main()
    if cmd in ("add", "remove", "list"):
        return roots_cmd(cmd, rest)
    if cmd == "node":
        import node_state
        return node_state.main(rest)
    if cmd in ("install-skills", "skills"):
        import skills_cmd
        return skills_cmd.main(rest)
    if cmd == "ready":
        import graph
        return graph.main(["graph", "ready", *rest])
    if cmd == "lint":
        import migrate_format
        return migrate_format.main(rest)
    sys.exit(f"모르는 명령: {cmd} (spec-board --help)")


if __name__ == "__main__":
    sys.exit(main())
