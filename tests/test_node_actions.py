#!/usr/bin/env python3
"""sheet.py의 접근 판정·노드 커밋 테스트 — 보드는 에이전트를 부르지 않는다. 실행은 채팅의 /go다.

  python3 -m unittest discover -s tests -p 'test_node_actions.py'

"""
import http.client
import json
import subprocess
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("SPEC_SHEET_HOSTS", "box.example.ts.net")   # 원격(tailnet) 접근 시험용 가짜 이름
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import sheet
from test_spec_model import Repo, Tmp


class Headers(dict):
    def get(self, k, d=None):
        return super().get(k.lower(), d)


def h(**kw):
    return Headers({k.replace("_", "-").lower(): v for k, v in kw.items()})


class IsLocalTest(unittest.TestCase):
    def test_loopback_with_loopback_host_is_local(self):
        self.assertTrue(sheet.is_local_request("127.0.0.1", h(Host="127.0.0.1:8790")))
        self.assertTrue(sheet.is_local_request("::1", h(Host="[::1]:8790")))
        self.assertTrue(sheet.is_local_request("127.0.0.1", h(Host="localhost:8790")))

    def test_tailnet_proxy_to_loopback_is_not_local(self):
        # tailscale serve는 요청을 127.0.0.1로 넘긴다 — 접속 주소만 보면 원격이 로컬로 보인다
        host = {"Host": "box.example.ts.net:8443"}
        self.assertFalse(sheet.is_local_request("127.0.0.1", h(**host)))
        self.assertFalse(sheet.is_local_request("127.0.0.1", h(Host="127.0.0.1:8790", Tailscale_User_Login="a@b.c")))
        self.assertFalse(sheet.is_local_request("127.0.0.1", h(Host="127.0.0.1:8790", X_Forwarded_For="100.64.0.5")))
        self.assertFalse(sheet.is_local_request("127.0.0.1", h(Host="127.0.0.1:8790", Forwarded="for=1.2.3.4")))

    def test_other_origins_and_addresses_are_not_local(self):
        self.assertFalse(sheet.is_local_request("100.64.0.5", h(Host="127.0.0.1:8790")))
        self.assertFalse(sheet.is_local_request("192.168.0.9", h(Host="localhost:8790")))
        self.assertFalse(sheet.is_local_request("127.0.0.1", h()))   # Host가 없으면 믿지 않는다
        self.assertFalse(sheet.is_local_request("127.0.0.1", h(Host="evil.example:8790")))   # DNS 재바인딩
        self.assertFalse(sheet.is_local_request("127.0.0.1", h(Host="127.0.0.1:8790", Origin="https://evil.example")))
        self.assertTrue(sheet.is_local_request("127.0.0.1", h(Host="127.0.0.1:8790", Origin="http://127.0.0.1:8790")))


class ServerAccessTest(Tmp):
    def setUp(self):
        super().setUp()
        self.r = Repo(self.tmp)
        self.r.node("n1", "확인 대기")
        self.r.write_spec()
        self.reg = sheet.Registry([self.tmp])
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(self.reg))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.ws = self.tmp.name

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def req(self, method, path, body=None, headers=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hs = {"Host": host or f"127.0.0.1:{self.port}", "Content-Type": "application/json", **(headers or {})}
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            hs["Content-Length"] = str(len(data))
        for k, v in hs.items():
            c.putheader(k, v)
        c.endheaders(data)
        r = c.getresponse()
        raw = r.read()
        c.close()
        return r.status, json.loads(raw or b"{}")

    def test_no_agent_launch_path(self):
        # 보드는 에이전트를 부르지 않는다 — 실행은 채팅의 /go
        code, _ = self.req("POST", f"/w/{self.ws}/api/act", {"sheet": "g/t", "id": "n1", "action": "open"})
        self.assertEqual(code, 404)

    def test_form_content_type_is_rejected(self):
        # text/plain은 다른 사이트가 브라우저로 쏠 수 있는 단순 요청이다
        code, _ = self.req("POST", f"/w/{self.ws}/api/node", {"sheet": "g/t", "id": "n1", "user": {"verdict": "통과"}},
                           headers={"Content-Type": "text/plain"})
        self.assertEqual(code, 415)

    def test_board_tells_the_screen_whether_it_is_local(self):
        code, j = self.req("GET", f"/api/board?w={self.ws}")
        self.assertEqual((code, j["local"]), (200, True))
        code, j = self.req("GET", f"/api/board?w={self.ws}", headers={"Tailscale-User-Login": "me@example.com"})
        self.assertEqual((code, j["local"]), (200, False))
        code, j = self.req("GET", "/api/board", host="box.example.ts.net:8443")
        self.assertTrue(all(w["local"] is False for w in j["workspaces"]))

    def test_remote_can_still_save_verdict(self):
        # 통과·고쳐줘는 사람 칸 쓰기라 폰에서도 된다
        code, j = self.req("POST", f"/w/{self.ws}/api/node", {"sheet": "g/t", "id": "n1", "user": {"verdict": "통과"}},
                           host="box.example.ts.net:8443", headers={"Tailscale-User-Login": "me@example.com"})
        self.assertEqual((code, j["user"]["verdict"]), (200, "통과"))


class CommitsTest(Tmp):
    def git(self, *a):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", str(self.tmp), *a],
                              capture_output=True, text=True, check=True).stdout.strip()

    def test_only_hashes_written_in_the_brief_are_shown_and_checked(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.write_spec()
        self.git("init", "-q")
        (self.tmp / "a.txt").write_text("a")
        self.git("add", "a.txt")
        self.git("commit", "-q", "-m", "feat: 노드 모달")
        full = self.git("rev-parse", "HEAD")
        b = r.dir / "n1-demo.md"
        b.write_text(b.read_text() + f"\n- 커밋 `{full[:7]}`과 없는 `deadbeef0`, 같은 `{full[:7]}`\n")
        ticket = sheet.find_tickets(self.tmp)["g/t"]
        got = sheet.node_commits(self.tmp, ticket, "g/t", "n1")
        self.assertEqual([c["verified"] for c in got], [True, False])
        self.assertEqual(got[0]["subject"], "feat: 노드 모달")
        self.assertEqual(got[0]["hash"], full[:7])

    def test_no_hash_means_empty_not_a_guess(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.write_spec()
        self.git("init", "-q")
        ticket = sheet.find_tickets(self.tmp)["g/t"]
        self.assertEqual(sheet.node_commits(self.tmp, ticket, "g/t", "n1"), [])


if __name__ == "__main__":
    unittest.main()
