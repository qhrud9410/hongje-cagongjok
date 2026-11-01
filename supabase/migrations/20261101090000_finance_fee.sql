-- 카드 수수료율(추정) — 매출(취소 반영) × 비율. 실제 수수료를 '결제수수료'로 넣으면 화면에서 그 금액이 대신 쓰인다.
alter table public.finance_month add column if not exists "feeRate" numeric not null default 0 check ("feeRate" >= 0 and "feeRate" <= 100);
