-- AMM's crew roster quotes two day rates per freelancer — one for events in
-- their own city and a higher one for outstation work — and records whether
-- the freelancer agreement has been signed. Both are additive and nullable /
-- defaulted, so existing rows are untouched.
ALTER TABLE "freelancers" ADD COLUMN "day_rate_outstation" DECIMAL(10,2);
ALTER TABLE "freelancers" ADD COLUMN "agreement_signed" BOOLEAN NOT NULL DEFAULT false;
