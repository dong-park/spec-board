#!/usr/bin/env python3
"""사람 확인 반영 규칙 테스트 (D-R1) — apply가 노드·티켓 칸을 내고, patch ack가 비우고, node_state verdict가 브리프에 반영한다.

  python3 -m unittest discover -s tests -p 'test_verdict.py'
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import node_state
import sheet

SCRIPT = Path(node_state.__file__).resolve()
SHEET = Path(sheet.__file__).resolve()

BRIEF = """# n7-demo — 데모

**agent**: runner
**id**: IB-7
**상위**: spec/s.md
**deps**: 없음
**상태**: {state} <!-- 아직 안 함 | 진행 | 확인 대기 | 막힘 | 보류 | 끝남 -->
**담당 행**: T23

## 문제

데모.
{tail}"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ticket = Path(self.tmp.name) / "spec" / "s"
        (self.ticket / "rows").mkdir(parents=True)
        self.brief = self.ticket / "n7-demo.md"
        self.journal = mock.patch.object(sheet, "JOURNAL", Path(self.tmp.name) / "journal")
        self.journal.start()

    def tearDown(self):
        self.journal.stop()
        self.tmp.cleanup()

    def write_brief(self, state="확인 대기", tail=""):
        self.brief.write_text(BRIEF.format(state=state, tail=tail), encoding="utf-8")

    def node(self, verdict="", fix="", key="n7", log=None):
        f = sheet.node_file(self.ticket, key)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"id": key, "user": {"verdict": verdict, "fix": fix}, **({"log": log} if log else {})},
                                ensure_ascii=False), encoding="utf-8")
        return f

    def row(self, rid="D1", answer="", fix=""):
        (self.ticket / "rows" / f"{rid}.json").write_text(json.dumps({
            "id": rid, "kind": "decision", "title": rid, "options": [], "recommend": "A", "status": "아직 안 함",
            "user": {"answer": answer, "fix": fix}, "log": []}, ensure_ascii=False), encoding="utf-8")

    def ticket_json(self, **user):
        sheet.ticket_file(self.ticket).parent.mkdir(parents=True, exist_ok=True)
        sheet.ticket_file(self.ticket).write_text(json.dumps({"user": {"priority": "", "paused": False, **user}}), encoding="utf-8")

    def status(self):
        return node_state.read_status(self.brief.read_text(encoding="utf-8"))

    def cell(self, key="n7"):
        return json.loads(sheet.node_file(self.ticket, key).read_text())


class ApplyTest(Base):
    def test_apply_lists_rows_nodes_and_ticket_with_kind(self):
        self.row("D1", answer="A")
        self.node(verdict="고쳐줘", fix="여백 8px")
        self.ticket_json(paused=True, priority="P0")
        got = {(x["kind"], x["id"]): x for x in sheet.apply_sheet(self.ticket)}
        self.assertEqual(set(got), {("decision", "D1"), ("node", "n7"), ("ticket", "ticket")})
        self.assertEqual(got[("node", "n7")]["user"], {"verdict": "고쳐줘", "fix": "여백 8px"})
        self.assertEqual(got[("ticket", "ticket")]["user"], {"priority": "P0", "paused": True})
        self.assertTrue(got[("ticket", "ticket")]["standing"])

    def test_empty_cells_and_default_ticket_are_not_listed(self):
        self.row("D1")
        self.node()
        self.ticket_json()
        self.assertEqual(sheet.apply_sheet(self.ticket), [])

    def test_unpaused_ticket_with_priority_only_is_listed_and_paused_false_alone_is_not(self):
        self.ticket_json(priority="P1")
        self.assertEqual([x["id"] for x in sheet.apply_sheet(self.ticket)], ["ticket"])
        self.ticket_json(paused=False)
        self.assertEqual(sheet.apply_sheet(self.ticket), [])

    def test_apply_does_not_clear_anything(self):
        self.row("D1", answer="A")
        f = self.node(verdict="통과")
        sheet.apply_sheet(self.ticket)
        sheet.apply_sheet(self.ticket)
        self.assertEqual(self.cell()["user"]["verdict"], "통과")
        self.assertEqual(json.loads((self.ticket / "rows" / "D1.json").read_text())["user"]["answer"], "A")
        self.assertTrue(f.exists())

    def test_tmp_files_left_by_atomic_writes_are_ignored(self):
        self.row("D1", answer="A")
        (self.ticket / "rows" / ".tmp-abc.json").write_text("{not json")
        sheet.node_file(self.ticket, "n7").parent.mkdir(parents=True, exist_ok=True)
        (sheet.node_file(self.ticket, "n7").parent / ".tmp-xyz.json").write_text("{not json")
        self.assertEqual([x["id"] for x in sheet.apply_sheet(self.ticket)], ["D1"])


