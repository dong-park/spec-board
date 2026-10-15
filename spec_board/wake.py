"""보드가 담당 스레드를 깨울 때 보내는 메시지 (spec/board-wake n2).

순수 함수만 둔다 — 파일·시계·프로세스를 쓰지 않는다. 묶음(보내기 묶음 하나 = 스레드 하나)의 항목은
{"sheet": 시트 폴더 경로, "kind": answer|pass|fix|comment, "id": 결정·노드 id} 모양이다.
메시지는 신호일 뿐 답 내용을 싣지 않는다 — 내용은 받은 스레드가 spec-board apply로 읽는다.
"""
from __future__ import annotations

import os

KIND = {"answer": "결정", "pass": "통과", "fix": "고쳐줘", "comment": "댓글"}
ORDER = ("answer", "pass", "fix", "comment")
MAX_LEN = 500
MAX_SHEETS = 4


def _short(path: str) -> str:
    home = os.path.expanduser("~")
    p = str(path)
    return "~" + p[len(home):] if p == home or p.startswith(home + os.sep) else p


def dedupe(items: list[dict]) -> list[dict]:
    """같은 시트·같은 항목(id)을 여러 번 바꿨으면 마지막 것만 남긴다. 댓글은 글마다 따로 센다."""
    out: dict[tuple, dict] = {}
    n = 0
    for it in items:
        kind = it.get("kind")
        if kind not in KIND:
            continue
        n += 1
        key = (it.get("sheet"), it.get("id"), n) if kind == "comment" else (it.get("sheet"), it.get("id"))
        out.pop(key, None)   # 다시 넣어 순서도 마지막 위치로
        out[key] = it
    return list(out.values())


def summary(items: list[dict]) -> str:
    """'보드 입력 5건(결정 3 · 통과 1 · 고쳐줘 1)'"""
    its = dedupe(items)
    n = {k: sum(1 for x in its if x["kind"] == k) for k in ORDER}
    parts = " · ".join(f"{KIND[k]} {n[k]}" for k in ORDER if n[k])
    return f"보드 입력 {len(its)}건({parts})"


def wake_message(items: list[dict]) -> str:
    """스레드 하나에 보낼 한 줄. 시트가 많으면 앞의 MAX_SHEETS개만 적고 '외 N개'."""
    its = dedupe(items)
    if not its:
        return ""
    sheets: list[str] = []
    for x in its:
        s = _short(x.get("sheet", ""))
        if s and s not in sheets:
            sheets.append(s)
    shown = sheets[:MAX_SHEETS]
    more = f" 외 {len(sheets) - len(shown)}개" if len(sheets) > len(shown) else ""
    msg = (f"[spec-board] {summary(its)} — {', '.join(shown)}{more}. "
           f"시트마다 spec-board apply <시트>로 반영하고 이어서 진행하세요. pending이 0이면 바로 끝내도 됩니다. "
           f"사람이 정해야 할 선택이 생기면 채팅 대신 spec-board node block으로 보드 결정에 올리세요.")
    if len(msg) > MAX_LEN:   # 경로가 아주 길면 시트를 줄인다
        msg = (f"[spec-board] {summary(its)} — 시트 {len(sheets)}개({shown[0]} 등). "
               f"시트마다 spec-board apply <시트>로 반영하고 이어서 진행하세요.")[:MAX_LEN]
    return msg
