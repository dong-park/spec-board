#!/usr/bin/env python3
"""sheet.py의 보드 화면 서빙 테스트 (n14 작업 4) — board_web/의 .html .js .css만 나가고 폴더 밖은 404.

  python3 -m unittest discover -s tests -p 'test_board_static.py'
"""
import http.client
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import sheet
from test_spec_model import Repo, Tmp


class BoardStaticTest(Tmp):
    def setUp(self):
        super().setUp()
        Repo(self.tmp).write_spec()
        self.reg = sheet.Registry([self.tmp])
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(self.reg))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.ws = self.tmp.name

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, dict(r.getheaders()), body

    def test_allowed_files_are_served_with_their_type(self):
        for path, ctype, needle in (("/board/", "text/html", b"<title>"),
                                    ("/board/index.html", "text/html", b"<title>"),
                                    ("/board/inbox.js", "javascript", b"BoardInbox"),
                                    ("/board/tokens.css", "text/css", b"--bg")):
            code, h, body = self.get(path)
            self.assertEqual(code, 200, path)
            self.assertIn(ctype, h["Content-Type"], path)
            self.assertIn(needle, body, path)

    def test_same_files_under_the_workspace_prefix(self):
        code, _, body = self.get(f"/w/{self.ws}/board/")
        self.assertEqual(code, 200)
        self.assertEqual(body, self.get("/board/")[2])
        self.assertEqual(self.get(f"/w/{self.ws}/board/view.js")[0], 200)
        self.assertEqual(self.get("/w/%EC%97%86%EB%8A%94%EA%B3%B3/board/")[0], 404)   # 없는곳

    def test_board_without_slash_redirects_so_relative_scripts_resolve(self):
        code, h, _ = self.get("/board")
        self.assertEqual((code, h["Location"]), (301, "/board/"))

    def test_old_sheet_addresses_redirect_to_the_board(self):
        for path, to in (("/", "/board/"), (f"/w/{self.ws}/", f"/w/{self.ws}/board/"), (f"/w/{self.ws}", f"/w/{self.ws}/board/"),
                         ("/?w=x", "/board/?w=x")):
            code, h, _ = self.get(path)
            self.assertEqual((code, h["Location"]), (302, to), path)

    def test_old_screen_apis_are_gone(self):
        for path in ("/api/all", "/api/version", f"/w/{self.ws}/api/sheets"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_old_page_code_is_removed_from_the_server(self):
        src = Path(sheet.__file__).read_text(encoding="utf-8")
        for needle in ("PAGE = ", "def snapshot(", "def blocking(", "rsms.me/inter", "/api/all"):
            self.assertNotIn(needle, src, needle)

    def test_link_points_at_the_board_inbox(self):
        import os
        from unittest import mock
        ticket = sheet.find_sheets(self.tmp)
        spec = next(iter(ticket.values())) if ticket else self.tmp / "spec" / "g" / "t"
        (spec / "rows").mkdir(parents=True, exist_ok=True)
        conf = self.tmp / "conf" / "roots"
        with mock.patch.dict(os.environ, {"SPEC_SHEET_URL": "https://x.ts.net:8443"}), \
                mock.patch.object(sheet, "CONF", conf):
            got = sheet.link(spec)
            again = sheet.link(spec)
            fresh = sheet.Registry([]).roots()   # 레포 인자 없이 뜬 서버의 눈
        self.assertEqual(got, f"https://x.ts.net:8443/w/{self.tmp.name}/board/#inbox")
        self.assertEqual(again, got)
        self.assertEqual(fresh.get(self.tmp.name), self.tmp.resolve())
        self.assertEqual(conf.read_text().splitlines(), [str(self.tmp.resolve())])   # 두 번 불러도 한 줄

    def test_nothing_outside_the_folder_or_the_whitelist_is_served(self):
        for path in ("/board/../sheet.py", "/board/..%2fsheet.py", "/board/%2e%2e/sheet.py", "/board/..",
                     "/board/%2e%2e%2fsheet.py", "/board/sub/view.js", "/board/view.test.mjs",
                     "/board/decisions.test.mjs", "/board/nope.js", "/board/.hidden.js",
                     f"/w/{self.ws}/board/../../sheet.py", "/board/index.html/"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_a_symlink_pointing_outside_is_not_followed(self):
        link = sheet.BOARD_WEB / "zz_escape.js"
        try:
            link.symlink_to(Path(sheet.__file__).resolve())
        except OSError:
            self.skipTest("symlink 불가")
        try:
            self.assertEqual(self.get("/board/zz_escape.js")[0], 404)
        finally:
            link.unlink()


if __name__ == "__main__":
    unittest.main()
