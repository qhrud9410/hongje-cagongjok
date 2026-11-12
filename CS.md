# CS 관리 탭

고객 문의(카톡)를 붙여 넣으면 홍제점 점주 말투로 답장 초안을 만든다. 보내는 건 사람이 직접 한다.

## 구조
- 화면: `cs.js`(탭), `cs.css`. `index.html`은 탭 버튼, `viewCS()`, 실시간 신호 연결만 맡는다. 파일을 못 불러와도 다른 탭은 그대로 동작.
- 서버: Supabase Edge Function `cs` (`supabase/functions/cs/`). 기존 `api`와 분리해 두었다. 점주 전용 — 점주 PIN일 때만 응답 (6번 틀리면 10분 잠김).
- 지식·말투: `supabase/functions/cs/prompt.ts`. 본사 매뉴얼(구글 드라이브 '카공족 메뉴얼 자료')에서 고객 응대용 내용만 옮김. 내부 암호·업체 연락처는 넣지 않음.
- 점주가 화면에서 고치는 값: settings 표의 `CS말투`, `CS매장정보` (본사 매뉴얼보다 우선).
- 기록: `cs_replies` 표 (service_role만 접근). 바뀌면 `hongje-sync`로 표 이름만 신호 → CS 탭이 목록만 다시 불러옴.
- AI: Claude API (`ANTHROPIC_API_KEY` Edge Function 비밀값). 모델은 `CS_MODEL` 비밀값으로 바꿀 수 있음(기본 claude-sonnet-5-5, 안 되면 claude-sonnet-4-5).
- 하루 150번까지만 만들 수 있음 (비용 안전장치).

## 서버 기능 (`cs` 함수)
`csReply`(답장 만들기, `id`+`extra`면 이전 초안을 고쳐 새 줄로 저장), `csList`(최근 60개 + 설정), `csDelete`, `csSettingsSave` — 모두 점주 PIN 필요.

## 카톡 채널 자동응답 문구
`cs.js`의 `MENU` (리스트 메뉴 10개). CS 탭 아래 ‘카톡 채널 자동응답 문구’에서 복사.

## 배포 순서
1. 마이그레이션 `20261112090000_cs_replies.sql` → 2. `cs` 함수 배포 + `ANTHROPIC_API_KEY` 비밀값 → 3. GitHub Pages에 화면 반영.
