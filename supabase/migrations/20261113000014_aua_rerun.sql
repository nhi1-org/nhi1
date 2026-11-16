-- NHI-1 AUA · 0014: the S4 schema release (George 11/13 總指令 一; task card docs/S4-task-card-digest-stub-replay.md).
-- LOCAL ONLY until George says go. Ships with the new aua hash (one schema release for NHI-1 this time).
--   A  replay_result is a record: signed by the wind key, points straight at the use (S4 Q3 (b): the wind
--      tunnel signs no replay requests and keeps no chain), exact seconds (Q2), how 0 stub / 1 cross-family,
--      code / err like a use, pass = code 0 (Q6). In the export (table 7) and the replica (Q1). The table is
--      empty on the live board (0 records), so it is reshaped here (4_ §3: build-time change).
--   rpf cross-family re-runs (OpenAI GPT, George 11/13): own day cap (rpf_cents_day, US cents), booked as cost
--      role 2, outside the Anthropic monthly cap (Q18 (a)); requests for uses with no runnable stub go here (Q21).
--   B  stub re-runs (no tokens): only effect 0, never a flagged tool, only a stub blob without $s / $h (Q5 (b), Q7, Q8 (a)).
--   view: rp = how 0, rpf = how 1, order = passes of both; a stub only when its latest wind re-run passed (Q11 (c)).
--   work: the work pointer record (4_ §13【定】, 9_ §0): ids and codes only, points only at a thing on the board.
--   daily report: new fields (Q19 (b)): stub_runs / stub_pass / rpf_runs / rpf_pass / rpf_cents_day / rpf_cents_cap / rpf_state / works.
--   knobs: replay_on = 0 (George turns it on; it gates stub re-runs AND cross-family re-runs 【暫，CODE 建議】).
-- License: Apache-2.0

insert into public.knob (name, val) values
  ('replay_on', 0), ('replay_batch', 50), ('replay_call_ms', 15000), ('replay_gap_days', 7),
  ('rpf_batch', 5), ('rpf_cents_day', 100),
  -- the price in force when OpenAI's page changes (US cents per million tokens, input / output); 0 = the dated
  -- table in rpf.ts (sol 4 / 20 to 2026-11-30, then 8 / 40). Setting both books every rpf call at that price.
  ('rpf_price_in', 0), ('rpf_price_out', 0)
on conflict (name) do nothing;

-- ───────────── A: replay_result becomes a record ─────────────
alter table public.replay_result alter column req_id drop not null;
alter table public.replay_result drop column pass;
alter table public.replay_result
  add column use_id text not null references public.use(id),
  add column how    smallint not null check (how in (0, 1)),
  add column code   smallint not null check (code between 0 and 3),
  add column err    smallint not null check (err between 0 and 10),
  add column model  text check (model is null or model ~ '^[0-9a-f]{64}$'),
  add column by_key text not null check (by_key ~ '^[0-9a-f]{64}$'),
  add column t      bigint not null,
  add column pass   boolean generated always as (code = 0) stored,
  add constraint replay_result_fam_how check ((how = 1) = (fam is not null) and (how = 1 or model is null));
create index replay_result_use_idx on public.replay_result (use_id, created_at desc);
create index replay_result_req_idx on public.replay_result (req_id) where req_id is not null;

