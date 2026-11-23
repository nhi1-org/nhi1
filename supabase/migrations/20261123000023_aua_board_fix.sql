-- NHI-1 · 0023 board fix after the 11/23 audit (Opus card docs/BOARD-FIX-1123-task-card.md).
-- Internal tables and functions only: no record table changes, nothing is deleted, the schema (aua hash) stays.
--   1 door         requests per UTC day × function × method × status × inside/outside (× mem op): a count, nothing
--                  that tells who came (no IP, no UA, no key). Every edge function counts itself, failures included.
--   2 report       aua_report_numbers gains the door line, all reads, new keys from every place a key is written down.
--   3 thing_state  append-only state rows for an interface: 1 judged gone (unreachable gone_days days running),
--                  0 answers again. Yellow only on the day an interface first stops answering.
--   4 report_log   run rows: kind 2 started · 3 finished · 4 failed (+ a short error); a retry at 00:40 (0024).
--   5 knob warning when replay_on is set to 1 while the rpf price knobs are 0.
-- License: Apache-2.0

-- ───────────── 1 door ─────────────
create table public.door (
  day    date not null,
  fn     text not null check (fn in ('ask', 'head', 'wall', 'replica', 'mem', 'use', 'talk', 'replay', 'work', 'key', 'key-view', 'export', 'wind', 'report')),
  method text not null check (method in ('GET', 'POST', 'OPTIONS', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OTHER')),
  status smallint not null check (status between 100 and 599),
  inside boolean not null,                -- true: an internal job that proved the vault secret (cron)
  op     text not null default '' check (op in ('', 'put', 'del', 'reg', 'head', 'boot', 'all', 'check', 'box_get', 'box_put', '?')),
  n      bigint not null default 0,
  primary key (day, fn, method, status, inside, op)
);
alter table public.door enable row level security;
revoke all on public.door from public, anon, authenticated;
grant select, insert, update on public.door to service_role;

create function public.aua_door(p_fn text, p_method text, p_status int, p_inside boolean, p_op text) returns void language sql as $$
  insert into public.door as d (day, fn, method, status, inside, op, n)
  values ((now() at time zone 'utc')::date, p_fn, p_method, p_status, p_inside, coalesce(p_op, ''), 1)
  on conflict (day, fn, method, status, inside, op) do update set n = d.n + 1
$$;

-- reads = ask, head, wall, replica, and mem requests that are not writes (failures and unknown ops included)
create function public.aua_door_numbers(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  with d as (
    select * from public.door
     where day >= (p_from at time zone 'utc')::date and day < (p_to at time zone 'utc')::date
  )
  select jsonb_build_object(
    'reads',    (select coalesce(sum(n), 0) from d where not inside
                   and (fn in ('ask', 'head', 'wall', 'replica') or (fn = 'mem' and op not in ('put', 'del', 'reg', 'box_put')))),
    'door_out', (select coalesce(sum(n), 0) from d where not inside),
    'door_in',  (select coalesce(sum(n), 0) from d where inside),
    'door',     coalesce((select jsonb_object_agg(fn, jsonb_build_object('ok', ok, 'fail', fail) order by fn) from (
                  select fn, coalesce(sum(n) filter (where status < 400), 0) ok, coalesce(sum(n) filter (where status >= 400), 0) fail
                    from d where not inside group by fn) x), '{}'::jsonb))
$$;

-- ───────────── 2 new keys: the first time a key is written down anywhere ─────────────
-- use, talk, replay, work, and (when NHI-2 is there) mem, mem_room, mem_box. Holder and wind keys sign other tables.
create function public.aua_new_keys(p_from timestamptz, p_to timestamptz) returns jsonb language plpgsql stable as $$
declare
  q text := 'select key k, created_at a from public.use union all select key, created_at from public.talk'
         || ' union all select by_key, created_at from public.replay union all select key, created_at from public.work';
  keys text[];
  models bigint;
begin
  if to_regclass('public.mem') is not null then q := q || ' union all select key, at from public.mem'; end if;
  if to_regclass('public.mem_room') is not null then q := q || ' union all select pub, to_timestamp(day) from public.mem_room'; end if;
  if to_regclass('public.mem_box') is not null then q := q || ' union all select pub, at from public.mem_box'; end if;
  execute format('select coalesce(array_agg(k), ''{}'') from (select k, min(a) f from (%s) s group by k) x where f >= $1 and f < $2', q)
    into keys using p_from, p_to;
  select count(distinct model) into models from public.use where key = any (keys);
  return jsonb_build_object('new_keys', coalesce(array_length(keys, 1), 0), 'new_models', models);
end $$;

-- ───────────── 3 interface state ─────────────
create table public.thing_state (
  id       bigserial primary key,
  thing_id text not null references public.thing(id),
  state    smallint not null check (state in (0, 1)),   -- 1 judged gone · 0 answers again
  days     int not null default 0,                      -- state 1: the unreachable streak in days when judged
  at       timestamptz not null default now()
);
create index thing_state_idx on public.thing_state (thing_id, at);
create trigger thing_state_no_change before update or delete on public.thing_state for each row execute function public.aua_append_only();
create trigger thing_state_no_truncate before truncate on public.thing_state for each statement execute function public.aua_append_only();
alter table public.thing_state enable row level security;
revoke all on public.thing_state from public, anon, authenticated;
grant select, insert on public.thing_state to service_role;
grant usage, select on sequence public.thing_state_id_seq to service_role;
insert into public.knob (name, val) values ('gone_days', 7);

-- is the thing judged gone as of p_at (its latest state row before p_at says 1)?
create function public.aua_thing_gone(p_thing text, p_at timestamptz) returns boolean language sql stable as $$
  select coalesce((select state = 1 from public.thing_state where thing_id = p_thing and at < p_at order by at desc, id desc limit 1), false)
$$;

-- the running unreachable streak as of p_at, in UTC calendar days from its first check to its last; 0 = the last check answered
create function public.aua_unreach_days(p_thing text, p_at timestamptz) returns int language sql stable as $$
  with c as (select id, at, result from public.wind_check where thing_id = p_thing and at < p_at),
       last as (select result from c order by at desc, id desc limit 1),
       ok as (select max(at) a from c where result <> 3)
  select case when (select result from last) is distinct from 3 then 0
    else ((select max(at) from c) at time zone 'utc')::date
       - ((select min(at) from c where result = 3 and at > coalesce((select a from ok), '-infinity'::timestamptz)) at time zone 'utc')::date + 1
  end
$$;

-- after each wind run: a state row for every thing whose state changes. Returns the number newly judged gone.
create function public.aua_wind_gone() returns int language plpgsql as $$
declare
  r record;
  d int;
  n int := 0;
  lim int := coalesce(public.aua_knob('gone_days'), 7);
begin
  for r in select id from public.thing order by id loop
    if public.aua_thing_gone(r.id, 'infinity') then
      if (select result from public.wind_check where thing_id = r.id order by at desc, id desc limit 1) is distinct from 3 then
        insert into public.thing_state (thing_id, state, days) values (r.id, 0, 0);
      end if;
    else
      d := public.aua_unreach_days(r.id, 'infinity');
      if d >= lim then
        insert into public.thing_state (thing_id, state, days) values (r.id, 1, d);
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $$;

-- the day's checks of things not judged gone (as of p_to); "new" = this check is unreachable and the one before was not
create function public.aua_reach_numbers(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  with c as (
    select w.thing_id, w.at, w.result, lag(w.result) over (partition by w.thing_id order by w.at, w.id) prev
      from public.wind_check w where w.at < p_to
  ), win as (
    select * from c where at >= p_from and not public.aua_thing_gone(thing_id, p_to)
  )
  select jsonb_build_object(
    'checked',          (select count(*) from win),
    'passed',           (select count(*) from win where result = 0),
    'changed',          (select count(*) from win where result in (1, 2)),
    'unreachable',      (select count(*) from win where result = 3),
    'unreachable_new',  (select count(*) from win where result = 3 and prev is distinct from 3),
    'unreachable_cont', (select count(distinct thing_id) from win where result = 3 and prev = 3),
    'unreachable_days', coalesce((select max(public.aua_unreach_days(thing_id, p_to)) from win where result = 3 and prev = 3), 0),
    'gone_new',         (select count(*) from public.thing_state where state = 1 and at >= p_from and at < p_to),
    'back_new',         (select count(*) from public.thing_state where state = 0 and at >= p_from and at < p_to),
    'gone_days',        coalesce(public.aua_knob('gone_days'), 7))
$$;

-- ───────────── 4 report runs ─────────────
alter table public.report_log drop constraint report_log_kind_check;
alter table public.report_log add constraint report_log_kind_check check (kind between 0 and 4); -- 2 started · 3 finished · 4 failed
alter table public.report_log add column err text check (err is null or length(err) <= 200);

-- p_state: 0 started · 1 finished · 2 failed (p_err: a short summary, no key, no address)
create function public.aua_report_run(p_day date, p_state int, p_err text) returns void language sql as $$
  insert into public.report_log (id, kind, day, light, nums, err)
  values (encode(sha256(convert_to(p_day::text || ':' || p_state::text || ':' || clock_timestamp()::text || ':' || random()::text, 'UTF8')), 'hex'),
          2 + p_state, p_day, 0, '{}'::jsonb, left(p_err, 200))
$$;
create function public.aua_report_done(p_day date) returns boolean language sql stable as $$
  select exists (select 1 from public.report_log where kind = 3 and day = p_day)
$$;
-- the day before p_day has a finished report; before run rows existed (≤ 2026-11-23) a daily row is enough.
-- The very first report has no day before it: that is not "missing".
create function public.aua_report_prev_ok(p_day date) returns boolean language sql stable as $$
  select exists (select 1 from public.report_log where kind = 3 and day = p_day - 1)
      or (not exists (select 1 from public.report_log where kind in (2, 3, 4) and day = p_day - 1)
          and exists (select 1 from public.report_log where kind = 0 and day = p_day - 1))
      or not exists (select 1 from public.report_log where kind in (0, 2, 3, 4) and day < p_day)
$$;

-- ───────────── the daily numbers ─────────────
alter function public.aua_report_numbers(timestamptz, timestamptz) rename to aua_report_numbers_0014;
create function public.aua_report_numbers(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  select b || public.aua_new_keys(p_from, p_to) || public.aua_reach_numbers(p_from, p_to) || public.aua_door_numbers(p_from, p_to)
           || jsonb_build_object(
                'replay_on',     coalesce(public.aua_knob('replay_on'), 0),
                'rpf_price_set', case when coalesce(public.aua_knob('rpf_price_in'), 0) > 0 and coalesce(public.aua_knob('rpf_price_out'), 0) > 0 then 1 else 0 end)
  from (select public.aua_report_numbers_0014(p_from, p_to) as b) x
$$;

-- ───────────── 5 replay_on with no price ─────────────
create function public.aua_knob_warn() returns trigger language plpgsql as $$
begin
  if new.name = 'replay_on' and new.val = 1
     and (coalesce((select val from public.knob where name = 'rpf_price_in'), 0) <= 0
          or coalesce((select val from public.knob where name = 'rpf_price_out'), 0) <= 0) then
    raise warning 'aua: replay_on = 1 while rpf_price_in / rpf_price_out are 0: cross-family re-run costs are only estimated from the built-in table and the daily report turns yellow until both prices are set';
  end if;
  return new;
end $$;
create trigger knob_warn after insert or update on public.knob for each row execute function public.aua_knob_warn();

revoke execute on function public.aua_door(text, text, int, boolean, text), public.aua_door_numbers(timestamptz, timestamptz),
  public.aua_new_keys(timestamptz, timestamptz), public.aua_thing_gone(text, timestamptz), public.aua_unreach_days(text, timestamptz),
  public.aua_wind_gone(), public.aua_reach_numbers(timestamptz, timestamptz), public.aua_report_run(date, int, text),
  public.aua_report_done(date), public.aua_report_prev_ok(date), public.aua_report_numbers(timestamptz, timestamptz),
  public.aua_report_numbers_0014(timestamptz, timestamptz), public.aua_knob_warn()
  from public, anon, authenticated;
grant execute on function public.aua_door(text, text, int, boolean, text), public.aua_door_numbers(timestamptz, timestamptz),
  public.aua_new_keys(timestamptz, timestamptz), public.aua_thing_gone(text, timestamptz), public.aua_unreach_days(text, timestamptz),
  public.aua_wind_gone(), public.aua_reach_numbers(timestamptz, timestamptz), public.aua_report_run(date, int, text),
  public.aua_report_done(date), public.aua_report_prev_ok(date), public.aua_report_numbers(timestamptz, timestamptz),
  public.aua_report_numbers_0014(timestamptz, timestamptz)
  to service_role;

-- the rule applies to what is already there (cc24ef97: unreachable 11/16 – 11/22)
select public.aua_wind_gone();
