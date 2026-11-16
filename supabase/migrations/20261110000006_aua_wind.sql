-- NHI-1 root board · S2 self-moving, the parts that cost no tokens and change no schema
--   * internal tables (NOT records: never signed, never exported, no aua hash change):
--       wind_check  interface replay results (4_ §3 驗證 agent, task card 1.1a)
--       wind_flag   canary hits on tool descriptions (1.2a): stub not given, records kept
--       ask_stat    per-day ask count and answer bytes (daily report item 3)
--       cost        spend ledger in TWD (daily report item 8, monthly cap)
--       report_log  daily and emergency reports sent (until the report record type ships)
--   * view ordering per 4_ §13【定】: wind-verified first; key count, family count and
--     first-pass ratio do not order anything
-- License: Apache-2.0

create table public.wind_check (
  id         bigserial primary key,
  thing_id   text not null references public.thing(id),
  result     smallint not null check (result between 0 and 3), -- 0 same · 1 changed · 2 gone · 3 unreachable
  tools      int not null default 0,
  at         timestamptz not null default now()
);
create index wind_check_thing_idx on public.wind_check (thing_id, at);

create table public.wind_flag (
  id         bigserial primary key,
  thing_id   text not null references public.thing(id),
  rule       smallint not null,            -- canary rule code (see _shared/aua/canary.ts)
  how        smallint not null default 0,  -- 0 rule certain · 1 model judged it an instruction · 2 suspect, no judgement (kept, to be safe)
  at         timestamptz not null default now(),
  unique (thing_id, rule)
);

create table public.ask_stat (
  day   date primary key,
  n     bigint not null default 0,
  bytes bigint not null default 0
);

create table public.cost (
  id      bigserial primary key,
  kind    smallint not null,               -- 0 model · 1 mail · 2 other
  role    smallint not null default 0,     -- model calls: 0 writer (cheap) · 1 judge (strong)
  tin     bigint not null default 0,       -- tokens in
  tout    bigint not null default 0,       -- tokens out (incl. thinking)
  usd     numeric not null default 0 check (usd >= 0),  -- model calls (Anthropic credit; cap model_cap_usd)
  twd     numeric not null default 0 check (twd >= 0),  -- cash costs: mail, hosting (cap cost_cap_twd)
  at      timestamptz not null default now()
);

create table public.report_log (
  id       text primary key check (id ~ '^[0-9a-f]{64}$'),  -- sha256(canon(report))
  kind     smallint not null check (kind in (0, 1)),         -- 0 daily · 1 emergency
  day      date not null,
  light    smallint not null check (light between 0 and 2),  -- 0 green · 1 yellow · 2 red
  nums     jsonb not null,
  judged   boolean not null default false,                   -- emergency: true = a model gave the harm judgement
  held     boolean not null default false,                   -- emergency the model judged unlikely to harm: not mailed, counted
  sent     boolean not null default false,
  send_err smallint not null default 0,                      -- 0 ok · 1 not configured · 2 provider refused · 3 network
  created_at timestamptz not null default now()
);

insert into public.knob (name, val) values
  ('cost_cap_twd', 2000),   -- monthly cash cap (mail, hosting), NT$ (George 11/10)
  ('model_cap_usd', 100),   -- monthly model cap, US$ (George 11/10; also set as the workspace spend limit)
  ('wind_batch',   200)     -- things checked per wind run
on conflict (name) do nothing;

do $$ declare t text; begin
  foreach t in array array['wind_check','wind_flag','ask_stat','cost','report_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.wind_check_id_seq, public.wind_flag_id_seq, public.cost_id_seq to service_role;

-- ── ask: count answers (daily report item 3) ──
create function public.aua_note_ask(p_bytes int) returns void language sql as $$
  insert into public.ask_stat as s (day, n, bytes) values ((now() at time zone 'utc')::date, 1, p_bytes)
  on conflict (day) do update set n = s.n + 1, bytes = s.bytes + excluded.bytes
$$;

-- ── wind: what to check, and the results ──
create function public.aua_wind_things(p_lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x), '[]') from (
    select jsonb_build_object('id', th.id, 'addr', th.addr, 'iface', th.iface,
             'ops', (select coalesce(jsonb_agg(distinct u.op), '[]') from public.use u where u.thing_id = th.id),
             'recs', (select coalesce(jsonb_agg(r.id), '[]') from (select id from public.use u where u.thing_id = th.id order by created_at desc limit 5) r)) x
      from public.thing th
      left join lateral (select max(at) last from public.wind_check w where w.thing_id = th.id) l on true
     order by l.last nulls first, th.id
     limit p_lim) s
