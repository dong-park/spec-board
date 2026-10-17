"""메인 스레드 문맥 관리 — 담당 스레드의 문맥이 커졌고 웨이브가 없을 때 보드에서 릴레이를 요청한다 (spec/board-wake D7).

모델은 호출마다 대화 전체를 다시 읽는다. 하트비트·깨우기·모든 턴이 담당 스레드의 문맥 크기만큼 입력을 쓴다.
넘기는 일은 그 스레드가 자기 문맥으로 relay.md를 써야 해서 보드가 대신 못 한다 — 보드는 크기를 보여 주고, 웨이브가 없을 때
"릴레이해 줘" 메시지를 담당 스레드에 보낸다. 웨이브가 도는 중에 넘기면 WAVE-DONE이 옛 스레드로 가서 놓치므로 버튼을 막는다.
"""
from __future__ import annotations

import glob
import json
import os
from pathlib import Path

from outbox import TAG

RELAY_AT = 150_000   # 이 문맥(토큰)부터 릴레이를 권한다(하트비트가 캐시를 식히면 문맥 전체가 정가라 15만부터)
TAIL = 262_144


def rollout_file(thread: str) -> str | None:
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    found = glob.glob(str(home / "sessions" / "*" / "*" / "*" / f"rollout-*-{thread}.jsonl"))
    return max(found, key=os.path.getmtime) if found else None


def context_tokens(thread: str) -> int | None:
    """그 스레드의 마지막 호출 입력 토큰 = 지금 문맥 크기. 세션 기록 끝에서 마지막 token_count를 읽는다."""
    f = rollout_file(thread)
    if not f:
        return None
    try:
        with open(f, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - TAIL))
            lines = fh.read().decode("utf-8", "ignore").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if '"token_count"' not in line:
            continue
        try:
            p = json.loads(line).get("payload", {})
            u = (p.get("info") or {}).get("last_token_usage") or {}
            if u.get("input_tokens"):
                return int(u["input_tokens"])
        except (ValueError, AttributeError):
            continue
    return None


def wave_running(sheet: Path) -> bool:
    try:
        return bool((sheet / ".wave").read_text(encoding="utf-8").strip())
    except OSError:
        return False


def relay_message(thread: str, slug: str, tokens: int | None, auto: bool = False) -> str:
    who = "사용자가 승인한 보드의 자동 릴레이입니다. 문맥이 커졌고 웨이브가 없어 보드가 판단해 요청합니다" if auto else "사용자가 보드에서 릴레이를 요청했습니다"
    size = f"약 {round(tokens / 10000)}만 토큰" if tokens else "큼"
    return (f"{TAG} {who} — 이 스레드의 문맥이 {size}입니다. 지금 돌고 있는 웨이브는 없습니다. "
            f"~/agent-env/skills/relay/SKILL.md 절차대로 spec/{slug}/relay.md에 진행 노트를 쓰고 create_thread로 새 스레드를 여세요. "
            f"노트의 「남은 것」에 새 스레드의 첫 턴 할 일을 넣으세요: ① ~/.codex/automations/*/automation.toml 중 target_thread_id가 {thread}인 자동화의 "
            f"대상을 새 스레드 id로 바꾸되 rrule과 프롬프트의 [알림] 문단은 그대로 둔다, ② spec-board apply spec/{slug}를 한 번 불러 담당을 자기로 바꾼다"
            f"(pending·wait만으로는 안 바뀐다), ③ 다음 웨이브 첫 메시지에 새 메인 id와 알림 승인 줄을 넣는다. 아직 답 없는 사람 결정도 적고, 새 스레드를 연 직후 move_thread_to_sidebar_section으로 새 스레드를 이 스레드와 같은 사이드바 섹션(고정이면 pinned)에 옮기세요(beforeThreadId는 이 스레드). 이 스레드는 끝내되 보관하지 마세요.")


class RelayWatch:
    """보드가 스스로 판단해 릴레이를 요청한다(D7=B). 조건이 모두 맞을 때만 담당 스레드에 한 번 보낸다:
    문맥이 RELAY_AT 이상 · 그 스레드가 맡은 시트에 도는 웨이브가 없음 · 세션 기록이 QUIET초 넘게 조용함(턴 중이 아님) ·
    깨우기가 켜져 있음 · 보드가 보낸 메시지가 대기열에 없음 · 같은 스레드에 AGAIN초 안에 보낸 적이 없음.
    owners() → /api/outbox의 owners 모양, wake_on(owner) → 그 스레드의 시트가 모두 깨우기 켬인가."""

    QUIET = 90.0
    AGAIN = 3600.0

    def __init__(self, owners, wake_on, send=None, queued=None, clock=None, mtime=None, quiet=None, again=None):
        import time as _t
        from outbox import queue_has_ours, queue_send
        from wavewatch import rollout_mtime
        self.owners, self.wake_on = owners, wake_on
        self.send, self.queued = send or queue_send, queued or queue_has_ours
        self.clock, self.mtime = clock or _t.time, mtime or rollout_mtime
        self.quiet = self.QUIET if quiet is None else quiet
        self.again = self.AGAIN if again is None else again
        self.told: dict[str, float] = {}
        self.thread = None

    def tick(self) -> list[str]:
        sent = []
        now = self.clock()
        for o in self.owners():
            t = o["thread"]
            if not o.get("relay") or not o.get("sheets"):
                continue
            if now - self.told.get(t, -1e18) < self.again:
                continue
            m = self.mtime(t)
            if m is None or now - m < self.quiet:
                continue   # 턴 중이거나 기록이 없다
            if not self.wake_on(o) or self.queued(t):
                continue
            ok, _ = self.send(t, relay_message(t, o["sheets"][0]["slug"], o.get("tokens"), auto=True))
            if ok:
                self.told[t] = now
                sent.append(t)
        return sent

    def start(self, every: float = 60.0) -> None:
        import threading, time as _t
        if self.thread is not None:
            return
        def run():
            while True:
                _t.sleep(every)
                try:
                    self.tick()
                except Exception:   # 한 번 실패해도 감시는 산다
                    pass
        self.thread = threading.Thread(target=run, daemon=True, name="spec-board-relaywatch")
        self.thread.start()
