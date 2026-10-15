# spec-board

사람과 AI가 같은 그래프 작업(프로젝트 → 티켓 → 노드 → 결정)을 한 화면에서 보고, 결정과 확인에 답하는 로컬 보드입니다.

채팅으로 질문을 하나씩 주고받는 대신, 에이전트가 추천값까지 전부 채워 두고 사람은 보드에서 틀린 것만 고칩니다.
에이전트는 레포의 `spec/` 파일을 쓰고, 사람은 보드에서 `user` 칸만 씁니다. 둘이 동시에 써도 답을 잃지 않습니다.

외부 의존이 없는 파이썬 패키지입니다(3.10+). 이 보드는 macOS에서만 돌려 봤습니다. `serve`는 다른 곳에서도 될것 같지만 확인은 못 했습니다.

```sh
uv tool install git+https://github.com/dong-park/spec-board   # 또는 pipx install git+https://github.com/dong-park/spec-board
spec-board add ~/my-repo             # 보드에 보일 레포 등록
spec-board install-service           # 로그인하면 http://127.0.0.1:8790 에 뜹니다 (macOS)
spec-board serve ~/my-repo           # 또는 직접 띄우기
spec-board install-skills            # 에이전트용 스킬 설치 (아래)
```

명령 전체는 `spec-board --help` 입니다. 행 규칙(칸 주인, apply → patch/ack 흐름)은 [rows.md](spec_board/skills/spec-board/references/rows.md), 모달이 읽는 칸과 글 쓰는 규칙은 [reading.md](spec_board/skills/spec-board/references/reading.md)에 있습니다.

## 화면 쓰는 법

주소는 `http://127.0.0.1:8790` 입니다(`spec-board link spec/<슬러그> --local` 이 시트 주소를 만들어 줍니다). 시트 하나가 작업 단위(티켓 하나)입니다.

| 자리 | 하는 일 |
|---|---|
| 사이드바 | 시트 찾기 · Inbox(답할 결정·확인 대기) · Decisions · 시트 목록(진행 중 / 준비 / 끝남 접힘, 모든 워크스페이스) · 보관 · Repos & 서비스 |
| Inbox `#inbox` · Decisions `#dec` | 모든 워크스페이스의 결정·확인 대기를 한 목록으로 봅니다. 줄마다 출처(워크스페이스) 칩이 붙고, 답·통과·고쳐줘는 그 줄의 레포에 씁니다. 레포가 둘 이상이면 위 칩으로 거릅니다. 한 시트에 되돌리기 쉬운 결정이 둘 이상이면 "추천대로 N개 답하기"로 한 번에 답합니다(되돌리기 어려운 결정은 빠집니다) |
| 시트 `#s/<시트>` | 흐름 탭(웨이브로 묶은 노드 목록) · 결정 탭(`#sd/<시트>`, 이 시트의 막는 결정·답할 결정·끝남, 탭에 답할 수 배지) · spec.md 탭. 오른쪽에 속성 패널(진행·웨이브·리뷰·레포·브랜치·결정·최근 웨이브). 결정 줄을 누르면 결정 모달이 열립니다. 좁은 화면에서 패널이 접혀도 결정 탭으로 봅니다 |
| 보관 `#archive` | 보관한 시트를 모아 둡니다. 꺼내기를 누르면 원래 묶음으로 돌아갑니다. 시트 화면 머리의 "보관" 버튼으로 보관합니다 |
| Repos & 서비스 `#repos` | 등록된 워크스페이스(`spec-board add`)별 경로·시트 수·보관 수와 서비스 포트·버전 |

- **흐름 목록.** 웨이브마다 묶음 머리(번호·시각·노드 수·걸린 시간)가 있고, 맨 위 "지금"에는 진행 중인 노드가 모입니다. 줄 상태는 보고서를 쓴 당시가 아니라 지금 상태 칸 기준입니다. 줄에 마우스를 올리면 앞·뒤 노드와 그 웨이브 머리만 또렷해집니다.
- **댓글.** 노드 모달의 줄에 마우스를 올리면 왼쪽에 `+`가 뜹니다. 누르면 그 줄 아래에 GitHub PR 리뷰처럼 스레드가 생기고, 바닥 `댓글` 버튼은 노드 전체에 답니다. 에이전트는 다음 턴에 `apply`로 답 없는 스레드를 받아 `spec-board node comment`로 답합니다. `해결`을 누르면 스레드가 접힙니다. 확인 대기든 끝남이든 같은 자리에 달 수 있습니다. 스크린샷은 댓글 칸에 붙여넣거나(드래그·`이미지` 버튼도 됩니다) 에이전트가 `node comment --image`로 붙이며, 글 아래 썸네일로 보이고 누르면 커집니다.
- **보기·필터.** `H` 끝남 숨김, `F` 필터(상태·웨이브·사람 필요·결정에 막힘). "보기"에서는 묶기·순서·끝난 노드·빈 웨이브·옛 웨이브 접기·줄 속성을 바꿉니다. 설정은 브라우저(localStorage)에 남습니다. 저장된 보기 탭은 전체 · 내 차례 · 오늘입니다.
- **보관.** `ticket.json`의 `user.archived` 하나만 씁니다 => 보관한 시트는 사이드바 목록과 Inbox·Decisions 숫자·목록에서 빠집니다. 사람이 보드에서 쓰는 칸(보관·멈춤·우선순위·통과·고쳐줘·댓글)은 레포가 아니라 이 기기의 `~/.local/share/spec-board/`에 둡니다 => 커밋되지 않고, 같은 레포의 워크트리끼리 같은 값을 보며, 워크트리를 지워도 남습니다. 레포 안에 옛 `ticket.json`·`rows/nodes/`가 있으면 처음 읽을 때 한 번 옮겨 옵니다. 잠금·에이전트 id·선행 리포트 같은 실행 중 임시 파일은 레포에 쌓이지 않도록 `.git/info/exclude`에 제외 줄을 넣습니다(커밋되지 않고, 이미 추적 중인 파일은 건드리지 않습니다). 행·브리프·웨이브 보고서·근거 이미지는 올릴 산출물이라 가리지 않습니다.

