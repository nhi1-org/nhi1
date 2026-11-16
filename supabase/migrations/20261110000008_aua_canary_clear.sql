-- NHI-1 root board · canary flags, round 2 (7_ George 11/10 裁（五）3; George 11/10 晚 A)
--   * a canary-hit tool is NOT in the view at all. Its records stay and still go to every replica.
--   * no person clears a flag. Only the canary does, by judging again:
--       - the tool's published text changed (iface) → rescanned on the next wind run
--       - the rule set changed version (canary.ts RULES_V) → every flagged thing is rescanned first
--       - a model is available → model verdicts older than knob canary_rejudge_days are asked again;
--         "suspect, no judgement" flags are asked again on every run the model is available
--   * internal tables only: nothing here is a record, nothing is signed or exported, aua hash unchanged.
-- License: Apache-2.0

alter table public.wind_flag
  add column th          text,                    -- sha256 of the tool's published text when flagged
  add column rv          int not null default 1,  -- canary rules version that made the flag
  add column cleared_at  timestamptz,             -- null = live
  add column cleared_how smallint check (cleared_how in (0, 1)); -- 0 rescan no longer hits · 1 model judged it documentation
alter table public.wind_flag drop constraint wind_flag_thing_id_rule_key;
create unique index wind_flag_live on public.wind_flag (thing_id, rule) where cleared_at is null;

-- the model's last verdict on one exact tool text under one rules version (so the same text is not paid for daily)
create table public.canary_verdict (
  id       bigserial primary key,
  thing_id text not null references public.thing(id),
  th       text not null,
  rv       int not null,
  verdict  smallint not null check (verdict in (0, 1)),  -- 0 documentation · 1 instruction
  at       timestamptz not null default now()
);
create index canary_verdict_idx on public.canary_verdict (thing_id, th, rv, at);
alter table public.canary_verdict enable row level security;
revoke all on public.canary_verdict from public, anon, authenticated;
grant select, insert on public.canary_verdict to service_role;
grant usage, select on sequence public.canary_verdict_id_seq to service_role;
grant update on public.wind_flag to service_role;

insert into public.knob (name, val) values ('canary_rejudge_days', 7) on conflict (name) do nothing;

-- flagged things whose flags were made by an older rules version come first, then the usual order
drop function public.aua_wind_things(int);
create function public.aua_wind_things(p_lim int, p_rv int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x), '[]') from (
    select jsonb_build_object('id', th.id, 'addr', th.addr, 'iface', th.iface,
             'ops', (select coalesce(jsonb_agg(distinct u.op), '[]') from public.use u where u.thing_id = th.id),
             'recs', (select coalesce(jsonb_agg(r.id), '[]') from (select id from public.use u where u.thing_id = th.id order by created_at desc limit 5) r)) x
      from public.thing th
      left join lateral (select max(at) last from public.wind_check w where w.thing_id = th.id) l on true
     order by exists (select 1 from public.wind_flag f where f.thing_id = th.id and f.cleared_at is null and f.rv <> p_rv) desc,
              l.last nulls first, th.id
     limit p_lim) s
$$;

-- a model verdict still fresh for this exact text and rules version, or null (ask the model again)
create function public.aua_canary_memo(p_thing text, p_th text, p_rv int) returns int language sql stable as $$
  select verdict::int from public.canary_verdict
   where thing_id = p_thing and th = p_th and rv = p_rv
     and at > now() - make_interval(days => public.aua_knob('canary_rejudge_days')::int)
   order by at desc limit 1
$$;

-- one check result. p_rules null = no judgement possible (gone / unreachable): flags left as they are.
-- Otherwise the live flags of this thing become exactly p_rules: the rest are cleared (by the canary).
-- p_verdict: the model's verdict this run (null none · 0 documentation · 1 instruction), memoised.
-- Returns the rule codes that are NEW for this thing (they raise an emergency).
drop function public.aua_wind_put(text, int, int, jsonb, int);
create function public.aua_wind_put(p_thing text, p_result int, p_tools int, p_rules jsonb, p_how int,
                                    p_th text, p_rv int, p_verdict int)
returns int[] language plpgsql as $$
declare fresh int[] := '{}'; want int[]; r int;
begin
  insert into public.wind_check (thing_id, result, tools) values (p_thing, p_result, p_tools);
  if p_verdict is not null and p_th is not null then
    insert into public.canary_verdict (thing_id, th, rv, verdict) values (p_thing, p_th, p_rv, p_verdict);
  end if;
  if p_rules is null then return fresh; end if;

  select coalesce(array_agg((x)::int), '{}') into want from jsonb_array_elements_text(p_rules) x;
  update public.wind_flag set cleared_at = now(), cleared_how = case when p_verdict = 0 then 1 else 0 end
   where thing_id = p_thing and cleared_at is null and not (rule = any (want));
  foreach r in array want loop
    update public.wind_flag set how = p_how, th = p_th, rv = p_rv
     where thing_id = p_thing and rule = r and cleared_at is null;
    if not found then
      insert into public.wind_flag (thing_id, rule, how, th, rv) values (p_thing, r, p_how, p_th, p_rv);
      fresh := fresh || r;
    end if;
  end loop;
  return fresh;
end $$;

-- daily report: flags the canary cleared itself
create or replace function public.aua_canary_cleared(p_from timestamptz, p_to timestamptz) returns bigint language sql stable as $$
  select count(*) from public.wind_flag where cleared_at >= p_from and cleared_at < p_to
$$;

-- ── ask: a canary-hit tool is not in the view (records kept, still exported) ──
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
       and not exists (select 1 from public.wind_flag f where f.thing_id = u.thing_id and f.cleared_at is null)
     group by 1, 2, 3, 4
  ), rp as (
    select g.thing_id, g.op, g.cin, g.cout,
           (select count(rr.*) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as tried,
           (select count(*) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where rr.pass and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as verified
      from g
  ), pick as (
    select g.*, rp.tried, rp.verified, th.addr, th.iface
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
           'stub',  case when p.maxeff >= 2 then 'null'::jsonb else coalesce(
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

revoke execute on function public.aua_wind_things(int, int), public.aua_canary_memo(text, text, int),
  public.aua_wind_put(text, int, int, jsonb, int, text, int, int), public.aua_canary_cleared(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.aua_wind_things(int, int), public.aua_canary_memo(text, text, int),
  public.aua_wind_put(text, int, int, jsonb, int, text, int, int), public.aua_canary_cleared(timestamptz, timestamptz)
  to service_role;
