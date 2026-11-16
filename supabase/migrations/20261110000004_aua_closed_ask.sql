-- NHI-1 root board · closing the door (George 11/09 深夜 全封閉; 2_ §2.3, 4_ §3, §13)
--   * ask is signed (checked in the edge function); the lease it returns is bound to that key:
--     only a use signed by the same key redeems it
--   * asks are also limited per key (the IP limits stay)
--   * replica (signed full pull) is switched by a knob; 0 = closed until George decides the export time format
-- License: Apache-2.0

alter table public.lease add column key text check (key is null or key ~ '^[0-9a-f]{64}$');

-- a lease can only be redeemed once, never re-pointed to another key or task
create or replace function public.aua_lease_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.expires_at > now() then raise exception 'aua: live lease' using errcode = '42501'; end if;
    return old;
  end if;
  if old.used_use is not null or new.id <> old.id or new.task <> old.task or new.key is distinct from old.key
     or new.expires_at <> old.expires_at or new.created_at <> old.created_at or new.used_use is null then
    raise exception 'aua: lease can only be redeemed once' using errcode = '42501';
  end if;
  return new;
end $$;

insert into public.knob (name, val) values
  ('a_key_min', 60), ('a_key_day', 5000),   -- ask (reads) per key
  ('r_key_day', 24), ('r_ip_day', 48),      -- replica pulls: limited, never refused for lack of seniority
  ('replica_open', 0)                       -- 0 = replica endpoint closed (pending the export time format)
on conflict (name) do nothing;

drop function public.aua_gate_ask(text);
create function public.aua_gate_ask(p_ip text, p_key text) returns int
language plpgsql as $$
declare ok boolean := true;
begin
  ok := public.aua_hit('ag', 86400, public.aua_knob('a_global_day')) and ok;
  ok := public.aua_hit('ai:' || p_ip, 60,    public.aua_knob('a_ip_min')) and ok;
  ok := public.aua_hit('ai:' || p_ip, 86400, public.aua_knob('a_ip_day')) and ok;
  ok := public.aua_hit('ak:' || p_key, 60,    public.aua_knob('a_key_min')) and ok;
  ok := public.aua_hit('ak:' || p_key, 86400, public.aua_knob('a_key_day')) and ok;
  return case when ok then 0 else 7 end;
end $$;

-- replica gate: 0 ok, 7 rate limited, 20 closed
create function public.aua_gate_replica(p_ip text, p_key text) returns int
language plpgsql as $$
declare ok boolean := true;
begin
  if public.aua_knob('replica_open') = 0 then return 20; end if;
  ok := public.aua_hit('ri:' || p_ip, 86400, public.aua_knob('r_ip_day')) and ok;
  ok := public.aua_hit('rk:' || p_key, 86400, public.aua_knob('r_key_day')) and ok;
  return case when ok then 0 else 7 end;
end $$;

-- the lease is issued to the asking key
drop function public.aua_ask(text, int, numeric, bigint, int, text);
create function public.aua_ask(p_task text, p_effect int, p_money numeric, p_tout bigint, p_k int, p_lease text, p_key text)
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
  ), pick as (
    select g.*, th.addr, th.iface
      from g join public.thing th on th.id = g.thing_id
     where g.maxeff <= p_effect and g.money <= p_money and g.tout <= p_tout
     order by g.keys desc, g.ok desc, g.last desc
     limit p_k
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'thing', jsonb_build_object('addr', p.addr, 'iface', p.iface),
           'call',  jsonb_build_object('op', p.op, 'in', p.cin, 'out', p.cout),
           'n',     jsonb_build_object('ok', p.ok, 'part', p.part, 'fail', p.fail, 'abort', p.abort),
           'ind',   jsonb_build_object('models', p.models, 'rts', p.rts, 'keys', p.keys),
           'cost',  jsonb_build_object('tin', p.tin, 'tout', p.tout, 'ms', p.ms, 'money', p.money),
           'rp',    (select jsonb_build_object('tried', count(rr.*), 'pass', count(*) filter (where rr.pass))
                       from public.replay_result rr
                       join public.replay r on r.id = rr.req_id
                       join public.use u2 on u2.id = r.use_id
                      where u2.task = p_task and u2.thing_id = p.thing_id and u2.op = p.op
                        and u2.cin = p.cin and u2.cout = p.cout),
           'last',  p.last,
           'stub',  case when p.maxeff >= 2 then 'null'::jsonb else coalesce(
                      (select u3.rec->'stub' from public.use u3
                        where u3.task = p_task and u3.thing_id = p.thing_id and u3.op = p.op
                          and u3.cin = p.cin and u3.cout = p.cout
                          and u3.is_digest and u3.code = 0 and u3.effect < 2 and u3.has_stub
                        order by u3.t desc limit 1), 'null'::jsonb) end,
           'lease', p_lease
         ) order by p.keys desc, p.ok desc, p.last desc), '[]'::jsonb)
    into v
    from pick p;

  return jsonb_build_object('view', v, 'lease', p_lease);
end $$;

-- a use redeems a lease only if it is signed by the key the lease was issued to
create or replace function public.aua_put_use(p_id text, p_rec jsonb, p_thing_id text) returns jsonb
language plpgsql as $$
declare n int; redeemed boolean := false;
begin
  insert into public.thing (id, addr, iface)
  values (p_thing_id, p_rec #>> '{thing,addr}', p_rec #>> '{thing,iface}')
  on conflict do nothing;

  insert into public.use (id, rec, thing_id, task, op, cin, cout, code, err, effect, key, model, rt, t,
                          tin, tout, ms, money, cur, has_stub, is_digest, lease)
  values (p_id, p_rec, p_thing_id, p_rec->>'task',
          p_rec #>> '{call,op}', p_rec #>> '{call,in}', p_rec #>> '{call,out}',
          (p_rec #>> '{result,code}')::smallint, (p_rec #>> '{result,err}')::smallint,
          (p_rec->>'effect')::smallint,
          p_rec #>> '{by,key}', p_rec #>> '{by,model}', p_rec #>> '{by,rt}', (p_rec->>'t')::bigint,
          (p_rec #>> '{cost,tin}')::bigint, (p_rec #>> '{cost,tout}')::bigint, (p_rec #>> '{cost,ms}')::bigint,
          (p_rec #>> '{cost,money}')::numeric, p_rec #>> '{cost,cur}',
          jsonb_typeof(p_rec->'stub') = 'object',
          coalesce(jsonb_array_length(p_rec->'from'), 0) > 0,
          p_rec->>'lease')
  on conflict (id) do nothing;
  get diagnostics n = row_count;

  if n = 1 and p_rec->>'lease' is not null then
    update public.lease set used_use = p_id, used_at = now()
     where id = p_rec->>'lease' and used_use is null and expires_at > now() and task = p_rec->>'task'
       and key = p_rec #>> '{by,key}';
    redeemed := found;
  end if;
  return jsonb_build_object('dup', n = 0, 'lease', redeemed);
end $$;

revoke execute on function public.aua_gate_ask(text, text), public.aua_gate_replica(text, text),
  public.aua_ask(text, int, numeric, bigint, int, text, text) from public, anon, authenticated;
grant execute on function public.aua_gate_ask(text, text), public.aua_gate_replica(text, text),
  public.aua_ask(text, int, numeric, bigint, int, text, text) to service_role;