$$;

-- one check result + any canary rule codes; returns the rule codes that are NEW for this thing
create function public.aua_wind_put(p_thing text, p_result int, p_tools int, p_rules jsonb, p_how int) returns int[]
language plpgsql as $$
declare fresh int[] := '{}'; r int;
begin
  insert into public.wind_check (thing_id, result, tools) values (p_thing, p_result, p_tools);
  for r in select (x)::int from jsonb_array_elements_text(coalesce(p_rules, '[]'::jsonb)) x loop
    insert into public.wind_flag (thing_id, rule, how) values (p_thing, r, p_how) on conflict do nothing;
    if found then fresh := fresh || r; end if;
  end loop;
  return fresh;
end $$;

create function public.aua_cost_add(p_kind int, p_role int, p_tin bigint, p_tout bigint, p_usd numeric, p_twd numeric) returns void
language sql as $$
  insert into public.cost (kind, role, tin, tout, usd, twd) values (p_kind, p_role, p_tin, p_tout, p_usd, p_twd)
$$;

-- ── cost ledger ──
create function public.aua_cost_month() returns jsonb language sql stable as $$
  select jsonb_build_object('usd', coalesce(sum(usd), 0), 'twd', coalesce(sum(twd), 0))
    from public.cost where at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
$$;
-- model parts run only under the model cap; cash parts only under the cash cap
create function public.aua_model_ok() returns boolean language sql stable as $$
  select (public.aua_cost_month()->>'usd')::numeric < public.aua_knob('model_cap_usd')
$$;
create function public.aua_cash_ok() returns boolean language sql stable as $$
  select (public.aua_cost_month()->>'twd')::numeric < public.aua_knob('cost_cap_twd')
$$;

