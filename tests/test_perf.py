#!/usr/bin/env python3
"""보드 서버 성능 경로 테스트 — gzip, 정적 ETag/Last-Modified(304), w 없는 가벼운 목록, /api/spec.

  python3 -m unittest discover -s tests -p 'test_perf.py'
"""
import gzip
import http.client
import json
import sys
import threading
import unittest
from email.utils import formatdate
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import sheet
from test_spec_model import Repo, Tmp


class PerfTest(Tmp):
    def setUp(self):
        super().setUp()
        r = Repo(self.tmp)
        for i in range(1, 12):
            r.node(f"n{i}", "아직 안 함" if i > 1 else "끝남", deps=(f"n{i - 1}",) if i > 1 else ())
        r.row("D1", "decision", blocks=["n2"], reversible=False)
        r.write_spec()
        self.r = r
        self.reg = sheet.Registry([self.tmp])
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(self.reg))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.ws = self.tmp.name

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def get(self, path, **headers):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers={"Accept-Encoding": "identity", **headers})
        r = c.getresponse()
        body = r.read()
        out = (r.status, {k.lower(): v for k, v in r.getheaders()}, body)
        c.close()
        return out

    # ── gzip
    def test_json_is_gzipped_when_asked_and_round_trips(self):
        plain = self.get(f"/api/board?w={self.ws}")
        self.assertNotIn("content-encoding", plain[1])
        gz = self.get(f"/api/board?w={self.ws}", **{"Accept-Encoding": "gzip, deflate"})
        self.assertEqual(gz[1]["content-encoding"], "gzip")
        self.assertEqual(gz[1]["vary"], "Accept-Encoding")
        self.assertLess(len(gz[2]), len(plain[2]))
        self.assertEqual(json.loads(gzip.decompress(gz[2])), json.loads(plain[2]))
        self.assertEqual(int(gz[1]["content-length"]), len(gz[2]))

    def test_gzip_q0_and_small_bodies_stay_plain(self):
        self.assertNotIn("content-encoding", self.get(f"/api/board?w={self.ws}", **{"Accept-Encoding": "gzip;q=0"})[1])
        small = self.get("/api/board?w=nope", **{"Accept-Encoding": "gzip"})   # 404 한 줄
        self.assertEqual(small[0], 404)
        self.assertNotIn("content-encoding", small[1])

    def test_static_files_are_gzipped_too(self):
        got = self.get("/board/view.js", **{"Accept-Encoding": "gzip"})
        self.assertEqual((got[0], got[1]["content-encoding"]), (200, "gzip"))
        self.assertEqual(gzip.decompress(got[2]), (sheet.BOARD_WEB / "view.js").read_bytes())

    def test_accepts_gzip_parser(self):
        for h, want in (("gzip", True), ("gzip, deflate, br", True), ("br, gzip;q=0.5", True), ("gzip;q=0", False),
                        ("identity", False), ("", False), (None, False), ("x-gzip", True)):
            self.assertIs(sheet.accepts_gzip(h), want, h)

    # ── ETag
    def test_static_etag_and_conditional_requests(self):
        first = self.get("/board/tokens.css")
        etag, last = first[1]["etag"], first[1]["last-modified"]
        self.assertTrue(etag.startswith('"') and last.endswith("GMT"))
        self.assertEqual(first[1]["cache-control"], "no-cache")
        for hdr in ({"If-None-Match": etag}, {"If-None-Match": f'W/{etag}'}, {"If-None-Match": f'"zzz", {etag}'}):
            code, h, body = self.get("/board/tokens.css", **hdr)
            self.assertEqual((code, body), (304, b""), hdr)
            self.assertEqual(h["etag"], etag)
        code, _, body = self.get("/board/tokens.css", **{"If-None-Match": '"other"'})
        self.assertEqual((code, body), (200, first[2]))
        code, _, _ = self.get("/board/tokens.css", **{"If-Modified-Since": last})
        self.assertEqual(code, 304)
        old = formatdate(0, usegmt=True)
        self.assertEqual(self.get("/board/tokens.css", **{"If-Modified-Since": old})[0], 200)
        self.assertEqual(self.get("/board/tokens.css", **{"If-Modified-Since": "garbage"})[0], 200)

    def test_etag_changes_when_the_file_changes(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "a.js"
            f.write_text("1")
            e1 = sheet.board_asset("a.js", Path(d))
            f.write_text("22")
            os.utime(f, ns=(e1[2] + 5_000_000_000, e1[2] + 5_000_000_000))
            e2 = sheet.board_asset("a.js", Path(d))
            self.assertNotEqual((len(e1[0]), e1[2]), (len(e2[0]), e2[2]))

    # ── 가벼운 모델
    def test_board_model_carries_neither_decisions_copy_nor_spec_md(self):
        j = json.loads(self.get(f"/api/board?w={self.ws}")[2])
        self.assertNotIn("decisions", j)
        t = j["projects"][0]["tickets"][0]
        self.assertNotIn("spec_md", t)
        self.assertEqual([r["id"] for r in t["rows"] if r["kind"] == "decision"], ["D1"])
        self.assertEqual((j["summary"]["decisions_open"], j["summary"]["decisions_blocking"]), (1, 1))

    def test_without_w_the_server_lists_workspaces_without_building_boards(self):
        with mock.patch.object(sheet, "build_board", side_effect=AssertionError("보드를 계산하면 안 된다")):
            code, _, body = self.get("/api/board")
        self.assertEqual(code, 200)
        ws = json.loads(body)["workspaces"]
        mine = next(w for w in ws if w["workspace"] == self.ws)
        self.assertEqual((mine["tickets"], mine["local"]), (1, True))
        self.assertNotIn("projects", mine)

    # ── /api/spec
    def test_spec_endpoint_reads_the_markdown_on_demand(self):
        code, _, body = self.get(f"/w/{self.ws}/api/spec?sheet=g/t")
        j = json.loads(body)
        self.assertEqual(code, 200)
        self.assertEqual(j["spec_md"], (self.r.dir / "spec.md").read_text(encoding="utf-8").rstrip("\n"))
        self.assertEqual(self.get(f"/w/{self.ws}/api/spec?sheet=g/none")[0], 404)
        self.assertEqual(self.get(f"/w/nope/api/spec?sheet=g/t")[0], 404)
        self.assertEqual(self.get(f"/w/{self.ws}/api/spec?sheet=../../etc")[0], 404)   # 티켓 목록에 없는 이름은 안 읽는다

    def test_etag_is_not_sent_for_json(self):
        self.assertNotIn("etag", self.get(f"/api/board?w={self.ws}")[1])
        self.assertEqual(self.get(f"/api/board?w={self.ws}")[1]["cache-control"], "no-store")

    # ── .tmp-* 제외
    def test_tmp_files_do_not_make_a_sheet_or_a_version(self):
        rows = self.r.dir / "rows"
        (rows / ".tmp-zzz.json").write_text("{partial")
        self.assertEqual(sorted(p.name for p in sheet.json_files(rows)), ["D1.json"])
        board = json.loads(self.get(f"/api/board?w={self.ws}")[2])
        ids = [r["id"] for r in board["projects"][0]["tickets"][0]["rows"]]
        self.assertEqual(ids, ["D1"])
        self.assertEqual(self.get(f"/w/{self.ws}/api/spec?sheet=g/t")[0], 200)


if __name__ == "__main__":
    unittest.main()