class AckTest(Base):
    def test_ack_on_node_is_refused_and_points_to_node_state_verdict(self):
        # 노드 칸은 브리프 반영과 한 묶음으로 비운다 — ack만 하면 반영 없이 사람이 남긴 통과·고쳐줘가 사라진다
        self.node(verdict="고쳐줘", fix="A")
        seen = sheet.apply_sheet(self.ticket)[0]["user"]
        with self.assertRaises(ValueError) as cm:
            sheet.patch_row(self.ticket, "n7", {"ack": seen})
        self.assertIn("node_state.py verdict", str(cm.exception))
        self.assertEqual(self.cell()["user"], {"verdict": "고쳐줘", "fix": "A"})   # 칸은 그대로
        self.assertEqual(len(sheet.apply_sheet(self.ticket)), 1)                   # 다음 apply에도 나온다

    def test_node_still_takes_log_plus_and_verdict_clears_the_cell(self):
        self.write_brief("확인 대기")
        self.node(verdict="통과")
        sheet.patch_row(self.ticket, "n7", {"log+": "메모"})
        self.assertEqual(self.cell()["log"], ["메모"])
        r = node_state.verdict(self.brief)
        self.assertTrue(r["applied"])
        self.assertEqual(self.cell()["user"], {"verdict": "", "fix": ""})
        self.assertEqual(sheet.apply_sheet(self.ticket), [])

    def test_ack_on_ticket_never_clears_the_standing_setting(self):
        self.ticket_json(paused=True, priority="P0")
        seen = sheet.apply_sheet(self.ticket)[0]["user"]
        r = sheet.patch_row(self.ticket, "ticket", {"ack": seen, "log+": "2026-10-11 paused 확인"})
        self.assertTrue(r["_standing"])
        u = json.loads(sheet.ticket_file(self.ticket).read_text())["user"]
        self.assertEqual(u, {"priority": "P0", "paused": True})
        self.assertEqual([x["id"] for x in sheet.apply_sheet(self.ticket)], ["ticket"])   # 다음 턴에도 그대로 나온다

    def test_row_patch_still_works_as_before(self):
        self.row("D1", answer="A")
        r = sheet.patch_row(self.ticket, "D1", {"status": "끝남", "confidence": "high", "log+": "x", "ack": {"answer": "A", "fix": ""}})
        self.assertEqual((r["status"], r["user"]["answer"]), ("끝남", ""))
        self.assertEqual(r["log"][0], "x")

    def test_cli_patch_reads_json_from_stdin_so_human_text_never_touches_a_command_line(self):
        hostile = "A'; touch /tmp/pwned; echo '$(id)`id`\n둘째 줄"
        self.row("D1", answer=hostile)
        item = next(x for x in sheet.apply_sheet(self.ticket) if x["id"] == "D1")
        payload = json.dumps({"status": "끝남", "log+": "반영", "ack": item["user"]}, ensure_ascii=False)
        out = subprocess.run([sys.executable, str(SHEET), "patch", str(self.ticket), "D1", "-"],
                             input=payload, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout)["status"], "끝남")
        r = json.loads((self.ticket / "rows" / "D1.json").read_text(encoding="utf-8"))
        self.assertEqual(r["user"]["answer"], "")                       # ack가 같은 값을 비웠다
        self.assertIn(hostile, "\n".join(r["log"]))                      # 글은 그대로 기록에 남는다

    def test_node_and_ticket_accept_only_ack_and_log(self):
        self.node(verdict="통과")
        with self.assertRaises(ValueError):
            sheet.patch_row(self.ticket, "n7", {"status": "끝남"})
        with self.assertRaises(ValueError):
            sheet.patch_row(self.ticket, "n7", {"user": {"verdict": "통과"}})
        self.assertEqual(self.cell()["user"]["verdict"], "통과")

    def test_unknown_ids(self):
        with self.assertRaises(KeyError):
            sheet.patch_row(self.ticket, "n99", {"ack": {}})
        with self.assertRaises(KeyError):
            sheet.patch_row(self.ticket, "ticket", {"ack": {}})   # ticket.json이 없다
        with self.assertRaises(ValueError):
            sheet.patch_row(self.ticket, "../x", {"ack": {}})

    def test_row_wins_over_node_with_same_name(self):
        self.row("n7", answer="A")
        self.node(verdict="통과")
        kind, f = sheet.locate(self.ticket, "n7")
        self.assertEqual((kind, f.parent.name), ("row", "rows"))