create function public.aua_put_replay_result(p_id text, p_rec jsonb) returns boolean language plpgsql as $$
begin
  insert into public.replay_result (id, rec, use_id, req_id, how, code, err, fam, model, by_key, t)
  values (p_id, p_rec, p_rec->>'use', p_rec->>'req', (p_rec->>'how')::smallint,
          (p_rec->>'code')::smallint, (p_rec->>'err')::smallint, p_rec->>'fam', p_rec->>'model',
          p_rec #>> '{by,key}', (p_rec->>'t')::bigint)
  on conflict (id) do nothing;
  return found;
end $$;

-- a stub the wind tunnel can fill with no tokens: a blob with no $s / $h placeholder (keys cannot start with $)
create function public.aua_stub_runnable(p_rec jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(p_rec #> '{stub,in}') = 'object' and not ((p_rec #> '{stub,in}')::text ~ '"\$[sh][0-9]?"')
$$;
-- may the wind tunnel call this use's tool at all: read-only, no live canary flag, interface still the same
create function public.aua_rerun_ok(p_use text) returns boolean language sql stable as $$
  select exists (
    select 1 from public.use u
     where u.id = p_use and u.effect = 0
       and not exists (select 1 from public.wind_flag f where f.thing_id = u.thing_id and f.cleared_at is null)
       and coalesce((select w.result from public.wind_check w where w.thing_id = u.thing_id order by w.at desc, w.id desc limit 1), 0) = 0)
$$;

-- ───────────── rpf: money (from the first local 0014) ─────────────
-- the Anthropic monthly cap counts Anthropic calls only (role 0 writer · 1 judge · 3 digest); rpf (role 2) has its own day cap
create or replace function public.aua_cost_month() returns jsonb language sql stable as $$
  select jsonb_build_object('usd', coalesce(sum(usd) filter (where not (kind = 0 and role = 2)), 0), 'twd', coalesce(sum(twd), 0))
    from public.cost where at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
$$;
create function public.aua_rpf_spent(p_from timestamptz, p_to timestamptz) returns numeric language sql stable as $$
  select coalesce(sum(usd), 0) from public.cost where kind = 0 and role = 2 and at >= p_from and at < p_to
$$;
create function public.aua_rpf_ok() returns boolean language sql stable as $$
  select public.aua_rpf_spent(date_trunc('day', now() at time zone 'utc') at time zone 'utc', now() + interval '1 second')
         * 100 < public.aua_knob('rpf_cents_day')
$$;

-- how each cross-family pass went (root only, never exported): the daily report says when the model
-- could not be called, instead of a quiet 0 (George 11/13 一 1). state = enum report.rpf.
create table public.rpf_log (
  id    bigserial primary key,
  at    timestamptz not null default now(),
  state smallint not null check (state between 0 and 5),
  model text,            -- the model name asked for (root only)
  err   text,            -- the adapter's error code, no text from the provider
  ran   int not null default 0,
  pass  int not null default 0
);
alter table public.rpf_log enable row level security;
revoke all on public.rpf_log from public, anon, authenticated;
grant select, insert on public.rpf_log to service_role;
grant usage on sequence public.rpf_log_id_seq to service_role;
create function public.aua_rpf_log(p_state int, p_model text, p_err text, p_ran int, p_pass int) returns boolean language sql as $$
  insert into public.rpf_log (state, model, err, ran, pass) values (p_state, p_model, p_err, p_ran, p_pass) returning true
$$;

-- uses for cross-family re-runs with family p_fam: citizen requests first (only those the stub re-run cannot
-- answer: no stub, a hash-only stub, or $s / $h in it — Q21), then any read-only use not yet re-run by this family;
-- oldest first. stub = the use's stub blob when it has one (GPT keeps its fixed leaves).
create function public.aua_rpf_todo(p_fam text, p_lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('use', x.id, 'req', x.req, 'thing', x.thing_id, 'addr', x.addr, 'iface', x.iface,
                                               'op', x.op, 'stub', x.stub) order by x.pri, x.created_at, x.id), '[]')
    from (
      select * from (
        select distinct on (u.id) u.id, r.id as req, u.thing_id, th.addr, th.iface, u.op, u.created_at, 0 as pri,
               case when jsonb_typeof(u.rec #> '{stub,in}') = 'object' then u.rec #> '{stub,in}' end as stub
          from public.replay r join public.use u on u.id = r.use_id join public.thing th on th.id = u.thing_id
         where not exists (select 1 from public.replay_result rr where rr.req_id = r.id)
           and not public.aua_stub_runnable(u.rec) and public.aua_rerun_ok(u.id)
         order by u.id, r.created_at
      ) q
      union all
      select u.id, null, u.thing_id, th.addr, th.iface, u.op, u.created_at, 1,
             case when jsonb_typeof(u.rec #> '{stub,in}') = 'object' then u.rec #> '{stub,in}' end
        from public.use u join public.thing th on th.id = u.thing_id
       where public.aua_rerun_ok(u.id)
         and not exists (select 1 from public.replay_result rr where rr.use_id = u.id and rr.fam = p_fam)
         and not exists (select 1 from public.replay r where r.use_id = u.id and not public.aua_stub_runnable(u.rec)
                          and not exists (select 1 from public.replay_result rr where rr.req_id = r.id))
      order by pri, created_at, id
      limit greatest(p_lim, 0)
    ) x
$$;

-- ───────────── B: stub re-runs ─────────────
-- citizen requests first (2_ §8), then digest stubs not re-run for replay_gap_days, least recently re-run first
create function public.aua_replay_todo(p_lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('use', x.id, 'req', x.req, 'thing', x.thing_id, 'addr', x.addr, 'iface', x.iface,
                                               'op', x.op, 'stub', x.rec #> '{stub,in}') order by x.pri, x.last nulls first, x.created_at, x.id), '[]')
    from (
      select * from (
        select distinct on (u.id) u.id, r.id as req, u.thing_id, th.addr, th.iface, u.op, u.rec, u.created_at, 0 as pri, null::timestamptz as last
          from public.replay r join public.use u on u.id = r.use_id join public.thing th on th.id = u.thing_id
         where not exists (select 1 from public.replay_result rr where rr.req_id = r.id)
           and public.aua_stub_runnable(u.rec) and public.aua_rerun_ok(u.id)
         order by u.id, r.created_at
      ) q
      union all
      select u.id, null, u.thing_id, th.addr, th.iface, u.op, u.rec, u.created_at, 1,
             (select max(rr.created_at) from public.replay_result rr where rr.use_id = u.id and rr.how = 0)
        from public.use u join public.thing th on th.id = u.thing_id
       where u.is_digest and u.code = 0 and public.aua_stub_runnable(u.rec) and public.aua_rerun_ok(u.id)
         and not exists (select 1 from public.replay_result rr where rr.use_id = u.id and rr.how = 0
                          and rr.created_at > now() - make_interval(days => public.aua_knob('replay_gap_days')::int))
         and not exists (select 1 from public.replay r where r.use_id = u.id
                          and not exists (select 1 from public.replay_result rr where rr.req_id = r.id))
      order by pri, last nulls first, created_at, id
      limit greatest(p_lim, 0)
    ) x
$$;

-- ───────────── the view and the talk ordering read the new rows ─────────────
drop function public.aua_put_replay(text, jsonb, bigint);
create function public.aua_put_replay(p_id text, p_rec jsonb, p_at bigint) returns jsonb
language plpgsql as $$
declare u public.use%rowtype; rp jsonb; c jsonb;
begin
  select * into u from public.use where id = p_rec->>'use';
  if not found then return jsonb_build_object('err', 12); end if;
  if not exists (select 1 from public.replay where id = p_id) then
    c := public.aua_chain_take(p_rec #>> '{by,key}', p_rec->>'prev', p_id);
    if c is not null then return c; end if;
    insert into public.replay (id, rec, use_id, by_key, t, at_t)
    values (p_id, p_rec, u.id, p_rec #>> '{by,key}', (p_rec->>'t')::bigint, p_at);
  end if;
  select jsonb_build_object('tried', count(rr.*), 'pass', count(*) filter (where rr.pass)) into rp
    from public.replay_result rr join public.use u2 on u2.id = rr.use_id
   where rr.how = 0 and u2.task = u.task and u2.thing_id = u.thing_id and u2.op = u.op and u2.cin = u.cin and u2.cout = u.cout;
  return jsonb_build_object('id', p_id, 'rp', rp);
end $$;

-- talk ordering (George 11/12): passes of the key's uses in cross-family re-runs (how 1) only
create or replace function public.aua_talk_w(p_key text) returns bigint language sql stable as $$
  select case when exists (select 1 from public.talk t join public.talk_canary c on c.talk_id = t.id
                            where t.key = p_key and c.state = 2) then 0
         else (select count(*) from public.replay_result rr join public.use u on u.id = rr.use_id
                where u.key = p_key and rr.pass and rr.how = 1) end
$$;

-- the latest wind re-run of a use passed (Q11 (c)): the only stubs the view gives
create function public.aua_stub_verified(p_use text) returns boolean language sql stable as $$
  select coalesce((select rr.pass from public.replay_result rr where rr.use_id = p_use order by rr.created_at desc, rr.id desc limit 1), false)
$$;

create or replace function public.aua_ask(p_task text, p_effect int, p_money numeric, p_tout bigint, p_k int, p_lease text, p_key text)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  insert into public.lease (id, task, key, expires_at)
  values (p_lease, p_task, p_key, now() + make_interval(secs => public.aua_knob('lease_ttl_sec')));

  with g as (
    select u.thing_id, u.op, u.cin, u.cout,
           count(*) filter (where code = 0) as ok,
           count(*) filter (where code = 1) as part,
           count(*) filter (where code = 2) as fail,
           count(*) filter (where code = 3) as abort,
           count(distinct model) filter (where code = 0) as models,
           count(distinct rt)    filter (where code = 0) as rts,
           count(distinct key)   filter (where code = 0) as keys,
           percentile_disc(0.5) within group (order by tin)   as tin,
           percentile_disc(0.5) within group (order by tout)  as tout,
           percentile_disc(0.5) within group (order by ms)    as ms,
           percentile_disc(0.5) within group (order by money) as money,
           max(t) as last, max(effect) as maxeff
      from public.use u
     where u.task = p_task
     group by 1, 2, 3, 4
  ), runs as (
    select u2.thing_id, u2.op, u2.cin, u2.cout, rr.how, rr.pass, rr.fam
      from public.replay_result rr join public.use u2 on u2.id = rr.use_id
     where u2.task = p_task
  ), rp as (
    select g.thing_id, g.op, g.cin, g.cout,
           count(r.how) filter (where r.how = 0) as tried,
           count(r.how) filter (where r.how = 0 and r.pass) as spass,
           count(r.how) filter (where r.pass) as verified,
           count(distinct r.fam) filter (where r.how = 1) as fams,
           count(r.how) filter (where r.how = 1 and r.pass) as fpass
      from g left join runs r using (thing_id, op, cin, cout)
     group by 1, 2, 3, 4
  ), pick as (
    select g.*, rp.tried, rp.spass, rp.verified, rp.fams, rp.fpass, th.addr, th.iface,
           coalesce((select min(f.rule) from public.wind_flag f where f.thing_id = g.thing_id and f.cleared_at is null), 0) as flag
      from g join rp using (thing_id, op, cin, cout) join public.thing th on th.id = g.thing_id
     where g.maxeff <= p_effect and g.money <= p_money and g.tout <= p_tout
     order by (coalesce((select min(f.rule) from public.wind_flag f where f.thing_id = g.thing_id and f.cleared_at is null), 0) > 0),
              (rp.verified > 0) desc, rp.verified desc, g.last desc
     limit p_k
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'thing', jsonb_build_object('addr', p.addr, 'iface', p.iface),
           'call',  jsonb_build_object('op', p.op, 'in', p.cin, 'out', p.cout),
           'n',     case when p.flag > 0 then jsonb_build_object('ok', 0, 'part', 0, 'fail', 0, 'abort', 0)
                         else jsonb_build_object('ok', p.ok, 'part', p.part, 'fail', p.fail, 'abort', p.abort) end,
           'ind',   case when p.flag > 0 then jsonb_build_object('models', 0, 'rts', 0, 'keys', 0)
                         else jsonb_build_object('models', p.models, 'rts', p.rts, 'keys', p.keys) end,
           'cost',  jsonb_build_object('tin', p.tin, 'tout', p.tout, 'ms', p.ms, 'money', p.money),
           'rp',    jsonb_build_object('tried', p.tried, 'pass', p.spass),
           'rpf',   jsonb_build_object('fams', p.fams, 'pass', p.fpass),
           'flag',  p.flag,
           'last',  p.last,
           'stub',  case when p.maxeff >= 2 or p.flag > 0 then 'null'::jsonb else coalesce(
                      (select u3.rec->'stub' from public.use u3
                        where u3.task = p_task and u3.thing_id = p.thing_id and u3.op = p.op
                          and u3.cin = p.cin and u3.cout = p.cout
                          and u3.is_digest and u3.code = 0 and u3.effect < 2 and u3.has_stub
                          and public.aua_stub_verified(u3.id)
                        order by u3.t desc, u3.created_at desc limit 1), 'null'::jsonb) end,
           'lease', p_lease
         ) order by (p.flag > 0), (p.verified > 0) desc, p.verified desc, p.last desc), '[]'::jsonb)
    into v
    from pick p;

  return jsonb_build_object('view', v, 'lease', p_lease);
end $$;

-- ───────────── work pointer (作品指標) ─────────────
create table public.work (
  id       text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec      jsonb not null,
  thing_id text not null references public.thing(id),
  kind     smallint not null check (kind between 0 and 2),
  key      text not null check (key ~ '^[0-9a-f]{64}$'),
  t        bigint not null,
  at_t     bigint,
  created_at timestamptz not null default now()
);
create index work_thing_idx on public.work (thing_id);
create trigger work_no_change before update or delete on public.work for each row execute function public.aua_append_only();
create trigger work_no_truncate before truncate on public.work for each statement execute function public.aua_append_only();
alter table public.work enable row level security;
revoke all on public.work from public, anon, authenticated, service_role;
grant select, insert on public.work to service_role;

-- a work pointer: the thing must already be on the board (err 12); rides the key's chain like a use
create function public.aua_put_work(p_id text, p_rec jsonb, p_thing_id text, p_at bigint) returns jsonb language plpgsql as $$
declare c jsonb;
begin
  if exists (select 1 from public.work where id = p_id) then return jsonb_build_object('dup', true); end if;
  if not exists (select 1 from public.thing where id = p_thing_id) then return jsonb_build_object('err', 12); end if;
  c := public.aua_chain_take(p_rec #>> '{by,key}', p_rec->>'prev', p_id);
  if c is not null then return c; end if;
  insert into public.work (id, rec, thing_id, kind, key, t, at_t)
  values (p_id, p_rec, p_thing_id, (p_rec->>'kind')::smallint, p_rec #>> '{by,key}', (p_rec->>'t')::bigint, p_at);
  return jsonb_build_object('dup', false);
end $$;

-- ───────────── export: 7 = replay_result, 8 = work ─────────────
create or replace function public.aua_export_page(p_table int, p_after text, p_lim int) returns jsonb
language plpgsql stable as $$
declare rows jsonb;
begin
  if p_table = 0 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', jsonb_build_object('addr', addr, 'iface', iface)) x
        from public.thing where id > p_after order by id limit p_lim) s;
  elsif p_table = 1 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.use where id > p_after order by id limit p_lim) s;
  elsif p_table = 2 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.talk where id > p_after order by id limit p_lim) s;
  elsif p_table = 3 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.key where id > p_after order by id limit p_lim) s;
  elsif p_table = 4 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.replay where id > p_after order by id limit p_lim) s;
  elsif p_table = 5 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.report where id > p_after order by id limit p_lim) s;
  elsif p_table = 6 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.talk_flag where id > p_after order by id limit p_lim) s;
  elsif p_table = 7 then
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.replay_result where id > p_after order by id limit p_lim) s;
  else
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.work where id > p_after order by id limit p_lim) s;
  end if;
  return rows;
