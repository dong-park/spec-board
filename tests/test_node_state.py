#!/usr/bin/env python3
"""node_state.py 테스트 — 브리프 상태 쓰기·결정 행·확인 대기·동시 쓰기.

  python3 -m unittest discover -s tests -p 'test_node_state.py'
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import node_state

SCRIPT = Path(node_state.__file__).resolve()
SIX = node_state.SIX

BRIEF = """# n7-demo — 데모

**agent**: runner
**id**: IB-7
**상위**: spec/s.md
**deps**: 없음
**상태**: 아직 안 함 <!-- 아직 안 함 | 진행 | 확인 대기 | 막힘 | 보류 | 끝남 -->
**담당 행**: T23
**사람 확인**: 필요

## 문제

데모.
"""


class NodeStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ticket = Path(self.tmp.name) / "spec" / "s"
        (self.ticket / "rows").mkdir(parents=True)
        self.brief = self.ticket / "n7-demo.md"
        self.brief.write_text(BRIEF, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def status(self):
        return node_state.read_status(self.brief.read_text(encoding="utf-8"))

    def test_set_writes_only_status_line(self):
        before = self.brief.read_text(encoding="utf-8").split("\n")
        node_state.set_status(self.brief, "진행")
        after = self.brief.read_text(encoding="utf-8").split("\n")
        self.assertEqual(self.status(), "진행")
        self.assertEqual(len(before), len(after))
        for b, a in zip(before, after):
            if b.startswith("**상태**:"):
                self.assertEqual(a, "**상태**: 진행 <!-- 아직 안 함 | 진행 | 확인 대기 | 막힘 | 보류 | 끝남 -->")
            else:
                self.assertEqual(b, a)

    def test_set_rejects_outside_six(self):
        for bad in ("완료", "pending", "done", "재확인 필요", ""):
            with self.assertRaises(SystemExit):
                node_state.set_status(self.brief, bad)
        self.assertEqual(self.status(), "아직 안 함")

    def test_block_creates_decision_row_and_marks_blocked(self):
        row = node_state.block(self.brief, "무엇을 쓸까",
                               ["A:첫째", "B:둘째"], "A")
        f = self.ticket / "rows" / f"{row['id']}.json"
        self.assertTrue(f.exists())
        saved = json.loads(f.read_text(encoding="utf-8"))
        self.assertEqual(saved["kind"], "decision")
        self.assertEqual(saved["title"], "무엇을 쓸까")
        self.assertEqual([o["key"] for o in saved["options"]], ["A", "B"])
        self.assertEqual(saved["recommend"], "A")
        self.assertEqual(saved["blocks"], ["n7"])
        self.assertNotEqual(saved["status"], "끝남")
        self.assertEqual(saved["user"], {"answer": "", "fix": ""})
        self.assertEqual(self.status(), "막힘")

    def test_block_takes_next_decision_number(self):
        (self.ticket / "rows" / "D1.json").write_text("{}", encoding="utf-8")
        row = node_state.block(self.brief, "t", ["A:x", "B:y"], "B")
        self.assertEqual(row["id"], "D2")
        self.assertEqual(node_state.block(self.brief, "t2", ["A:x", "B:y"], "A")["id"], "D3")

    def test_review_moves_evidence_and_marks_review(self):
        src = Path(self.tmp.name) / "log.txt"
        src.write_text("통과 출력", encoding="utf-8")
        out = node_state.review(self.brief, [str(src)])
        dest = self.ticket / "evidence" / "n7" / "log.txt"
        self.assertFalse(src.exists())
        self.assertTrue(dest.exists())
        self.assertEqual(dest.read_text(encoding="utf-8"), "통과 출력")
        self.assertEqual(out["status"], "확인 대기")
        self.assertEqual(self.status(), "확인 대기")

    def test_review_without_evidence_still_waits(self):
        node_state.review(self.brief, [])
        self.assertEqual(self.status(), "확인 대기")

    # ── review: 전부 갖춰졌을 때만 움직이고, 실패하면 아무것도 안 바뀐다
    def evidence(self, *names):
        out = []
        for n in names:
            p = Path(self.tmp.name) / n
            p.write_text(f"{n} 본문", encoding="utf-8")
            out.append(str(p))
        return out

    def test_review_with_one_missing_evidence_moves_nothing_and_keeps_status(self):
        ok = self.evidence("a.png")[0]
        with self.assertRaises(SystemExit):
            node_state.review(self.brief, [ok, str(Path(self.tmp.name) / "nope.png")])
        self.assertTrue(Path(ok).exists())                                  # 앞의 근거도 안 움직였다
        self.assertFalse((self.ticket / "evidence").exists())
        self.assertEqual(self.status(), "아직 안 함")

    def test_review_without_status_line_moves_nothing(self):
        self.brief.write_text("# n7\n\n상태 줄 없음\n", encoding="utf-8")
        ev = self.evidence("a.png")
        with self.assertRaises(SystemExit):
            node_state.review(self.brief, ev)
        self.assertTrue(Path(ev[0]).exists())
        self.assertFalse((self.ticket / "evidence").exists())

    def test_review_refuses_duplicate_basenames(self):
        a = Path(self.tmp.name) / "x" / "shot.png"
        b = Path(self.tmp.name) / "y" / "shot.png"
        for p in (a, b):
            p.parent.mkdir()
            p.write_text(p.parent.name)
        with self.assertRaises(SystemExit):
            node_state.review(self.brief, [str(a), str(b)])
        self.assertTrue(a.exists() and b.exists())

    def test_review_failure_after_moving_rolls_everything_back(self):
        a, b = self.evidence("a.png", "b.png")
        (self.ticket / "evidence" / "n7").mkdir(parents=True)
        (self.ticket / "evidence" / "n7" / "a.png").write_text("이전 a")
        real = node_state.set_status
        with mock.patch.object(node_state, "set_status", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                node_state.review(self.brief, [a, b])
        self.assertEqual(Path(a).read_text(encoding="utf-8"), "a.png 본문")      # 원래 자리로 돌아왔다
        self.assertTrue(Path(b).exists())
        ev = self.ticket / "evidence" / "n7"
        self.assertEqual((ev / "a.png").read_text(), "이전 a")                  # 밀려난 이전 근거도 복원
        self.assertEqual([f.name for f in ev.iterdir()], ["a.png"])
        self.assertEqual(self.status(), "아직 안 함")
        self.assertIs(node_state.set_status, real)

    def test_review_again_replaces_same_name_and_leaves_no_backup(self):
        first = self.evidence("a.png")[0]
        node_state.review(self.brief, [first])
        Path(first).write_text("두 번째", encoding="utf-8")
        node_state.review(self.brief, [first])
        ev = self.ticket / "evidence" / "n7"
        self.assertEqual([f.name for f in ev.iterdir()], ["a.png"])
        self.assertEqual((ev / "a.png").read_text(encoding="utf-8"), "두 번째")

    def test_review_with_evidence_already_in_place_moves_nothing_and_loses_nothing(self):
        # 같은 파일을 evidence/<노드>/ 안 경로로 다시 넘기면 백업이 원본을 밀어내 잃던 자리
        first = self.evidence("a.png")[0]
        node_state.review(self.brief, [first])
        placed = self.ticket / "evidence" / "n7" / "a.png"
        node_state.set_status(self.brief, "진행")
        out = node_state.review(self.brief, [str(placed)])
        self.assertEqual(placed.read_text(encoding="utf-8"), "a.png 본문")
        self.assertEqual(out["evidence"], [str(placed)])
        self.assertEqual([f.name for f in placed.parent.iterdir()], ["a.png"])   # .prev-가 안 남는다
        self.assertEqual(self.status(), "확인 대기")

    def test_review_move_failure_right_after_backup_restores_the_previous_evidence(self):
        a = self.evidence("a.png")[0]
        ev = self.ticket / "evidence" / "n7"
        ev.mkdir(parents=True)
        (ev / "a.png").write_text("이전 a")
        with mock.patch.object(node_state.shutil, "move", side_effect=OSError("moved away")):
            with self.assertRaises(OSError):
                node_state.review(self.brief, [a])
        self.assertEqual((ev / "a.png").read_text(), "이전 a")        # 백업이 제자리로
        self.assertEqual([f.name for f in ev.iterdir()], ["a.png"])
        self.assertEqual(Path(a).read_text(encoding="utf-8"), "a.png 본문")
        self.assertEqual(self.status(), "아직 안 함")

    # ── block: 상태 줄 먼저, 같은 막힘은 재사용
    def test_block_without_status_line_creates_no_row(self):
        self.brief.write_text("# n7\n\n상태 줄 없음\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            node_state.block(self.brief, "t", ["A:x", "B:y"], "A")
        self.assertEqual(list((self.ticket / "rows").glob("D*.json")), [])

    def test_block_twice_with_same_title_reuses_the_open_decision(self):
        first = node_state.block(self.brief, "무엇을 쓸까", ["A:x", "B:y"], "A")
        again = node_state.block(self.brief, "무엇을 쓸까", ["A:x", "B:y"], "A")
        self.assertEqual((first["id"], again["id"]), ("D1", "D1"))
        self.assertTrue(again["reused"])
        self.assertFalse(first["reused"])
        self.assertEqual(len(list((self.ticket / "rows").glob("D*.json"))), 1)
        self.assertEqual(self.status(), "막힘")

    def test_block_with_other_title_or_closed_decision_makes_a_new_row(self):
        a = node_state.block(self.brief, "A 문제", ["A:x", "B:y"], "A")
        b = node_state.block(self.brief, "B 문제", ["A:x", "B:y"], "A")
        self.assertEqual((a["id"], b["id"]), ("D1", "D2"))
        f = self.ticket / "rows" / "D1.json"
        d = json.loads(f.read_text(encoding="utf-8"))
        d["status"] = "끝남"
        f.write_text(json.dumps(d), encoding="utf-8")
        c = node_state.block(self.brief, "A 문제", ["A:x", "B:y"], "A")   # 닫힌 결정은 재사용하지 않는다
        self.assertEqual(c["id"], "D3")

    def test_block_does_not_reuse_a_decision_that_blocks_another_node(self):
        other = self.ticket / "n8-other.md"
        other.write_text(BRIEF.replace("n7", "n8"), encoding="utf-8")
        node_state.block(other, "같은 제목", ["A:x", "B:y"], "A")
        mine = node_state.block(self.brief, "같은 제목", ["A:x", "B:y"], "A")
        self.assertEqual(mine["id"], "D2")
        self.assertEqual(mine["blocks"], ["n7"])

    def test_two_processes_set_concurrently_never_corrupt_line(self):
        procs = []
        for i in range(8):
            procs.append(subprocess.Popen(
                [sys.executable, str(SCRIPT), "set", str(self.brief), SIX[i % len(SIX)]],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE))
        for p in procs:
            _, err = p.communicate()
            self.assertEqual(p.returncode, 0, err.decode())
        text = self.brief.read_text(encoding="utf-8")
        lines = [ln for ln in text.split("\n") if ln.startswith("**상태**:")]
        self.assertEqual(len(lines), 1, text)
        self.assertIn(node_state.read_status(text), SIX)
        self.assertIn("<!-- 아직 안 함 | 진행", text)


if __name__ == "__main__":
    unittest.main()