class VerdictTest(Base):
    def test_pass_marks_done_and_empties_the_cell_once(self):
        self.write_brief("확인 대기")
        self.node(verdict="통과")
        r = node_state.verdict(self.brief, today="2026-10-11")
        self.assertEqual((r["applied"], r["status"]), (True, "끝남"))
        self.assertEqual(self.status(), "끝남")
        self.assertEqual(self.cell()["user"], {"verdict": "", "fix": ""})
        self.assertIn("2026-10-11 user.verdict 반영: 통과", self.cell()["log"])
        # 두 번째는 아무것도 안 한다
        before = (self.brief.read_text(), sheet.node_file(self.ticket, "n7").read_text())
        r2 = node_state.verdict(self.brief, today="2026-10-12")
        self.assertFalse(r2["applied"])
        self.assertEqual(before, (self.brief.read_text(), sheet.node_file(self.ticket, "n7").read_text()))

    def test_status_line_comment_is_kept(self):
        self.write_brief("확인 대기")
        self.node(verdict="통과")
        node_state.verdict(self.brief)
        self.assertIn("**상태**: 끝남 <!-- 아직 안 함 |", self.brief.read_text())

    def test_fix_goes_back_to_progress_and_memo_gets_one_line(self):
        self.write_brief("확인 대기", tail="\n## 구현 메모\n\n- 처음 구현함\n\n## 완료 기준\n\n- 통과\n")
        self.node(verdict="고쳐줘", fix="여백을\n8px로")
        r = node_state.verdict(self.brief, today="2026-10-11")
        self.assertEqual((r["applied"], r["status"], r["memo"]), (True, "진행", True))
        text = self.brief.read_text()
        self.assertEqual(self.status(), "진행")
        memo_at, next_at = text.index("## 구현 메모"), text.index("## 완료 기준")
        line = "- 고쳐줘 (2026-10-11): 여백을 8px로"
        self.assertIn(line, text[memo_at:next_at])   # 구현 메모 절 안, 다음 절 앞
        self.assertEqual(text.count(line), 1)
        self.assertEqual(self.cell()["user"], {"verdict": "", "fix": ""})

    def test_fix_creates_the_memo_section_when_missing(self):
        self.write_brief("확인 대기")
        self.node(verdict="고쳐줘", fix="색 바꿔")
        node_state.verdict(self.brief, today="2026-10-11")
        text = self.brief.read_text()
        self.assertTrue(text.rstrip().endswith("## 구현 메모\n\n- 고쳐줘 (2026-10-11): 색 바꿔"))

    def test_crash_between_brief_and_cell_is_repaired_without_duplicate_memo(self):
        # 브리프엔 반영됐는데 칸은 안 비워진 채 죽은 상태
        self.write_brief("진행", tail="\n## 구현 메모\n\n- 고쳐줘 (2026-10-11): 색 바꿔\n")
        self.node(verdict="고쳐줘", fix="색 바꿔")
        r = node_state.verdict(self.brief, today="2026-10-11")
        self.assertEqual((r["applied"], r["memo"]), (True, False))
        self.assertEqual(self.brief.read_text().count("색 바꿔"), 1)
        self.assertEqual(self.cell()["user"], {"verdict": "", "fix": ""})

    def test_fix_on_a_running_node_is_skipped_and_the_cell_stays(self):
        # 진행 중이거나 막힘·보류·아직 안 함이면 받지 않는다 — runner가 도는 노드에 fix가 겹쳐 들어오지 않게
        for state in ("진행", "막힘", "아직 안 함", "보류"):
            self.write_brief(state)
            self.node(verdict="고쳐줘", fix="여백을 8px로")
            r = node_state.verdict(self.brief, today="2026-10-11")
            self.assertFalse(r["applied"], state)
            self.assertIn("그대로 둔다", r["reason"])
            self.assertEqual(self.status(), state)
            self.assertNotIn("고쳐줘 (", self.brief.read_text(), state)
            self.assertEqual(self.cell()["user"], {"verdict": "고쳐줘", "fix": "여백을 8px로"}, state)

    def test_fix_is_accepted_from_review_and_done(self):
        for state in ("확인 대기", "끝남"):
            self.write_brief(state)
            self.node(verdict="고쳐줘", fix="색 바꿔")
            r = node_state.verdict(self.brief, today="2026-10-11")
            self.assertEqual((r["applied"], r["status"]), (True, "진행"), state)

    def test_same_fix_on_another_day_is_not_stacked_again(self):
        self.write_brief("확인 대기")
        self.node(verdict="고쳐줘", fix="색 바꿔")
        node_state.verdict(self.brief, today="2026-10-11")
        node_state.set_status(self.brief, "확인 대기")           # runner가 다시 확인 대기로 올렸고
        self.node(verdict="고쳐줘", fix="색  바꿔")               # 다음 날 사람이 공백만 다르게 같은 말을 남겼다
        r = node_state.verdict(self.brief, today="2026-10-12")
        self.assertEqual((r["applied"], r["status"], r["memo"]), (True, "진행", False))
        text = self.brief.read_text()
        self.assertEqual(text.count("색 바꿔"), 1)
        self.assertNotIn("2026-10-12", text)
        self.assertEqual(self.cell()["user"], {"verdict": "", "fix": ""})

    def test_a_different_fix_is_stacked(self):
        self.write_brief("확인 대기")
        self.node(verdict="고쳐줘", fix="색 바꿔")
        node_state.verdict(self.brief, today="2026-10-11")
        node_state.set_status(self.brief, "확인 대기")
        self.node(verdict="고쳐줘", fix="여백도")
        r = node_state.verdict(self.brief, today="2026-10-12")
        self.assertTrue(r["memo"])
        self.assertIn("- 고쳐줘 (2026-10-12): 여백도", self.brief.read_text())

    def test_running_node_with_a_different_fix_is_not_repaired(self):
        # 크래시 복구는 같은 fix가 이미 메모에 있을 때뿐이다 — 다른 말은 진행 중이면 받지 않는다
        self.write_brief("진행", tail="\n## 구현 메모\n\n- 고쳐줘 (2026-10-11): 색 바꿔\n")
        self.node(verdict="고쳐줘", fix="다른 요청")
        r = node_state.verdict(self.brief, today="2026-10-12")
        self.assertFalse(r["applied"])
        self.assertEqual(self.cell()["user"]["fix"], "다른 요청")

    def test_pass_when_already_done_just_empties(self):
        self.write_brief("끝남")
        self.node(verdict="통과")
        r = node_state.verdict(self.brief)
        self.assertEqual((r["applied"], r["status"]), (True, "끝남"))
        self.assertEqual(self.cell()["user"]["verdict"], "")

    def test_pass_on_a_running_node_is_skipped_and_the_cell_stays(self):
        for state in ("진행", "막힘", "아직 안 함", "보류"):
            self.write_brief(state)
            self.node(verdict="통과")
            r = node_state.verdict(self.brief)
            self.assertFalse(r["applied"], state)
            self.assertIn("그대로 둔다", r["reason"])
            self.assertEqual(self.status(), state)
            self.assertEqual(self.cell()["user"]["verdict"], "통과", state)

    def test_fix_text_without_verdict_is_left_alone(self):
        self.write_brief("확인 대기")
        self.node(fix="그냥 메모")
        r = node_state.verdict(self.brief)
        self.assertFalse(r["applied"])
        self.assertEqual(self.status(), "확인 대기")
        self.assertEqual(self.cell()["user"]["fix"], "그냥 메모")

    def test_missing_cell_file_and_missing_status_line(self):
        self.write_brief("확인 대기")
        self.assertFalse(node_state.verdict(self.brief)["applied"])
        self.brief.write_text("# n7\n\n본문\n", encoding="utf-8")
        self.node(verdict="통과")
        r = node_state.verdict(self.brief)
        self.assertFalse(r["applied"])
        self.assertEqual(self.cell()["user"]["verdict"], "통과")

    def test_old_english_status_is_understood(self):
        self.write_brief("review")
        self.node(verdict="통과")
        self.assertEqual(node_state.verdict(self.brief)["status"], "끝남")

    def test_only_the_status_line_and_memo_change(self):
        self.write_brief("확인 대기")
        before = self.brief.read_text().split("\n")
        self.node(verdict="통과")
        node_state.verdict(self.brief)
        after = self.brief.read_text().split("\n")
        self.assertEqual(len(before), len(after))
        diff = [(b, a) for b, a in zip(before, after) if b != a]
        self.assertEqual(len(diff), 1)
        self.assertTrue(diff[0][0].startswith("**상태**:"))

    def test_cli_prints_json_and_second_run_is_noop(self):
        self.write_brief("확인 대기")
        self.node(verdict="통과")
        out = subprocess.run([sys.executable, str(SCRIPT), "verdict", str(self.brief)], capture_output=True, text=True, check=True)
        j = json.loads(out.stdout)
        self.assertEqual((j["node"], j["applied"], j["status"]), ("n7", True, "끝남"))
        again = json.loads(subprocess.run([sys.executable, str(SCRIPT), "verdict", str(self.brief)],
                                          capture_output=True, text=True, check=True).stdout)
        self.assertFalse(again["applied"])

    def test_concurrent_human_save_is_not_lost(self):
        """verdict가 도는 동안 사람이 같은 칸에 쓰면 행 잠금이 직렬화한다 — 잃거나 섞이지 않는다."""
        import threading
        self.write_brief("확인 대기")
        self.node(verdict="통과")
        errs = []

        def human():
            try:
                for i in range(20):
                    sheet.save_node_user(self.ticket, "n7", {"fix": f"h{i}"}, None)
            except Exception as e:  # pragma: no cover
                errs.append(e)
        t = threading.Thread(target=human)
        t.start()
        r = node_state.verdict(self.brief)
        t.join()
        self.assertEqual(errs, [])
        self.assertTrue(r["applied"])
        json.loads(sheet.node_file(self.ticket, "n7").read_text())   # 깨지지 않았다


if __name__ == "__main__":
    unittest.main()
