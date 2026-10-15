#!/usr/bin/env python3
"""웨이브 보고서 파서 — 표/비표 노드 줄, UTC 머리, 날짜만 있는 머리, 읽을 수 없는 보고서.

  python3 -m unittest discover -s tests -p 'test_waves.py'
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로
sys.path.insert(0, str(Path(__file__).resolve().parent))

import spec_model as sm
from test_spec_model import Repo, Tmp

TABLE = """# wave 20261013-1330 · 스레드 t1
## 노드
| ID | 상태 | 결론 한 줄 | 커밋 |
|---|---|---|---|
| n1 | 막힘 | 키 없음 | 없음 |
| n2 | 끝남 | 완료 | api abc |
## 기다리는 것
- n9 | 끝남 | 이 줄은 노드가 아니다
## 소요
n1 약 5분, n2 약 25분
"""
BARE = """# wave 2026-10-13 03:09:53 UTC · 스레드 t2
ID | 상태 | 결론 한 줄 | 커밋
n34 | 끝남 | 구현 | 기존
n42 | 막힘 | 원인 | 기존
## 소요
n34 약 1분
"""
DATE_ONLY = "# wave 2026-10-13 · 스레드 u\nn5 | 끝남 | z | y\n"


class WaveParse(unittest.TestCase):
    def test_table(self):
        w = sm.parse_wave(TABLE)
        self.assertEqual(w["at"], "2026-10-13 13:30")
        self.assertEqual(w["thread"], "t1")
        self.assertEqual(w["nodes"], [{"key": "n1", "state": "막힘"}, {"key": "n2", "state": "끝남"}])
        self.assertEqual(w["dur"], "n1 약 5분, n2 약 25분")

    def test_bare_pipes_and_utc(self):
        w = sm.parse_wave(BARE)
        self.assertEqual(w["at"], "2026-10-13 12:09")
        self.assertEqual([n["key"] for n in w["nodes"]], ["n34", "n42"])

    def test_date_only_borrows_filename_time(self):
        self.assertEqual(sm.parse_wave(DATE_ONLY, "20261013-1440")["at"], "2026-10-13 14:40")

    def test_no_head_is_none(self):
        self.assertIsNone(sm.parse_wave("# 웨이브: 설명 문서\n\n| # | 증상 |\n"))

    def test_read_waves_orders_skips_and_warns(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "wave-b.md").write_text(BARE, encoding="utf-8")
            (d / "wave-a.md").write_text(TABLE, encoding="utf-8")
            (d / "wave-note.md").write_text("# 메모\n", encoding="utf-8")
            (d / "wave-undated.md").write_text(DATE_ONLY, encoding="utf-8")
            waves, warns = sm.read_waves(d)
        self.assertEqual([(w["w"], w["file"]) for w in waves],
                         [(1, "wave-b.md"), (2, "wave-a.md"), (3, "wave-undated.md")])
        self.assertEqual(len(warns), 1)
        self.assertIn("wave-note.md", warns[0]["text"])


class BriefModalFields(Tmp):
    def test_why_and_criteria_come_from_the_brief(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        brief = next(r.dir.glob("n1-*.md"))
        text = brief.read_text(encoding="utf-8").replace("데모 문제.", "- 인덱스가 없다\n- 상한이 없다")
        text += "\n## 완료 기준\n\n- [x] 테스트가 통과한다\n- [ ] 메모를 남긴다\n- 점만 있는 줄은 항목이 아니다\n"
        brief.write_text(text, encoding="utf-8")
        t, nodes, _ = r.board()
        n = nodes["n1"]
        self.assertEqual(n["why"], ["인덱스가 없다", "상한이 없다"])
        self.assertEqual(n["criteria"], [{"text": "테스트가 통과한다", "done": True}, {"text": "메모를 남긴다", "done": False}])

    def test_problem_paragraph_is_one_item_and_missing_sections_are_empty(self):
        r = Repo(self.tmp)
        r.node("n1", "진행")
        brief = next(r.dir.glob("n1-*.md"))
        brief.write_text(brief.read_text(encoding="utf-8").replace("데모 문제.", "한 문단으로 쓴 문제다. 둘째 문장."), encoding="utf-8")
        _, nodes, _ = r.board()
        self.assertEqual(nodes["n1"]["why"], ["한 문단으로 쓴 문제다. 둘째 문장."])
        self.assertEqual(nodes["n1"]["criteria"], [])


if __name__ == "__main__":
    unittest.main()