end $$;

-- ───────────── daily report numbers ─────────────
-- usd_day / tok_*_day stay Anthropic only (the US$100 month); the OpenAI money is its own line
alter function public.aua_report_numbers(timestamptz, timestamptz) rename to aua_report_numbers_0012;
create function public.aua_report_numbers(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  select b || jsonb_build_object(
    'records',     (b->>'records')::bigint + (select count(*) from public.work where created_at >= p_from and created_at < p_to),
    'usd_day',     (select coalesce(sum(usd), 0) from public.cost where not (kind = 0 and role = 2) and at >= p_from and at < p_to),
    'tok_in_day',  (select coalesce(sum(tin), 0) from public.cost where kind = 0 and role <> 2 and at >= p_from and at < p_to),
    'tok_out_day', (select coalesce(sum(tout), 0) from public.cost where kind = 0 and role <> 2 and at >= p_from and at < p_to),
    'stub_runs',  (select count(*) from public.replay_result where how = 0 and created_at >= p_from and created_at < p_to),
    'stub_pass',  (select count(*) from public.replay_result where how = 0 and pass and created_at >= p_from and created_at < p_to),
    'rpf_runs',   (select count(*) from public.replay_result where how = 1 and created_at >= p_from and created_at < p_to),
    'rpf_pass',   (select count(*) from public.replay_result where how = 1 and pass and created_at >= p_from and created_at < p_to),
    'rpf_usd_day', public.aua_rpf_spent(p_from, p_to),
    'rpf_usd_cap', public.aua_knob('rpf_cents_day') / 100.0,
    -- the worst state of the day's passes (4 model_unavailable > 3 day_cap > 1 no_key > 2 switched_off > 0 ran); none = 5
    'rpf_state',  coalesce((select state from public.rpf_log where at >= p_from and at < p_to
                             order by case state when 4 then 0 when 3 then 1 when 1 then 2 when 2 then 3 else 4 end, at desc limit 1), 5),
    'rpf_model',  (select model from public.rpf_log where at >= p_from and at < p_to order by at desc limit 1),
    'works',      (select count(*) from public.work where created_at >= p_from and created_at < p_to))
  from (select public.aua_report_numbers_0012(p_from, p_to) as b) x
$$;

revoke execute on function public.aua_put_replay_result(text, jsonb), public.aua_stub_runnable(jsonb), public.aua_rerun_ok(text),
  public.aua_rpf_spent(timestamptz, timestamptz), public.aua_rpf_ok(), public.aua_rpf_log(int, text, text, int, int), public.aua_rpf_todo(text, int),
  public.aua_replay_todo(int), public.aua_put_replay(text, jsonb, bigint), public.aua_stub_verified(text),
  public.aua_put_work(text, jsonb, text, bigint), public.aua_export_page(int, text, int),
  public.aua_report_numbers(timestamptz, timestamptz), public.aua_report_numbers_0012(timestamptz, timestamptz), public.aua_cost_month()
  from public, anon, authenticated;
grant execute on function public.aua_put_replay_result(text, jsonb), public.aua_stub_runnable(jsonb), public.aua_rerun_ok(text),
  public.aua_rpf_spent(timestamptz, timestamptz), public.aua_rpf_ok(), public.aua_rpf_log(int, text, text, int, int), public.aua_rpf_todo(text, int),
  public.aua_replay_todo(int), public.aua_put_replay(text, jsonb, bigint), public.aua_stub_verified(text),
  public.aua_put_work(text, jsonb, text, bigint), public.aua_export_page(int, text, int),
  public.aua_report_numbers(timestamptz, timestamptz), public.aua_report_numbers_0012(timestamptz, timestamptz), public.aua_cost_month()
  to service_role;
