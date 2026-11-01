# 매출·비용 탭 (점주 전용)

## 구조
- 화면: `finance.js`(탭), `finance-core.js`(계산·CSV), `finance.css`. `index.html`은 탭 버튼, `viewFinance()`, 급여 계산 연결만 맡는다.
- 데이터: 점주가 `load`를 부르면 응답에 `finance: {month, tx, months}`가 함께 온다 (rewards·purchases와 같은 방식). 매니저 응답에는 `finance: null`.
- 저장: 모두 서버 함수에서 점주 PIN 확인 뒤 처리. 브라우저에는 장부를 저장하지 않는다.
- 실시간: `finance_tx`, `finance_month`가 바뀌면 다른 표처럼 `hongje-sync`로 표 이름만 보낸다 → 열린 화면이 새로고침.
- 재무 파일을 못 불러와도 다른 탭은 그대로 동작한다.

## DB (`supabase/migrations/20261101070000_finance.sql`)
- `finance_tx`: 거래 한 줄씩. 토스 일 매출은 `toss-day-YYYY-MM-DD`, 일 취소는 `toss-refund-YYYY-MM-DD` id로 하루 1줄. (source, externalId) 중복 불가. 국민은행은 손익 제외 구분만.
- `finance_month`: 월별 고정비·로열티 비율·확인 여부·제외한 비품 주문. `ym='default'`는 새 달 초깃값.
- anon·authenticated 직접 접근 차단, service_role(서버)만 사용.
- 실제 고정비 금액은 저장소가 공개라서 이 파일에 넣지 않는다. 배포 때 화면의 월 비용 설정에서 넣는다.

## 서버 기능
`financeDaySave`(일 매출), `financeTxSave`(거래 추가·수정·삭제, 다른 기기 수정 충돌 시 거절), `financeImport`(토스 일별 합계 / 현대카드·국민은행 거래), `financeClassify`(분류 대기 일괄 분류), `financeMonthSave`(월 설정, 비품 제외는 한 건씩 토글).

## 계산
예상 운영이익 = 매출(취소 반영) − (운영비 − 비용 환급) − 포함한 비품 주문 − 월 고정비 − 급여·리워드 − 로열티
- 로열티 = 그 달 말일까지의 매출(취소 반영) × 비율. 말일 전에는 지금까지 매출 기준 예상. 로열티를 실제 운영비(분류 ‘로열티’)로 넣으면 예상 대신 그 금액.
- 비율을 넣지 않으면 0으로 계산하고 ‘로열티 비율 미설정’을 표시한다.
- 급여는 관리 탭 방식(근무일 × 1.5시간 × 시급 + 리워드, payTo 합산). 그만둔 매니저도 그 달 근무가 있으면 포함. 시급 이력은 없어서 현재 시급으로 계산.
- 부가세 포함 관리 금액. 세금·감가상각은 반영하지 않는다.

## 가져오기
- 토스: 일별 매출 합계 파일. 같은 날짜 여러 줄은 더하고, 마이너스는 취소로 본다. 다시 올리면 그날 값이 바뀐다.
- 현대카드: 분류 대기로 들어간다. 마이너스는 ‘마이너스(취소)’ 표시 후 분류 때 ‘비용 환급’으로 미리 골라 둔다. 승인번호가 같으면 건너뛰고, 승인번호가 없으면 장부에 있는 같은 날짜·내용·금액 ‘건수만큼’만 건너뛴다.
- 국민은행: 손익 제외(입출금)로 바로 들어간다.
- 날짜가 없는 줄(합계 등)은 건너뛰고 몇 줄인지 보여 준다. 현재 CSV만 지원 (엑셀 파일은 실제 파일 확인 후 추가 예정).

## 테스트
- `node --test tests/finance-core.test.cjs tests/finance-client.test.cjs`
- 서버(실제 Postgres 필요): 로컬 Postgres에 기존 표와 마이그레이션을 적용한 뒤 `PGSOCK=<소켓 폴더> REPO=<저장소> node --test tests/finance-server.test.cjs`. `tests/pgsb.cjs`가 서버 코드의 DB 호출을 psql로 실행한다 (service_role 권한).

## 배포 순서
1. 마이그레이션 적용 → 2. `api` Edge Function 배포 → 3. GitHub Pages에 화면 파일 반영 → 4. 화면에서 월 비용 설정·로열티 비율 입력.
1~2만 되고 3 전이면 기존 화면은 그대로 동작한다 (load 응답에 finance가 추가될 뿐).