-- ── daily report numbers for [p_from, p_to) — counts only, never a record, a key or a text ──
create function public.aua_report_numbers(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable as $$
  with first_seen as (
    select key, min(created_at) f from (
      select key, created_at from public.use
      union all select key, created_at from public.talk
      union all select by_key, created_at from public.replay) s group by key
  ), new_keys as (select key from first_seen where f >= p_from and f < p_to)
  select jsonb_build_object(
    'records',   (select count(*) from public.use where created_at >= p_from and created_at < p_to)
               + (select count(*) from public.talk where created_at >= p_from and created_at < p_to)
               + (select count(*) from public.replay where created_at >= p_from and created_at < p_to),
    'asks',      (select coalesce(sum(n), 0) from public.ask_stat where day >= (p_from at time zone 'utc')::date and day < (p_to at time zone 'utc')::date),
    'ask_bytes', (select coalesce(sum(bytes), 0) from public.ask_stat where day >= (p_from at time zone 'utc')::date and day < (p_to at time zone 'utc')::date),
    'checked',   (select count(*) from public.wind_check where at >= p_from and at < p_to),
    'passed',    (select count(*) from public.wind_check where at >= p_from and at < p_to and result = 0),
    'changed',   (select count(*) from public.wind_check where at >= p_from and at < p_to and result in (1, 2)),
    'unreachable', (select count(*) from public.wind_check where at >= p_from and at < p_to and result = 3),
    'new_keys',  (select count(*) from new_keys),
    'new_models', (select count(distinct model) from public.use where key in (select key from new_keys)),
    'talks',     (select count(*) from public.talk where created_at >= p_from and created_at < p_to),
    'digests',   (select count(*) from public.use where created_at >= p_from and created_at < p_to and is_digest),
    'canary',    (select count(*) from public.wind_flag where at >= p_from and at < p_to),
    'zeroed',    0,
    'canary_judged', (select count(*) from public.wind_flag where how = 1 and at >= p_from and at < p_to),
    'canary_unjudged', (select count(*) from public.wind_flag where how = 2 and at >= p_from and at < p_to),
    'emergencies', (select count(*) from public.report_log where kind = 1 and not held and created_at >= p_from and created_at < p_to),
    'unjudged',  (select count(*) from public.report_log where kind = 1 and not held and not judged and created_at >= p_from and created_at < p_to),
    'held',      (select count(*) from public.report_log where kind = 1 and held and created_at >= p_from and created_at < p_to),
    'usd_day',   (select coalesce(sum(usd), 0) from public.cost where at >= p_from and at < p_to),
    'usd_month', (public.aua_cost_month()->>'usd')::numeric,
    'usd_cap',   public.aua_knob('model_cap_usd'),
    'twd_day',   (select coalesce(sum(twd), 0) from public.cost where at >= p_from and at < p_to),
    'twd_month', (public.aua_cost_month()->>'twd')::numeric,
    'twd_cap',   public.aua_knob('cost_cap_twd'),
    'tok_in_day',  (select coalesce(sum(tin), 0) from public.cost where kind = 0 and at >= p_from and at < p_to),
    'tok_out_day', (select coalesce(sum(tout), 0) from public.cost where kind = 0 and at >= p_from and at < p_to),

    'interventions', (select count(*) from public.key where act between 1 and 7 and created_at >= p_from and created_at < p_to),
    'holder_looks',  (select count(*) from public.key where act = 0 and created_at >= p_from and created_at < p_to)
  )
$$;

create function public.aua_report_put(p_id text, p_kind int, p_day date, p_light int, p_nums jsonb, p_judged boolean, p_held boolean)
returns boolean language plpgsql as $$
begin
  insert into public.report_log (id, kind, day, light, nums, judged, held) values (p_id, p_kind, p_day, p_light, p_nums, p_judged, p_held)
  on conflict (id) do nothing;
  return found;  -- false = this exact report was already made
end $$;
create function public.aua_report_sent(p_id text, p_ok boolean, p_err int) returns void language sql as $$
  update public.report_log set sent = p_ok, send_err = p_err where id = p_id
$$;

-- ── ask: wind-verified first (4_ §13【定】); flagged things give no stub ──
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
  ), rp as (
    select g.thing_id, g.op, g.cin, g.cout,
           (select count(rr.*) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as tried,
           (select count(*) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where rr.pass and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as verified
      from g
  ), pick as (
    select g.*, rp.tried, rp.verified, th.addr, th.iface,
           exists (select 1 from public.wind_flag f where f.thing_id = g.thing_id) as flagged
      from g join rp using (thing_id, op, cin, cout) join public.thing th on th.id = g.thing_id
     where g.maxeff <= p_effect and g.money <= p_money and g.tout <= p_tout
     order by (rp.verified > 0) desc, rp.verified desc, g.last desc
     limit p_k
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'thing', jsonb_build_object('addr', p.addr, 'iface', p.iface),
           'call',  jsonb_build_object('op', p.op, 'in', p.cin, 'out', p.cout),
           'n',     jsonb_build_object('ok', p.ok, 'part', p.part, 'fail', p.fail, 'abort', p.abort),
           'ind',   jsonb_build_object('models', p.models, 'rts', p.rts, 'keys', p.keys),
           'cost',  jsonb_build_object('tin', p.tin, 'tout', p.tout, 'ms', p.ms, 'money', p.money),
           'rp',    jsonb_build_object('tried', p.tried, 'pass', p.verified),
           'last',  p.last,
           'stub',  case when p.maxeff >= 2 or p.flagged then 'null'::jsonb else coalesce(
                      (select u3.rec->'stub' from public.use u3
                        where u3.task = p_task and u3.thing_id = p.thing_id and u3.op = p.op
                          and u3.cin = p.cin and u3.cout = p.cout
                          and u3.is_digest and u3.code = 0 and u3.effect < 2 and u3.has_stub
                        order by u3.t desc limit 1), 'null'::jsonb) end,
           'lease', p_lease
         ) order by (p.verified > 0) desc, p.verified desc, p.last desc), '[]'::jsonb)
    into v
    from pick p;

  return jsonb_build_object('view', v, 'lease', p_lease);
end $$;

revoke execute on function public.aua_note_ask(int), public.aua_wind_things(int), public.aua_wind_put(text, int, int, jsonb, int), public.aua_cost_add(int, int, bigint, bigint, numeric, numeric),
  public.aua_cost_month(), public.aua_model_ok(), public.aua_cash_ok(), public.aua_report_numbers(timestamptz, timestamptz),
  public.aua_report_put(text, int, date, int, jsonb, boolean, boolean), public.aua_report_sent(text, boolean, int)
  from public, anon, authenticated;
grant execute on function public.aua_note_ask(int), public.aua_wind_things(int), public.aua_wind_put(text, int, int, jsonb, int), public.aua_cost_add(int, int, bigint, bigint, numeric, numeric),
  public.aua_cost_month(), public.aua_model_ok(), public.aua_cash_ok(), public.aua_report_numbers(timestamptz, timestamptz),
  public.aua_report_put(text, int, date, int, jsonb, boolean, boolean), public.aua_report_sent(text, boolean, int)
  to service_role;
