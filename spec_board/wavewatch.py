"""죽은 웨이브 감시 — heartbeat 대신 보드 서버가 본다 (spec/board-wake D6=B). LLM 토큰은 쓰지 않는다.

웨이브 스킬은 끝나면 `spec/<슬러그>/.wave` 잠금을 비우고 메인에 WAVE-DONE을 보낸다. 잠금에 스레드 id가 남아 있는데
그 스레드의 세션 기록(rollout)이 STALL초 넘게 안 바뀌면 죽었거나 멈춘 웨이브다 — 그 시트의 담당 스레드를 한 번 깨운다.
같은 웨이브 id는 한 번만 보낸다. 시계·세션 기록 시각·전송·대기열 확인은 바꿔 끼울 수 있다(테스트).
"""
from __future__ import annotations

import glob
import os
import threading
import time
from pathlib import Path

from outbox import TAG, queue_has_ours, queue_send

STALL = 20 * 60.0
EVERY = 60.0


def rollout_mtime(thread: str) -> float | None:
    """그 스레드 세션 기록의 마지막 수정 시각. 기록이 없으면 None."""
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    best = None
    for f in glob.glob(str(home / "sessions" / "*" / "*" / "*" / f"rollout-*-{thread}.jsonl")):
        try:
            m = os.stat(f).st_mtime
        except OSError:
            continue
        best = m if best is None or m > best else best
    return best


def lock_thread(sheet: Path) -> str:
    try:
        return (sheet / ".wave").read_text(encoding="utf-8").strip().split()[0]
    except (OSError, IndexError):
        return ""


def message(sheet: Path, wave: str, idle_min: int) -> str:
    return (f"{TAG} 웨이브 {wave[:8]}가 {idle_min}분째 조용합니다 — {sheet.name}. "
            f"wait_threads(timeoutMs 0)로 {wave}를 보고, 죽었으면 go 「스레드가 죽었으면」 절차로 이어받으세요. 돌고 있으면 아무것도 하지 않아도 됩니다.")


class WaveWatch:
    """sheets() → 시트 폴더들, owner_of(sheet) → (담당 스레드, 깨우기 켬)."""

    def __init__(self, sheets, owner_of, send=queue_send, queued=queue_has_ours, clock=time.time, mtime=rollout_mtime, stall=STALL):
        self.sheets, self.owner_of, self.send, self.queued, self.clock, self.mtime, self.stall = sheets, owner_of, send, queued, clock, mtime, stall
        self.told: set[tuple[str, str]] = set()   # (시트, 웨이브 id) — 한 웨이브에 한 번
        self.thread = None

    def tick(self) -> list[str]:
        sent = []
        for sheet in self.sheets():
            wave = lock_thread(sheet)
            if not wave or (str(sheet), wave) in self.told:
                continue
            m = self.mtime(wave)
            idle = None if m is None else self.clock() - m
            if idle is None or idle < self.stall:
                continue
            owner, wake = self.owner_of(sheet)
            if not owner or not wake:
                continue
            if not self.queued(owner):
                ok, _ = self.send(owner, message(sheet, wave, int(idle // 60)))
                if not ok:
                    continue   # 다음 틱에 다시
            self.told.add((str(sheet), wave))
            sent.append(wave)
        return sent

    def start(self) -> None:
        if self.thread is not None:
            return
        def run():
            while True:
                time.sleep(EVERY)
                try:
                    self.tick()
                except Exception:   # 한 번 실패해도 감시는 산다
                    pass
        self.thread = threading.Thread(target=run, daemon=True, name="spec-board-wavewatch")
        self.thread.start()
