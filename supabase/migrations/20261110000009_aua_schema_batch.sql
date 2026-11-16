-- NHI-1 root board · the SCHEMA BATCH (George 11/10 a): ships together with the time-format change, not before.
-- LOCAL BRANCH ONLY until George decides the time format. Changes the aua hash.
--   * view.rpf {fams, pass}: wind-tunnel re-runs with other model families (2_ §2.3). replay_result.fam names
--     the family; rpf counts only rows that have one. Claude results never fill rpf (George 11/10).
--   * report: a new record type (daily / emergency), signed by the wind key; numbers, codes, hashes only.
--     Append-only like every record, and part of the export.
-- License: Apache-2.0

alter table public.replay_result add column fam text check (fam is null or fam ~ '^[0-9a-f]{64}$');  -- sha256(family name)

create table public.report (
  id     text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec    jsonb not null,
  kind   smallint not null check (kind in (0, 1)),
  day    int not null,
  by_key text not null check (by_key ~ '^[0-9a-f]{64}$'),
  t      bigint not null,
  created_at timestamptz not null default now()
);
create trigger report_no_change before update or delete on public.report for each row execute function public.aua_append_only();
create trigger report_no_truncate before truncate on public.report for each statement execute function public.aua_append_only();
alter table public.report enable row level security;
revoke all on public.report from public, anon, authenticated, service_role;
grant select, insert on public.report to service_role;

create function public.aua_put_report(p_id text, p_rec jsonb) returns boolean language plpgsql as $$
begin
  insert into public.report (id, rec, kind, day, by_key, t)
  values (p_id, p_rec, (p_rec->>'kind')::smallint, (p_rec->>'day')::int, p_rec #>> '{by,key}', (p_rec->>'t')::bigint)
  on conflict (id) do nothing;
  return found;
end $$;

-- export: table 5 = report
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
  else
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.report where id > p_after order by id limit p_lim) s;
  end if;
  return rows;
end $$;

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
           -- rpf: only re-runs the wind tunnel made with a named model family (never self-reported, never Claude-for-Claude)
           (select count(distinct rr.fam) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where rr.fam is not null and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as fams,
           (select count(*) from public.replay_result rr join public.replay r on r.id = rr.req_id join public.use u2 on u2.id = r.use_id
             where rr.fam is not null and rr.pass and u2.task = p_task and u2.thing_id = g.thing_id and u2.op = g.op and u2.cin = g.cin and u2.cout = g.cout) as fpass
      from g
  ), pick as (
    select g.*, rp.tried, rp.verified, rp.fams, rp.fpass, th.addr, th.iface,
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
           'rpf',   jsonb_build_object('fams', p.fams, 'pass', p.fpass),
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

revoke execute on function public.aua_put_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.aua_put_report(text, jsonb) to service_role;