### 웨이브 보고서 형식 (화면이 읽는 계약)

흐름 목록은 `spec/<티켓>/wave-*.md`를 읽습니다(웨이브를 돌리는 에이전트가 씁니다).

1) 첫 줄 `# wave <시각> · 스레드 <id>`. 시각은 `YYYYMMDD-HHMM`, `YYYY-MM-DD HH:MM`, `YYYY-MM-DD HH:MM:SS UTC`(+9시간으로 읽습니다)가 되고, 날짜만 있어도 됩니다(시각은 파일 이름에서 빌립니다). 이 줄이 없으면 그 보고서는 건너뛰고 티켓에 경고를 남깁니다.
2) `## 노드` 아래 `ID | 상태 | 결론 | 커밋` 줄. 앞뒤 파이프가 있어도 없어도 됩니다.
3) `## 소요`의 "N분" 가운데 가장 큰 값이 묶음 머리의 걸린 시간이고, `## /review` 첫 줄의 낱말(승인·수정 요청·미실행·생략)이 리뷰 칩이 됩니다.

### 서비스

코드를 고친 뒤에는 `launchctl kickstart -k gui/$(id -u)/com.spec-board` 로 다시 띄웁니다(editable 설치라 코드는 바로 반영되고 서버 프로세스만 재시작하면 됩니다).
읽기 API는 `/api/board?w=<워크스페이스>` · `/api/sheets`(전체 시트 요약) · `/api/inbox`(전체 결정·확인 대기, `?v=`가 같으면 버전만) · `/api/repos` · `/api/version` · `/api/events`(SSE) 입니다.

**실시간 알림.** `/api/events`는 보드가 바뀌었다는 신호만 보냅니다(`hello`·`changed`·15초마다 ping). 연결이 있을 때만 서버 스레드 하나가 1.5초마다 워크스페이스 버전을 보고, 연결은 8개까지 받습니다. 화면은 신호를 받으면 지금처럼 보드·`/api/inbox`를 다시 받고, 새로 생긴 결정·확인 대기에 "새" 표시·탭 제목 숫자·화면 안 알림을 띄웁니다. Inbox의 "알림 켜기"를 누르면 탭을 안 보고 있을 때 데스크톱 알림도 띄웁니다(기본은 막는 결정·확인 대기만, 설정은 이 브라우저에만). SSE가 끊기면 다시 붙을 때까지 3초마다 묻는 방식으로 돌아갑니다.
인증이 없어서 `--host 0.0.0.0` 으로는 띄우지 않습니다. 기본값은 127.0.0.1에만 바인딩하는 것입니다.

## 에이전트 스킬

보드를 쓰는 에이전트(Claude Code, Codex 등)가 같은 방식으로 일하도록 사용 지침을 스킬 하나로 같이 배포합니다. 보드에 쓰는 법, 사람의 답을 반영하는 법, 노드 상태 명령, 웨이브 보고서 형식이 들어 있습니다.

```sh
spec-board install-skills                        # 터미널이면 설치할 곳을 고르는 TUI (↑↓ · space · a · enter · q)
spec-board install-skills --target claude,codex  # 바로 설치 (claude · codex · agents · 또는 폴더 경로)
spec-board install-skills --list                 # 설치 상태만 봅니다
spec-board install-skills --uninstall --target claude
```

복사본을 둡니다 => 패키지를 갱신한 뒤 다시 실행하면 새 내용으로 바뀝니다. 이 명령이 만들지 않은 같은 이름의 폴더는 덮어쓰지 않습니다(`--force` 가 있어야 합니다). 스킬 원본은 [spec_board/skills/spec-board](spec_board/skills/spec-board/SKILL.md)에 있습니다.

## 검증

```sh
python3 -m unittest discover -s tests
for f in spec_board/board_web/*.test.mjs; do node --test "$f"; done
python3 spec_board/sheet_stress.py --seconds 10   # 동시 저장. 잃은 답 0이어야 통과 (--no-base는 대조군이라 실패해야 정상)
```

써 보시다가 이상한 곳이 있으면 이슈로 남겨 주세요!

## 라이선스

MIT — [LICENSE](LICENSE).

