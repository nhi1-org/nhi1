-- NHI-1 root board · SCHEMA BATCH, part 2 (George 11/10 裁（五）; 2_ §2.2, 4_ §13): time lives in the record.
-- LOCAL BRANCH ONLY until George says go. Changes the aua hash (with part 1, 20261110000009).
--   * use / talk / replay: t = the UTC day; prev chains a key's citizen records. The exact second comes on the
--     envelope ({rec, at:{t, sig}}), is checked by the handler, kept here in at_t, and never exported
--     (export and replica send rec only).
--   * chain_head: the root accepts a write only if rec.prev is the key's head (one atomic conditional
--     update, so two sessions racing on one key cannot both win). A resend of a stored record is a dup,
--     not a collision.
--   * view.flag: a canary-hit tool is listed LAST with its rule code; n and ind are 0; no stub
--     (replaces "not in the view" from 20261110000008).
-- License: Apache-2.0

alter table public.use    add column at_t bigint;   -- exact send time (root only, never exported)
alter table public.replay add column at_t bigint;
alter table public.talk   add column at_t bigint;

create table public.chain_head (
  key  text primary key check (key ~ '^[0-9a-f]{64}$'),
  id   text not null check (id ~ '^[0-9a-f]{64}$'),
  n    bigint not null default 1,
  at   timestamptz not null default now()
);
alter table public.chain_head enable row level security;
revoke all on public.chain_head from public, anon, authenticated;
grant select, insert, update on public.chain_head to service_role;

insert into public.knob (name, val) values ('h_key_hour', 600), ('h_ip_hour', 3000) on conflict (name) do nothing;

-- move the head from p_prev to p_id; null = done, else the current head (collision)
create function public.aua_chain_take(p_key text, p_prev text, p_id text) returns jsonb
language plpgsql as $$
declare h text;
begin
  if p_prev is null then
    insert into public.chain_head (key, id) values (p_key, p_id) on conflict (key) do nothing;
  else
    update public.chain_head set id = p_id, n = n + 1, at = now() where key = p_key and id = p_prev;
  end if;
  if found then return null; end if;
  select id into h from public.chain_head where key = p_key;
  return jsonb_build_object('err', 21, 'head', h);
end $$;

create function public.aua_chain_head(p_key text) returns text language sql stable as $$
  select id from public.chain_head where key = p_key
$$;

create function public.aua_gate_head(p_ip text, p_key text) returns int
language plpgsql as $$
declare ok boolean := true;
begin
  ok := public.aua_hit('hi:' || p_ip, 3600, public.aua_knob('h_ip_hour')) and ok;
  ok := public.aua_hit('hk:' || p_key, 3600, public.aua_knob('h_key_hour')) and ok;
  return case when ok then 0 else 7 end;
end $$;

drop function public.aua_put_use(text, jsonb, text);
create function public.aua_put_use(p_id text, p_rec jsonb, p_thing_id text, p_at bigint) returns jsonb
language plpgsql as $$
declare redeemed boolean := false; c jsonb;
begin
  if exists (select 1 from public.use where id = p_id) then
    return jsonb_build_object('dup', true, 'lease', false);
  end if;
  c := public.aua_chain_take(p_rec #>> '{by,key}', p_rec->>'prev', p_id);
  if c is not null then return c || jsonb_build_object('dup', false, 'lease', false); end if;

  insert into public.thing (id, addr, iface)
  values (p_thing_id, p_rec #>> '{thing,addr}', p_rec #>> '{thing,iface}')
  on conflict do nothing;

  insert into public.use (id, rec, thing_id, task, op, cin, cout, code, err, effect, key, model, rt, t,
                          tin, tout, ms, money, cur, has_stub, is_digest, lease, at_t)
  values (p_id, p_rec, p_thing_id, p_rec->>'task',
          p_rec #>> '{call,op}', p_rec #>> '{call,in}', p_rec #>> '{call,out}',
          (p_rec #>> '{result,code}')::smallint, (p_rec #>> '{result,err}')::smallint,
          (p_rec->>'effect')::smallint,
          p_rec #>> '{by,key}', p_rec #>> '{by,model}', p_rec #>> '{by,rt}', (p_rec->>'t')::bigint,
          (p_rec #>> '{cost,tin}')::bigint, (p_rec #>> '{cost,tout}')::bigint, (p_rec #>> '{cost,ms}')::bigint,
          (p_rec #>> '{cost,money}')::numeric, p_rec #>> '{cost,cur}',
          jsonb_typeof(p_rec->'stub') = 'object',
          coalesce(jsonb_array_length(p_rec->'from'), 0) > 0,
          p_rec->>'lease', p_at);

  if p_rec->>'lease' is not null then
    update public.lease set used_use = p_id, used_at = now()
     where id = p_rec->>'lease' and used_use is null and expires_at > now() and task = p_rec->>'task'
       and key = p_rec #>> '{by,key}';
    redeemed := found;
  end if;
  return jsonb_build_object('dup', false, 'lease', redeemed);
end $$;

drop function public.aua_put_replay(text, jsonb);
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
    from public.replay_result rr
    join public.replay r on r.id = rr.req_id
    join public.use u2 on u2.id = r.use_id
   where u2.task = u.task and u2.thing_id = u.thing_id and u2.op = u.op and u2.cin = u.cin and u2.cout = u.cout;
  return jsonb_build_object('id', p_id, 'rp', rp);
end $$;

-- ── ask: flagged tools listed last with their rule code; n / ind 0; no stub; rpf as in part 1 ──
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
             where rr.pass and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as verified,
           (select count(distinct rr.fam) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where rr.fam is not null and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as fams,
           (select count(*) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where rr.fam is not null and rr.pass and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as fpass
      from g
  ), pick as (
    select g.*, rp.tried, rp.verified, rp.fams, rp.fpass, th.addr, th.iface,
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
           'rp',    jsonb_build_object('tried', p.tried, 'pass', p.verified),
           'rpf',   jsonb_build_object('fams', p.fams, 'pass', p.fpass),
           'flag',  p.flag,
           'last',  p.last,
           'stub',  case when p.maxeff >= 2 or p.flag > 0 then 'null'::jsonb else coalesce(
                      (select u3.rec->'stub' from public.use u3
                        where u3.task = p_task and u3.thing_id = p.thing_id and u3.op = p.op
                          and u3.cin = p.cin and u3.cout = p.cout
                          and u3.is_digest and u3.code = 0 and u3.effect < 2 and u3.has_stub
                        order by u3.t desc limit 1), 'null'::jsonb) end,
           'lease', p_lease
         ) order by (p.flag > 0), (p.verified > 0) desc, p.verified desc, p.last desc), '[]'::jsonb)
    into v
    from pick p;

  return jsonb_build_object('view', v, 'lease', p_lease);
end $$;

revoke execute on function public.aua_chain_take(text, text, text), public.aua_chain_head(text), public.aua_gate_head(text, text),
  public.aua_put_use(text, jsonb, text, bigint), public.aua_put_replay(text, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.aua_chain_take(text, text, text), public.aua_chain_head(text), public.aua_gate_head(text, text),
  public.aua_put_use(text, jsonb, text, bigint), public.aua_put_replay(text, jsonb, bigint)
  to service_role;
