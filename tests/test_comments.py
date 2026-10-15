#!/usr/bin/env python3
"""노드 댓글 — 사람(화면)과 에이전트(node comment)가 rows/nodes/<노드>.json comments에 덧붙이고, apply가 답 없는 스레드를 낸다.

  python3 -m unittest discover -s tests -p 'test_comments.py'
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import node_state
import sheet

SPEC = """# s

| 칸 | 값 |
|---|---|
| 상태 | 진행 |

## 노드 인덱스

| ID | 브리프 | deps | 상태 |
|---|---|---|---|
| n7 | n7-demo.md | - | 확인 대기 |
"""
BRIEF = "# n7-demo — 데모\n\n**상태**: 확인 대기\n\n## 문제\n\n데모.\n"


class Comments(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name) / "spec" / "s"
        (self.t / "rows").mkdir(parents=True)
        (self.t / "spec.md").write_text(SPEC, encoding="utf-8")
        self.brief = self.t / "n7-demo.md"
        self.brief.write_text(BRIEF, encoding="utf-8")
        self.j = mock.patch.object(sheet, "JOURNAL", Path(self.tmp.name) / "journal")
        self.j.start()

    def tearDown(self):
        self.j.stop()
        self.tmp.cleanup()

    def agent(self, *args, text=""):
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(text)), redirect_stdout(out):
            node_state.main(["comment", str(self.brief), *args])
        return json.loads(out.getvalue())

    def test_line_comment_waits_until_agent_replies(self):
        cs = sheet.add_comment(self.t, "n7", {"text": "이 기준은 왜 4개죠?", "anchor": {"sec": "crit", "text": "실패 4개"}}, "user")
        self.assertEqual(cs[0]["id"], "c1")
        items = sheet.apply_sheet(self.t)
        self.assertEqual(items[0]["kind"], "node")
        self.assertEqual(items[0]["comments"][0]["anchor"], {"sec": "crit", "text": "실패 4개"})
        self.assertEqual(sheet.pending(self.t)["pending"], 1)
        got = self.agent("--reply", "c1", "--file", "-", text="기준 브랜치에서 이미 실패하던 4개입니다.")
        self.assertEqual(got["thread"], "c1")
        self.assertEqual(sheet.pending(self.t)["pending"], 0, "에이전트가 답하면 기다리지 않는다")
        sheet.add_comment(self.t, "n7", {"text": "그럼 커밋에 적어 주세요", "reply_to": "c1"}, "user")
        self.assertEqual(sheet.pending(self.t)["pending"], 1, "사람이 다시 쓰면 또 기다린다")
        sheet.add_comment(self.t, "n7", {"reply_to": "c1", "resolve": True}, "user")
        self.assertEqual(sheet.pending(self.t)["pending"], 0, "해결한 스레드는 기다리지 않는다")

    def test_comment_keeps_verdict_and_user_fields(self):
        sheet.save_node_user(self.t, "n7", {"verdict": "고쳐줘", "fix": "- 캡처"}, None)
        sheet.add_comment(self.t, "n7", {"text": "전체 의견"}, "user")
        r = json.loads(sheet.node_file(self.t, "n7").read_text(encoding="utf-8"))
        self.assertEqual(r["user"], {"verdict": "고쳐줘", "fix": "- 캡처"})
        self.assertEqual(len(r["comments"]), 1)

    def test_bad_comments_are_refused(self):
        with self.assertRaises(ValueError):
            sheet.add_comment(self.t, "n7", {"text": "  "}, "user")
        with self.assertRaises(ValueError):
            sheet.add_comment(self.t, "n7", {"text": "x", "anchor": {"sec": "nope", "text": "a"}}, "user")
        with self.assertRaises(KeyError):
            sheet.add_comment(self.t, "n7", {"text": "x", "reply_to": "c9"}, "user")
        with self.assertRaises(KeyError):
            sheet.add_comment(self.t, "n99", {"text": "x"}, "user")

    def test_board_model_carries_comments(self):
        sheet.add_comment(self.t, "n7", {"text": "질문"}, "user")
        import spec_model
        board = spec_model.build_board(Path(self.tmp.name))
        n = board["projects"][0]["tickets"][0]["nodes"][0]
        self.assertEqual([c["text"] for c in n["comments"]], ["질문"])

    PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32

    def test_agent_comment_copies_screenshot_into_evidence_but_not_into_evidence_list(self):
        shot = Path(self.tmp.name) / "shot.png"
        shot.write_bytes(self.PNG)
        r = self.agent("--image", str(shot), text="캡처 첨부")
        got = sheet.comments_of(sheet.node_file(self.t, "n7"), sheet.local_dir(self.t))
        names = got[-1]["images"]
        self.assertEqual(len(names), 1)
        self.assertTrue(names[0].startswith("cm-"))
        self.assertTrue((self.t / "evidence" / "n7" / names[0]).is_file())
        self.assertTrue(shot.exists())   # 원본은 그대로
        data, ctype = sheet.evidence_image(self.t, "n7", names[0])
        self.assertEqual(ctype, "image/png")
        import spec_model
        n = spec_model.build_board(Path(self.tmp.name))["projects"][0]["tickets"][0]["nodes"][0]
        self.assertEqual(n["evidence"], [])   # 근거 목록과 섞이지 않는다
        self.assertEqual(n["comments"][-1]["images"], names)
        self.assertEqual(r["node"], "n7")

    def test_image_only_comment_is_allowed_and_counts_as_entry(self):
        sheet.add_comment(self.t, "n7", {"images": ["cm-a.png"]}, "user")
        import spec_model
        th = spec_model.comment_threads(sheet.comments_of(sheet.node_file(self.t, "n7"), sheet.local_dir(self.t)))
        self.assertEqual(len(th[0]["entries"]), 1)
        self.assertTrue(th[0]["waiting"])

    def test_bad_image_names_are_refused(self):
        for bad in (["../x.png"], ["a.png"], ["cm-a.exe"], ["cm-" + "a" * 80 + ".png"], "cm-a.png", [1]):
            with self.assertRaises(ValueError):
                sheet.add_comment(self.t, "n7", {"text": "x", "images": bad}, "user")
        with self.assertRaises(ValueError):
            sheet.add_comment(self.t, "n7", {"text": "x", "images": [f"cm-{i}.png" for i in range(7)]}, "user")

    def test_agent_refuses_non_image_and_failed_comment_leaves_no_copy(self):
        txt = Path(self.tmp.name) / "a.txt"
        txt.write_text("x")
        with self.assertRaises(SystemExit):
            self.agent("--image", str(txt), text="x")
        shot = Path(self.tmp.name) / "s.png"
        shot.write_bytes(self.PNG)
        with self.assertRaises(KeyError):
            self.agent("--reply", "c9", "--image", str(shot), text="x")
        ev = self.t / "evidence" / "n7"
        self.assertEqual(list(ev.glob("cm-*")) if ev.exists() else [], [])

    def test_user_upload_saves_screenshot_by_signature_not_header(self):
        name = sheet.save_comment_image(self.t, "n7", self.PNG)
        self.assertTrue(name.startswith("cm-u") and name.endswith(".png"))
        self.assertTrue((self.t / "evidence" / "n7" / name).is_file())
        with self.assertRaises(ValueError):
            sheet.save_comment_image(self.t, "n7", b"<svg onload=alert(1)>")
        with self.assertRaises(ValueError):
            sheet.save_comment_image(self.t, "n7", b"")
        with self.assertRaises(KeyError):
            sheet.save_comment_image(self.t, "n99", self.PNG)


if __name__ == "__main__":
    unittest.main()
