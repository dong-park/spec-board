"""보내기 묶음 — 사람이 보드에서 남긴 입력을 담당 스레드마다 모았다가 메시지 하나로 깨운다 (spec/board-wake n3).

운영 기록(2026-10-12~15): 결정은 시트 시작 때 몰아서(4~16개) 답하고, 확인 대기 통과는 하나씩 10~60분 간격으로 왔다.
그래서 보내는 때는 둘이다(D1).
  ① 그 스레드가 맡은 시트들에 남은 사람 할 일(답 없는 열린 결정·안 누른 확인 대기)이 0이 되면 바로
  ② 덜 답한 채 멈추면 마지막 입력 뒤 조용한 시간(QUIET, D2 2분)이 지나서
사람은 붙잡기(hold)로 멈추거나 지금 보내기(flush)로 당길 수 있다.

넣기는 codex queue 한 번이다. 보드가 넣은 메시지가 아직 대기열에 남아 있으면 새로 넣지 않는다 —
그 메시지로 깨어나면 spec-board apply가 그사이 입력까지 전부 가져간다. 대기열 DB는 읽기만 한다.
시계·실행기·남은 할 일·대기열 확인은 바꿔 끼울 수 있다(테스트).
"""
from __future__ import annotations

import glob
import os
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

from wake import summary, wake_message

QUIET = 120.0
TICK = 1.0
KEEP_SENT = 6 * 3600   # 보낸 묶음을 "보냄 · 11:32"로 보여 줄 시간
APP_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
TAG = "[spec-board]"


