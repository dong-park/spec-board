#!/usr/bin/env python3
"""graph.py ready <spec.md> — DAG에서 지금 띄울 노드를 결정적으로 낸다.

노드 인덱스 표(ID·브리프·deps)와 각 브리프의 `**상태**:` 줄만 읽는다. 상태 어휘는 states.json 한 벌.
출력 JSON: {"ready": [...], "running": [...], "held": [...], "done": bool, "error": null}
깨진 DAG(표 없음·고리·없는 deps·브리프 없음)면 ready를 비우고 error에 이유 한 줄, 종료 코드 2.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import spec_model


def _natural(k: str) -> tuple:
    return tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.findall(r"\d+|\D+", k))


def _fail(msg: str) -> dict:
    return {"ready": [], "running": [], "held": [], "done": False, "error": msg}


def ready(spec: Path) -> dict:
    try:
        lines = spec.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as e:
        return _fail(f"spec 읽기 실패: {e.__class__.__name__}")
    nodes = spec_model.parse_node_index(lines)
    if not nodes:
        return _fail("노드 인덱스 표가 없다")
    by = {n["key"]: n for n in nodes}
    errs = []
    if len(by) != len(nodes):
        errs.append("노드 ID가 겹친다")
    for k in sorted(by, key=_natural):
        for d in by[k]["deps"]:
            if d not in by:
                errs.append(f"{k}: 없는 노드 {d}를 deps로 가리킨다")
    if errs:
        return _fail("; ".join(errs))
    # 고리: 위상 정렬로 남는 노드
    left = {k: set(by[k]["deps"]) for k in by}
    while True:
        free = [k for k, d in left.items() if not d]
        if not free:
            break
        for k in free:
            del left[k]
        for d in left.values():
            d.difference_update(free)
    if left:
        return _fail("고리: " + ", ".join(sorted(left, key=_natural)))
    state = {}
    for k in sorted(by, key=_natural):
        p = spec.parent / by[k]["brief"]
        try:
            head = spec_model.brief_head(p.read_text(encoding="utf-8").splitlines())
        except (OSError, UnicodeDecodeError):
            return _fail(f"{k}: 브리프 {by[k]['brief']}를 읽을 수 없다")
        state[k] = spec_model.norm_state(head.get("상태", ""))
    held = {k for k, s in state.items() if s not in ("아직 안 함", "진행", "끝남")}
    changed = True
    while changed:
        changed = False
        for k in by:
            if k not in held and state[k] != "끝남" and any(d in held for d in by[k]["deps"]):
                held.add(k)
                changed = True
    order = sorted(by, key=_natural)
    return {
        "ready": [k for k in order if state[k] == "아직 안 함" and k not in held
                  and all(state[d] == "끝남" for d in by[k]["deps"])],
        "running": [k for k in order if state[k] == "진행"],
        "held": [k for k in order if k in held],
        "done": all(s == "끝남" for s in state.values()),
        "error": None,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] != "ready":
        print("usage: graph.py ready <spec.md>", file=sys.stderr)
        return 2
    out = ready(Path(argv[2]))
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    if out["error"]:
        print(out["error"], file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
