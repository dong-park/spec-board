#!/usr/bin/env python3
"""보안 테스트 — Host 허용 목록, Origin·Content-Type, 500 고정 문구, 브리프·evidence 경로 가드.

  python3 -m unittest discover -s tests -p 'test_security.py'
"""
import http.client
import io
import json
import subprocess
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

os.environ.setdefault("SPEC_SHEET_HOSTS", "box.example.ts.net")   # 원격(tailnet) 접근 시험용 가짜 이름
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import sheet
import spec_model as sm
from test_spec_model import Repo, Tmp


class HostNameTest(unittest.TestCase):
    def test_port_and_case_are_dropped(self):
        self.assertEqual(sheet.host_name("127.0.0.1:8790"), "127.0.0.1")
        self.assertEqual(sheet.host_name("LocalHost:1"), "localhost")
        self.assertEqual(sheet.host_name("[::1]:8790"), "[::1]")
        self.assertEqual(sheet.host_name("[::1]"), "[::1]")
        self.assertEqual(sheet.host_name("box.example.ts.net:8443"), "box.example.ts.net")
        self.assertEqual(sheet.host_name(""), "")

    def test_default_list_has_only_loopback_and_extras_are_added(self):
        with mock.patch.object(sheet, "HOSTS_CONF", Path("/nonexistent/hosts")), mock.patch.dict("os.environ", {"SPEC_SHEET_HOSTS": ""}):
            base = sheet.load_allowed_hosts()
            self.assertTrue({"127.0.0.1", "localhost", "[::1]"} <= base)
            self.assertNotIn("evil.example", base)
            self.assertIn("mini.tail1234.ts.net", sheet.load_allowed_hosts(["Mini.tail1234.ts.net:8443"]))
        with mock.patch.dict("os.environ", {"SPEC_SHEET_HOSTS": "a.ts.net, b.ts.net"}):
            self.assertTrue({"a.ts.net", "b.ts.net"} <= sheet.load_allowed_hosts())

    def test_conf_file_adds_names_and_skips_comments(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "hosts"
            f.write_text("# 내 맥미니\nmini.ts.net\n\n")
            with mock.patch.object(sheet, "HOSTS_CONF", f):
                got = sheet.load_allowed_hosts()
            self.assertIn("mini.ts.net", got)
            self.assertNotIn("# 내 맥미니", got)


class GateTest(Tmp):
    def setUp(self):
        super().setUp()
        r = Repo(self.tmp)
        r.node("n1", "확인 대기", check="필요")
        r.write_spec()
        self.r = r
        self.reg = sheet.Registry([self.tmp])
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(self.reg, sheet.load_allowed_hosts()))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.ws = self.tmp.name

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def req(self, method, path, body=None, host="", headers=None, ctype="application/json", raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hs = {"Host": host or f"127.0.0.1:{self.port}", **({"Content-Type": ctype} if ctype else {}), **(headers or {})}
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if data is not None:
            hs["Content-Length"] = str(len(data))
        for k, v in hs.items():
            c.putheader(k, v)
        c.endheaders(data)
        r = c.getresponse()
        out = r.read()
        c.close()
        try:
            return r.status, json.loads(out or b"{}")
        except ValueError:
            return r.status, out

    def node_post(self, **kw):
        return self.req("POST", f"/w/{self.ws}/api/node", {"sheet": "g/t", "id": "n1", "user": {"verdict": "통과"}}, **kw)

    # ── Host 허용 목록
    def test_unknown_host_is_403_on_every_route(self):
        for path in ("/api/board", f"/api/board?w={self.ws}", "/board/", "/board/view.js", f"/w/{self.ws}/board/",
                     f"/w/{self.ws}/api/commits?sheet=g/t&id=n1", "/"):
            code, _ = self.req("GET", path, host="evil.example:8790")
            self.assertEqual(code, 403, path)

    def test_missing_host_is_403(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("GET", "/api/board", skip_host=True, skip_accept_encoding=True)
        c.endheaders()
        self.assertEqual(c.getresponse().status, 403)
        c.close()

    def test_listed_hosts_pass(self):
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", "box.example.ts.net:8443",
                     f"[::1]:{self.port}"):
            self.assertEqual(self.req("GET", "/api/board?w=" + self.ws, host=host)[0], 200, host)

    def test_post_with_unknown_host_is_403_and_writes_nothing(self):
        code, _ = self.node_post(host="evil.example")
        self.assertEqual(code, 403)
        self.assertFalse((self.r.dir / "rows" / "nodes" / "n1.json").exists())

    # ── Origin·Content-Type
    def test_post_origin_must_match_host(self):
        host = f"127.0.0.1:{self.port}"
        self.assertEqual(self.node_post(headers={"Origin": f"http://{host}"})[0], 200)
        for origin in ("https://evil.example", "null", f"http://127.0.0.1:{self.port + 1}"):
            code, _ = self.node_post(headers={"Origin": origin})
            self.assertEqual(code, 403, origin)

    def test_tailnet_origin_matching_its_host_is_accepted(self):
        host = "box.example.ts.net:8443"
        code, _ = self.node_post(host=host, headers={"Origin": f"https://{host}"})
        self.assertEqual(code, 200)

    def test_post_only_json_is_accepted(self):
        for ct in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""):
            code, _ = self.node_post(ctype=ct)
            self.assertEqual(code, 415, ct)
        self.assertFalse((self.r.dir / "rows" / "nodes" / "n1.json").exists())
        self.assertEqual(self.node_post(ctype="application/json; charset=utf-8")[0], 200)

    # ── 응답 머리말·타임아웃·Host 먼저
    def raw_get(self, path, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
        c.putheader("Host", host or f"127.0.0.1:{self.port}")
        c.endheaders()
        r = c.getresponse()
        r.read()
        h = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, h

    def test_every_kind_of_response_carries_the_security_headers(self):
        want = {"content-security-policy": "default-src 'self'; frame-ancestors 'none'",
                "x-content-type-options": "nosniff"}
        paths = ["/board/", "/board/view.js", "/board/boot.js", "/api/board", f"/api/board?w={self.ws}",
                 f"/w/{self.ws}/api/spec?sheet=g/t", "/board/nope.js",     # 200 · 200 · 200 · JSON · JSON · JSON · 404
                 "/", "/board"]                                           # 302 · 301
        for path in paths:
            code, h = self.raw_get(path)
            for k, v in want.items():
                self.assertEqual(h.get(k), v, f"{path} ({code}) {k}")
        code, h = self.raw_get("/board/", host="evil.example")             # 403도 같다
        self.assertEqual(code, 403)
        self.assertEqual(h.get("x-content-type-options"), "nosniff")

    def test_304_and_post_responses_carry_them_too(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/board/view.js")
        r = c.getresponse()
        r.read()
        etag = r.getheader("ETag")
        c.request("GET", "/board/view.js", headers={"If-None-Match": etag})
        r = c.getresponse()
        r.read()
        self.assertEqual(r.status, 304)
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        c.close()
        code, _ = self.node_post()
        self.assertEqual(code, 200)

    def test_handler_has_a_request_timeout(self):
        h = sheet.make_handler(self.reg, sheet.load_allowed_hosts())
        self.assertEqual(h.timeout, 10)

    def test_post_from_unknown_host_is_refused_before_the_body_is_read(self):
        import socket
        s = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        s.sendall((f"POST /w/{self.ws}/api/node HTTP/1.1\r\nHost: evil.example\r\n"
                   "Content-Type: application/json\r\nContent-Length: 5000\r\n\r\n").encode())   # 본문은 안 보낸다
        got = s.recv(4096)                                            # 본문을 기다렸다면 여기서 타임아웃이다
        s.close()
        self.assertTrue(got.startswith(b"HTTP/1.0 403") or got.startswith(b"HTTP/1.1 403"), got[:40])

    def test_refused_post_with_a_body_is_still_answered_cleanly(self):
        code, body = self.node_post(host="evil.example")
        self.assertEqual(code, 403)
        self.assertIn("error", body)

    # ── 500
    def test_500_has_fixed_text_and_detail_goes_to_the_log(self):
        err = io.StringIO()
        with mock.patch.object(sheet, "build_board", side_effect=RuntimeError("SECRET-PATH /Users/x/y")), redirect_stderr(err):
            code, j = self.req("GET", f"/api/board?w={self.ws}")
        self.assertEqual(code, 500)
        self.assertNotIn("SECRET", json.dumps(j))
        self.assertNotIn("RuntimeError", json.dumps(j))
        self.assertIn("SECRET-PATH", err.getvalue())
        self.assertIn("Traceback", err.getvalue())

    def test_post_unexpected_error_is_500_fixed_text(self):
        err = io.StringIO()
        with mock.patch.object(sheet, "save_node_user", side_effect=OSError("disk /secret/path")), redirect_stderr(err):
            code, j = self.node_post()
        self.assertEqual(code, 500)
        self.assertNotIn("secret", json.dumps(j))
        self.assertIn("/secret/path", err.getvalue())


class PathGuardTest(Tmp):
    def secret(self):
        out = self.tmp.parent / f"{self.tmp.name}-outside"
        out.mkdir(exist_ok=True)
        (out / "n9-evil.md").write_text("# n9 — evil\n\n**상태**: 끝남\n**id**: EV-9\n\n## 문제\n\n비밀 `abcdef1234`\n", encoding="utf-8")
        (out / "leak.png").write_text("x")

        def cleanup():
            for f in out.iterdir():
                f.unlink()
            out.rmdir()
        self.addCleanup(cleanup)
        return out

    def test_brief_path_outside_ticket_is_an_error_card_and_not_read(self):
        out = self.secret()
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.index.append(("n9", f"../../../../{out.name}/n9-evil.md", "—", "끝남"))
        r.index.append(("n8", "../../../README.md", "—", "끝남"))
        t, n, _ = r.board()
        for k in ("n9", "n8"):
            self.assertIn("티켓 폴더 밖", n[k]["error"], k)
            self.assertEqual(n[k]["problem"], "")
            self.assertNotEqual(n[k]["id"], "EV-9")
        self.assertEqual(n["n1"]["error"], "")

    def test_symlinked_brief_pointing_outside_is_refused(self):
        out = self.secret()
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        link = r.dir / "n2-link.md"
        try:
            link.symlink_to(out / "n9-evil.md")
        except OSError:
            self.skipTest("symlink 불가")
        r.index.append(("n2", "n2-link.md", "—", "끝남"))
        _, n, _ = r.board()
        self.assertIn("티켓 폴더 밖", n["n2"]["error"])

    def test_evidence_listed_only_for_id_like_keys(self):
        out = self.secret()
        r = Repo(self.tmp)
        r.node("n1", "확인 대기")
        (r.dir / "evidence" / "n1").mkdir(parents=True)
        (r.dir / "evidence" / "n1" / "shot.png").write_text("x")
        r.index.append(("../../../../" + out.name, "n1-demo.md", "—", "끝남"))   # 표의 key가 경로
        _, n, _ = r.board()
        self.assertEqual(n["n1"]["evidence"], ["shot.png"])
        self.assertEqual(n["../../../../" + out.name]["evidence"], [])

    def test_evidence_dir_symlinked_outside_is_not_listed(self):
        out = self.secret()
        r = Repo(self.tmp)
        r.node("n1", "확인 대기")
        (r.dir / "evidence").mkdir()
        try:
            (r.dir / "evidence" / "n1").symlink_to(out, target_is_directory=True)
        except OSError:
            self.skipTest("symlink 불가")
        _, n, _ = r.board()
        self.assertEqual(n["n1"]["evidence"], [])

    def test_commits_guard_returns_nothing_for_outside_brief(self):
        out = self.secret()
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.index.append(("n9", f"../../../../{out.name}/n9-evil.md", "—", "끝남"))
        r.write_spec()
        subprocess.run(["git", "-C", str(self.tmp), "init", "-q"], check=True)
        ticket = sheet.find_tickets(self.tmp)["g/t"]
        self.assertEqual(sheet.node_commits(self.tmp, ticket, "g/t", "n9"), [])

    def test_inside_helper(self):
        base = self.tmp / "t"
        base.mkdir()
        self.assertIsNotNone(sm.inside(base, base / "a.md"))
        self.assertIsNone(sm.inside(base, base / ".." / "x.md"))
        self.assertIsNone(sm.inside(base, Path("/etc/passwd")))
        self.assertIsNone(sm.brief_path(base, ""))
        self.assertIsNone(sm.brief_path(base, "../x.md"))


if __name__ == "__main__":
    unittest.main()