def codex_cli() -> str | None:
    """codex 실행 파일 — SPEC_BOARD_CODEX → CODEX_CLI_PATH(앱이 셸에 준 것) → 앱 안의 CLI → PATH 순.
    보드 서비스(launchd)는 셸의 PATH를 모르므로 앱 안의 CLI가 보통 잡힌다."""
    for c in (os.environ.get("SPEC_BOARD_CODEX"), os.environ.get("CODEX_CLI_PATH"), APP_CLI, shutil.which("codex")):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def queue_send(thread: str, message: str) -> tuple[bool, str]:
    cli = codex_cli()
    if not cli:
        return False, "codex 실행 파일을 못 찾았어요"
    try:
        r = subprocess.run([cli, "queue", "--thread", thread, "--message", message],
                           capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"codex queue 실행 실패: {e.__class__.__name__}"
    out = [l for l in (r.stdout + "\n" + r.stderr).splitlines() if l.startswith("Queued message")]
    if r.returncode == 0 and out:
        return True, out[-1]
    tail = [l for l in r.stderr.splitlines() if l.strip() and " WARN " not in l][-1:]
    return False, (tail[0] if tail else f"codex queue 종료 코드 {r.returncode}")[:200]


def queue_has_ours(thread: str) -> bool:
    """보드가 그 스레드에 넣은 메시지가 아직 대기열에 남았나. 대기열 DB는 읽기 전용으로 연다(앱이 쓰는 파일)."""
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    dbs = sorted(glob.glob(str(home / "queue_*.sqlite")))
    if not dbs:
        return False
    try:
        con = sqlite3.connect(f"file:{dbs[-1]}?mode=ro", uri=True, timeout=2)
        try:
            rows = con.execute("select payload_json from queued_items where thread_id = ?", (thread,)).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return False
    return any(TAG in (p or "") for (p,) in rows)


class Outbox:
    """스레드 → 묶음. 담당 스레드가 없거나 깨우기를 끈 시트의 입력은 주인 없음(orphans)에 모으고 보내지 않는다.
    owner_of(sheet) → (thread | "", wake: bool), todo_of(thread) → 그 스레드가 맡은 시트들에 남은 사람 할 일 수."""

    def __init__(self, owner_of, todo_of, send=queue_send, queued=queue_has_ours, clock=time.time, notify=None, quiet=QUIET,
                 pending_of=None):
        self.owner_of, self.todo_of, self.send, self.queued, self.clock, self.notify, self.quiet = owner_of, todo_of, send, queued, clock, notify, quiet
        self.pending_of = pending_of   # 시트에 에이전트가 아직 반영 안 한 사람 입력이 있나 — 없으면 주인 없음 표시를 치운다
        self.mu = threading.Lock()
        self.bundles: dict[str, dict] = {}
        self.orphans: dict[str, dict] = {}
        self.thread = None

    def _changed(self):
        if self.notify:
            self.notify()

    def add(self, ws: str, sheet: Path, kind: str, item_id: str) -> str:
        """사람 입력 하나를 묶음에 넣는다. 돌려주는 값: 넣은 스레드 id, 또는 "" (주인 없음)."""
        thread, wake = self.owner_of(sheet)
        it = {"ws": ws, "sheet": str(sheet), "kind": kind, "id": str(item_id)}
        now = self.clock()
        with self.mu:
            if not thread or not wake:
                o = self.orphans.setdefault(f"{ws}|{sheet}", {"ws": ws, "sheet": str(sheet), "items": [], "reason": "off" if thread else "none"})
                o["items"].append(it)
                o["reason"] = "off" if thread else "none"
            else:
                b = self.bundles.get(thread)
                if not b or b.get("state") in ("sent", "merged", "error"):
                    b = self.bundles[thread] = {"thread": thread, "items": [], "first": now, "held": False, "state": "waiting"}
                b["items"].append(it)
                b["last"] = now
        self._changed()
        self._start()
        return thread if (thread and wake) else ""

    def hold(self, thread: str, held: bool) -> bool:
        with self.mu:
            b = self.bundles.get(thread)
            if not b or b.get("state") != "waiting":
                return False
            b["held"] = bool(held)
            if not held:
                b["last"] = self.clock()   # 풀면 조용한 시간을 처음부터
        self._changed()
        return True

    def flush(self, thread: str) -> dict:
        """지금 보내기. 보낼 것이 없으면 그대로 돌려준다."""
        with self.mu:
            b = self.bundles.get(thread)
            if not b or b.get("state") != "waiting" or not b["items"]:
                return dict(b or {})
            b["state"] = "sending"
            items = list(b["items"])
        if self.queued(thread):
            ok, info, state = True, "아직 안 꺼낸 깨우기가 대기열에 있어 합쳤어요", "merged"
        else:
            ok, info = self.send(thread, wake_message(items))
            state = "sent" if ok else "error"
        with self.mu:
            b["state"], b["info"], b["sent_at"] = state, info, self.clock()
            b["sent_items"] = len(items)
            if not ok:   # 실패하면 묶음을 그대로 두고 사람이 다시 보낼 수 있게
                b["state"] = "waiting"
                b["error"] = info
                b["held"] = True
        self._changed()
        return dict(b)

    def due(self) -> list[str]:
        now = self.clock()
        with self.mu:
            cands = [(t, b["last"]) for t, b in self.bundles.items() if b.get("state") == "waiting" and not b["held"] and b["items"]]
        out = []
        for t, last in cands:
            if now - last >= self.quiet or self.todo_of(t) == 0:
                out.append(t)
        return out

    def tick(self) -> list[str]:
        sent = self.due()
        for t in sent:
            self.flush(t)
        now = self.clock()
        with self.mu:   # 오래된 보냄 표시는 치운다
            for t in [t for t, b in self.bundles.items() if b.get("state") in ("sent", "merged") and now - b.get("sent_at", now) > KEEP_SENT]:
                del self.bundles[t]
            orphans = list(self.orphans.items())
        if self.pending_of:
            gone = [k for k, o in orphans if not self.pending_of(Path(o["sheet"]))]
            if gone:
                with self.mu:
                    for k in gone:
                        self.orphans.pop(k, None)
                self._changed()
        return sent

    def _start(self):
        with self.mu:
            if self.thread is not None:
                return
            self.thread = threading.Thread(target=self._run, daemon=True, name="spec-board-outbox")
        self.thread.start()

    def _run(self):
        while True:
            time.sleep(TICK)
            try:
                self.tick()
            except Exception:   # 한 번 실패해도 묶음 스레드는 산다
                pass

    def view(self) -> dict:
        """/api/outbox — 화면의 묶음 바가 읽는다."""
        now = self.clock()
        with self.mu:
            bundles = [dict(b, items=list(b["items"])) for b in self.bundles.values()]
            orphans = [dict(o, items=list(o["items"])) for o in self.orphans.values()]
        out = []
        for b in bundles:
            waiting = b.get("state") == "waiting"
            left = max(0.0, self.quiet - (now - b.get("last", now))) if waiting and not b["held"] else None
            sheets = []
            for it in b["items"]:
                s = {"ws": it["ws"], "sheet": it["sheet"]}
                if s not in sheets:
                    sheets.append(s)
            out.append({"thread": b["thread"], "state": b.get("state"), "held": b["held"], "count": len(b["items"]) if waiting else b.get("sent_items", 0),
                        "summary": summary(b["items"]) if b["items"] else "", "sheets": sheets, "left": None if left is None else round(left),
                        "sent_at": b.get("sent_at"), "info": b.get("info", ""), "error": b.get("error", "") if waiting else ""})
        return {"quiet": self.quiet, "bundles": out,
                "orphans": [{"ws": o["ws"], "sheet": o["sheet"], "count": len(o["items"]), "reason": o["reason"]} for o in orphans]}

    def drop_orphans(self, ws: str, sheet: str) -> None:
        with self.mu:
            self.orphans.pop(f"{ws}|{sheet}", None)
        self._changed()
