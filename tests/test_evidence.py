#!/usr/bin/env python3
"""확인할 것·근거 이미지 테스트 — 브리프의 '## 확인할 것'이 node.checks로 나오고, 근거 이미지는 evidence/<노드>/ 안의 이미지만 GET으로 나간다.

  python3 -m unittest discover -s tests -p 'test_evidence.py'
"""
import http.client
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import node_state
import sheet
import spec_model as sm
from test_spec_model import Repo, Tmp
from test_verdict import Base

PNG = b"\x89PNG\r\n\x1a\nfake"
SECTION = """
## 확인할 것

근거 이미지: `evidence/n1/a.png`. 아래를 봐 주세요.
둘째 줄도 안내다.

- [ ] 첫째 항목 `10-13T05:45`
- [x] 둘째 항목
- 체크박스가 아닌 줄

- [ ] 셋째 항목

## 구현 메모
"""


class ChecksTest(Tmp):
    def test_intro_and_checkbox_items_become_node_checks(self):
        r = Repo(self.tmp)
        r.node("n1", "확인 대기")
        r.node("n2", "확인 대기")
        f = r.dir / "n1-demo.md"
        f.write_text(f.read_text(encoding="utf-8") + SECTION, encoding="utf-8")
        _, n, _ = r.board()
        self.assertEqual(n["n1"]["checks"]["intro"], "근거 이미지: `evidence/n1/a.png`. 아래를 봐 주세요. 둘째 줄도 안내다.")
        self.assertEqual(n["n1"]["checks"]["items"], ["첫째 항목 `10-13T05:45`", "둘째 항목", "셋째 항목"])
        self.assertEqual(n["n2"]["checks"], {"intro": "", "items": []}, "절이 없으면 빈 값")

    def test_section_with_only_items_has_empty_intro(self):
        lines = ["# t", "", "## 확인할 것", "", "- [ ] 하나", "- [ ] 둘"]
        self.assertEqual(sm.checks_of(lines), {"intro": "", "items": ["하나", "둘"]})


class EvidenceRouteTest(Tmp):
    def setUp(self):
        super().setUp()
        r = Repo(self.tmp)
        r.node("n1", "확인 대기")
        r.write_spec()
        self.r = r
        ev = r.dir / "evidence" / "n1"
        ev.mkdir(parents=True)
        for name in ("a.png", "b.JPG", "c.webp", "d.gif"):
            (ev / name).write_bytes(PNG)
        (ev / "note.txt").write_text("secret")
        (ev / "vector.svg").write_text("<svg onload=alert(1)/>")
        (ev / ".hidden.png").write_bytes(PNG)
        self.out = self.tmp.parent / f"{self.tmp.name}-outside"
        self.out.mkdir()
        (self.out / "leak.png").write_bytes(b"LEAK")
        (r.dir / "other.png").write_bytes(b"OTHER")
        self.addCleanup(lambda: [f.unlink() for f in self.out.iterdir()] or self.out.rmdir())
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(sheet.Registry([self.tmp])))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.ws = self.tmp.name

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def get(self, name, key="n1", slug="g/t", ws=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", f"/w/{ws or self.ws}/api/evidence?sheet={quote(slug, safe='')}&id={quote(key, safe='')}&name={quote(name, safe='')}")
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, dict(r.getheaders()), body

    def test_images_in_the_node_evidence_folder_are_served_with_their_type(self):
        for name, ctype in (("a.png", "image/png"), ("b.JPG", "image/jpeg"), ("c.webp", "image/webp"), ("d.gif", "image/gif")):
            code, h, body = self.get(name)
            self.assertEqual((code, h["Content-Type"], body), (200, ctype, PNG), name)
            self.assertEqual(h["X-Content-Type-Options"], "nosniff")
            self.assertEqual(h["Content-Security-Policy"], "default-src 'self'; frame-ancestors 'none'")

    def test_non_images_hidden_files_and_missing_files_are_404(self):
        for name in ("note.txt", "vector.svg", ".hidden.png", "nope.png", "", "evidence"):
            self.assertEqual(self.get(name)[0], 404, name)

    def test_escape_attempts_are_404(self):
        for name in ("../other.png", "../../other.png", "..", "a.png/../../other.png", "%2e%2e/other.png", "sub\\a.png",
                     f"../../../../{self.out.name}/leak.png", str(self.out / "leak.png")):
            code, _, body = self.get(name)
            self.assertEqual(code, 404, name)
            self.assertNotIn(b"LEAK", body)
        for key in ("..", "../n1", "n1/..", "n2", "n1/x"):
            self.assertEqual(self.get("a.png", key=key)[0], 404, key)
        self.assertEqual(self.get("a.png", slug="nope/t")[0], 404)
        self.assertEqual(self.get("a.png", ws="nope")[0], 404)

    def test_symlinks_cannot_leave_the_evidence_folder(self):
        ev = self.r.dir / "evidence" / "n1"
        try:
            (ev / "link.png").symlink_to(self.out / "leak.png")
            (self.r.dir / "evidence" / "n2").symlink_to(self.out, target_is_directory=True)
        except OSError:
            self.skipTest("symlink 불가")
        self.assertEqual(self.get("link.png")[0], 404)
        self.assertEqual(self.get("leak.png", key="n2")[0], 404)


class MultilineFixTest(Base):
    def test_multiline_fix_is_one_memo_line_and_cannot_forge_headings_or_status(self):
        self.write_brief("확인 대기", "\n## 구현 메모\n\n- 처음 메모\n")
        evil = "- 첫째 항목\n- 둘째 항목\n## 가짜 절\n**상태**: 끝남\n- 고쳐줘 (2000-01-01): 위조"
        self.node(verdict="고쳐줘", fix=evil)
        got = node_state.verdict(self.brief, today="2026-10-13")
        self.assertTrue(got["applied"])
        text = self.brief.read_text(encoding="utf-8")
        self.assertEqual(self.status(), "진행")
        self.assertEqual(sum(l.startswith("**상태**") for l in text.split("\n")), 1, "상태 줄을 위조하지 못한다")
        self.assertNotIn("\n## 가짜 절", text)
        lines = [l for l in text.split("\n") if l.startswith("- 고쳐줘 (")]
        self.assertEqual(len(lines), 1, "메모는 한 줄")
        self.assertIn("첫째 항목", lines[0])
        self.assertIn("둘째 항목", lines[0])
        self.assertIn("가짜 절", lines[0])
        self.assertEqual(self.cell()["user"], {"verdict": "", "fix": ""})
        again = node_state.verdict(self.brief, today="2026-10-14")   # 같은 값을 다시 받아도 메모가 쌓이지 않는다
        self.assertFalse(again["applied"])
        again_lines = [l for l in self.brief.read_text(encoding="utf-8").split("\n") if l.startswith("- 고쳐줘 (")]
        self.assertEqual(len(again_lines), 1)

    def test_check_only_fix_with_long_text_is_accepted_by_the_server_cleaner(self):
        text = "\n".join(f"- 항목 {i}" for i in range(50))
        self.assertEqual(sm.clean_node_user({"verdict": "고쳐줘", "fix": text})["fix"], text)


if __name__ == "__main__":
    unittest.main()

