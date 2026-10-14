#!/usr/bin/env python3
"""결정 시트 동시성 검증 — 워크스페이스 2개 × 클라이언트 N개가 무작위로 저장해도 잃는 답이 0인지 본다.

  sheet_stress.py [--seconds 60] [--clients 4] [--no-base]

--no-base는 대조군이다. base를 안 보내면 잃는 답이 나와야 한다 — 안 나오면 이 검증이 눈먼 것이다.

임시 레포 2개를 만들고 sheet.py를 빈 포트에 띄운다.
행(rows/Dn.json) 외에 노드 사람 칸(rows/nodes/n1.json)과 ticket.json도 같이 친다 — 같은 잠금·같은 판정이다.
각 클라이언트는 자기가 마지막으로 본 값을 base로 보낸다. 200이면 (base → new)를 기록한다.
판정: 칸마다 200 받은 저장들이 "" 에서 시작해 한 줄로 이어지고, 그 끝이 파일의 최종 값이다.
두 저장이 같은 base를 딛고 둘 다 200이면 하나가 조용히 사라진 것이다 — 실패.
"""
from __future__ import annotations

import json
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROWS = ["D1", "D2", "D3"]
FIELDS = ["answer", "fix"]
# (엔드포인트, 대상 id, 칸). verdict는 열거형이라 임의 문자열 대조에 못 쓴다 — 노드는 fix, 티켓은 priority만 친다.
TARGETS = [("user", r, f) for r in ROWS for f in FIELDS] + [("node", "n1", "fix"), ("ticket", "ticket", "priority")]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_repo(root: Path) -> None:
    rows = root / "spec" / "s" / "rows"
    rows.mkdir(parents=True)
    (root / "spec" / "s" / "spec.md").write_text(
        "# s\n\n| 항목 | 값 |\n|---|---|\n| 문제 | p |\n| 상태 | 진행 |\n\n## 노드 인덱스\n\n"
        "| ID | 브리프 | deps | 상태 |\n|---|---|---|---|\n| n1 | [n1-a.md](n1-a.md) | — | 진행 |\n", encoding="utf-8")
    (root / "spec" / "s" / "n1-a.md").write_text("# n1-a — a\n\n**id**: S-1\n**상태**: 진행\n", encoding="utf-8")
    for rid in ROWS:
        (rows / f"{rid}.json").write_text(json.dumps({
            "id": rid, "kind": "decision", "title": rid, "given": "", "when": "", "then": "",
            "options": [], "recommend": "", "confidence": "low", "reversible": False, "status": "아직 안 함",
            "blocks": [], "user": {"answer": "", "fix": ""}, "log": []}, ensure_ascii=False))


def post(port: int, ws: str, body: dict, kind: str = "user") -> tuple[int, dict]:
    req = urllib.request.Request(f"http://127.0.0.1:{port}/w/{ws}/api/{kind}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    args = sys.argv[1:]
    secs = int(args[args.index("--seconds") + 1]) if "--seconds" in args else 60
    n_clients = int(args[args.index("--clients") + 1]) if "--clients" in args else 4
    send_base = "--no-base" not in args
    tmp = Path(tempfile.mkdtemp(prefix="sheet-stress-"))
    repos = {"wa": tmp / "wa", "wb": tmp / "wb"}
    for p in repos.values():
        make_repo(p)
    port = free_port()
    srv = subprocess.Popen([sys.executable, str(HERE / "sheet.py"), "--port", str(port), *map(str, repos.values())],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    srv.stdout.readline()  # 첫 줄이 나오면 떴다
    time.sleep(0.5)

    acked: list[tuple] = []  # (ws, row, field, base, new)
    counts = {"ok": 0, "conflict": 0, "error": 0}
    mu = threading.Lock()
    stop = time.time() + secs

    def client(cid: int) -> None:
        seen: dict[tuple, str] = {}
        n = 0
        rnd = random.Random(cid)
        while time.time() < stop:
            ws, (kind, rid, f) = rnd.choice(list(repos)), rnd.choice(TARGETS)
            k = (ws, rid, f)
            base = seen.get(k, "")
            new = f"c{cid}-{n}"
            n += 1
            body = {"sheet": "s", "user": {f: new}, **({"base": {f: base}} if send_base else {})}
            if kind != "ticket":
                body["id"] = rid
            code, j = post(port, ws, body, kind)
            with mu:
                if code == 200:
                    acked.append((ws, rid, f, base, new))
                    counts["ok"] += 1
                    seen[k] = new
                elif code == 409:
                    counts["conflict"] += 1
                    seen[k] = j["user"].get(f, "")
                else:
                    counts["error"] += 1

    ts = [threading.Thread(target=client, args=(i,)) for i in range(n_clients)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    srv.terminate()

    lost, broken = 0, []
    where = {"user": lambda r, i: r / "spec/s/rows" / f"{i}.json",
             "node": lambda r, i: r / "spec/s/rows/nodes" / f"{i}.json",
             "ticket": lambda r, i: r / "spec/s/ticket.json"}
    for ws, root in repos.items():
        for kind, rid, f in TARGETS:
            path = where[kind](root, rid)
            final = json.loads(path.read_text())["user"] if path.exists() else {}
            edges = [(b, nw) for w, r, ff, b, nw in acked if (w, r, ff) == (ws, rid, f)]
            nxt: dict[str, str] = {}
            for b, nw in edges:
                if b in nxt:  # 같은 값을 딛고 두 저장이 다 성공했다 → 하나가 사라졌다
                    lost += 1
                nxt[b] = nw
            cur, steps = "", 0
            while cur in nxt and steps <= len(edges):
                cur, steps = nxt[cur], steps + 1
            if steps != len(edges) or cur != final.get(f, ""):
                broken.append(f"{ws}/{rid}.{f}: 이어진 {steps}/{len(edges)}, 끝 {cur!r} ≠ 파일 {final.get(f)!r}")
    print(f"{secs}초 · 클라이언트 {n_clients} · 워크스페이스 {len(repos)}")
    print(f"저장 성공 {counts['ok']} · 충돌 409 {counts['conflict']} · 오류 {counts['error']}")
    print(f"잃은 답 {lost} · 끊긴 사슬 {len(broken)}")
    for b in broken[:10]:
        print("  " + b)
    ok = lost == 0 and not broken and counts["error"] == 0
    print("통과" if ok else "실패")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
