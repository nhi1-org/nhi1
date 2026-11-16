-- NHI-1 root board · AUA v0.1 · S1 core schema
-- Enforced in the database, not just documented:
--   * RLS on for every table; anon / authenticated have NO privileges (no select/insert/update/delete).
--     Reads go only through the `ask` edge function; full data goes out as the daily export.
--   * Records (thing, use, talk, key, replay) are append-only: no UPDATE / DELETE / TRUNCATE,
--     enforced by revoked privileges AND by triggers — even service_role cannot change a record.
--   * Writes happen only inside edge functions (service_role), after Ed25519 + hard-rule checks.
-- License: Apache-2.0

-- ───────────────────────── records ─────────────────────────

create table public.thing (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),      -- sha256(canon({addr, iface}))
  addr       text not null check (addr ~ '^https://' and length(addr) <= 256),
  iface      text not null check (iface ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (addr, iface)
);

create table public.use (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),      -- sha256(canon(record incl. sig))
  rec        jsonb not null,                                       -- the signed record, verbatim
  thing_id   text not null references public.thing(id),
  task       text not null check (task ~ '^[0-9a-f]{64}$'),
  op         text not null check (op   ~ '^[0-9a-f]{64}$'),
  cin        text not null check (cin  ~ '^[0-9a-f]{64}$'),
  cout       text not null check (cout ~ '^[0-9a-f]{64}$'),
  code       smallint not null check (code between 0 and 3),
  err        smallint not null check (err between 0 and 10),
  effect     smallint not null check (effect between 0 and 3),
  key        text not null check (key   ~ '^[0-9a-f]{64}$'),
  model      text not null check (model ~ '^[0-9a-f]{64}$'),
  rt         text not null check (rt    ~ '^[0-9a-f]{64}$'),
  t          bigint not null,
  tin        bigint not null, tout bigint not null, ms bigint not null,
  money      numeric not null, cur text not null,
  has_stub   boolean not null,
  is_digest  boolean not null,                                     -- has non-empty `from` (digest layer, §2.5)
  lease      text,
  created_at timestamptz not null default now(),
  constraint nhi_no_stub_when_irreversible check (effect < 2 or not has_stub)  -- AUA §7
);
create index use_task_idx  on public.use (task);
create index use_group_idx on public.use (task, thing_id, op, cin, cout);
create index use_key_idx   on public.use (key, created_at);

create table public.talk (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec        jsonb not null,
  about_thing text references public.thing(id),
  about_use  text references public.use(id),
  kind       smallint not null check (kind between 0 and 4),
  key        text not null check (key ~ '^[0-9a-f]{64}$'),
  t          bigint not null,
  created_at timestamptz not null default now(),
  check (about_thing is not null or about_use is not null)
);

create table public.key (                                          -- AUA §2.6: the marks of the keys
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec        jsonb not null,
  act        smallint not null check (act between 0 and 4),
  by_key     text not null check (by_key ~ '^[0-9a-f]{64}$'),
  chain      text,
  q          text,
  until      bigint not null,
  t          bigint not null,
  created_at timestamptz not null default now()
);
create index key_by_idx on public.key (by_key, t);

create table public.replay (                                       -- S1: replay requests only
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec        jsonb not null,
  use_id     text not null references public.use(id),
  by_key     text not null,
  t          bigint not null,
  created_at timestamptz not null default now()
);
create table public.replay_result (                                -- S2 engine appends here
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  rec        jsonb not null,
  req_id     text not null references public.replay(id),
  pass       boolean not null,
  created_at timestamptz not null default now()
);

-- ───────────────────────── tickets & knobs (not records) ─────────────────────────

create table public.lease (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  task       text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_use   text,
  used_at    timestamptz
);
create index lease_exp_idx on public.lease (expires_at);

create table public.rate (
  bucket text   not null,
  win    bigint not null,
  n      int    not null,
  primary key (bucket, win)
);

-- 4_實施 §7 knob #1 (write quota) + ask quota. Tune with UPDATE as postgres; no redeploy needed.
create table public.knob (name text primary key, val bigint not null);
insert into public.knob (name, val) values
  ('w_global_day',   20000),   -- all writes, whole board, per UTC day (free-tier guard)
  ('w_ip_hour',        200), ('w_ip_day',     2000),
  ('w_key_hour',       120), ('w_key_day',    1000),
  ('w_newkey_hour',     20), ('w_newkey_day',  100),   -- a key is "new" until its first record is this old:
  ('newkey_age_sec', 604800),                          -- 7 days
  ('a_ip_min',          60), ('a_ip_day',     5000),   -- ask (reads) per IP
  ('a_global_day',  100000),
  ('lease_ttl_sec',   3600);

-- ───────────────────────── append-only enforcement ─────────────────────────

create function public.aua_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'aua: records are append-only (% on %)', tg_op, tg_table_name using errcode = '42501';
end $$;

do $$ declare t text; begin
  foreach t in array array['thing','use','talk','key','replay','replay_result'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.aua_append_only()', t || '_no_change', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.aua_append_only()', t || '_no_truncate', t);
  end loop;
end $$;

-- lease: the only allowed change is redeeming once; delete only after expiry (cleanup).
create function public.aua_lease_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.expires_at > now() then raise exception 'aua: live lease' using errcode = '42501'; end if;
    return old;
  end if;
  if old.used_use is not null or new.id <> old.id or new.task <> old.task
     or new.expires_at <> old.expires_at or new.created_at <> old.created_at or new.used_use is null then
    raise exception 'aua: lease can only be redeemed once' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger lease_guard before update or delete on public.lease for each row execute function public.aua_lease_guard();

-- ───────────────────────── RLS + privileges ─────────────────────────

alter table public.thing enable row level security;
alter table public.use enable row level security;
alter table public.talk enable row level security;
alter table public.key enable row level security;
alter table public.replay enable row level security;
alter table public.replay_result enable row level security;
alter table public.lease enable row level security;
alter table public.rate enable row level security;
alter table public.knob enable row level security;
-- No policies at all: anon / authenticated match nothing even if a grant slipped in.

revoke all on public.thing, public.use, public.talk, public.key, public.replay, public.replay_result,
              public.lease, public.rate, public.knob
  from public, anon, authenticated;

revoke all on public.thing, public.use, public.talk, public.key, public.replay, public.replay_result,
              public.lease, public.rate, public.knob
  from service_role;
grant select, insert on public.thing, public.use, public.talk, public.key, public.replay, public.replay_result to service_role;
grant select, insert, update, delete on public.lease, public.rate to service_role;
grant select on public.knob to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ───────────────────────── RPC (called only by edge functions, as service_role) ─────────────────────────

create function public.aua_knob(p text) returns bigint language sql stable as $$
  select val from public.knob where name = p
$$;

-- increment a fixed-window counter; true while within limit
create function public.aua_hit(p_bucket text, p_win int, p_limit bigint) returns boolean
language plpgsql as $$
declare w bigint := floor(extract(epoch from now()) / p_win); c int;
begin
  insert into public.rate as r (bucket, win, n) values (p_bucket || '/' || p_win, w, 1)
  on conflict (bucket, win) do update set n = r.n + 1
  returning n into c;
  return c <= p_limit;
end $$;

-- write gate: 0 = ok, 7 = rate limited. Every attempt counts (hammering costs the hammerer).
create function public.aua_gate_write(p_key text, p_ip text) returns int
language plpgsql as $$
declare
  first_seen timestamptz;
  is_new boolean;
  ok boolean := true;
begin
  select min(created_at) into first_seen from (
    select created_at from public.use where key = p_key
    union all select created_at from public.replay where by_key = p_key
    union all select created_at from public.key where by_key = p_key
  ) s;
  is_new := first_seen is null or first_seen > now() - make_interval(secs => public.aua_knob('newkey_age_sec'));
  ok := public.aua_hit('wg', 86400, public.aua_knob('w_global_day')) and ok;
  ok := public.aua_hit('wi:' || p_ip, 3600,  public.aua_knob('w_ip_hour')) and ok;
  ok := public.aua_hit('wi:' || p_ip, 86400, public.aua_knob('w_ip_day')) and ok;
  if is_new then
    ok := public.aua_hit('wk:' || p_key, 3600,  public.aua_knob('w_newkey_hour')) and ok;
    ok := public.aua_hit('wk:' || p_key, 86400, public.aua_knob('w_newkey_day')) and ok;
  else
    ok := public.aua_hit('wk:' || p_key, 3600,  public.aua_knob('w_key_hour')) and ok;
    ok := public.aua_hit('wk:' || p_key, 86400, public.aua_knob('w_key_day')) and ok;
  end if;
  return case when ok then 0 else 7 end;
end $$;

create function public.aua_gate_ask(p_ip text) returns int
language plpgsql as $$
declare ok boolean := true;
begin
  ok := public.aua_hit('ag', 86400, public.aua_knob('a_global_day')) and ok;
  ok := public.aua_hit('ai:' || p_ip, 60,    public.aua_knob('a_ip_min')) and ok;
  ok := public.aua_hit('ai:' || p_ip, 86400, public.aua_knob('a_ip_day')) and ok;
  return case when ok then 0 else 7 end;
end $$;

create function public.aua_put_use(p_id text, p_rec jsonb, p_thing_id text) returns jsonb
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
     where id = p_rec->>'lease' and used_use is null and expires_at > now() and task = p_rec->>'task';
    redeemed := found;
  end if;
  return jsonb_build_object('dup', n = 0, 'lease', redeemed);
end $$;

-- ask → views (counts, independence, median cost, replay results; never a score) + a lease.
create function public.aua_ask(p_task text, p_effect int, p_money numeric, p_tout bigint, p_k int, p_lease text)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  insert into public.lease (id, task, expires_at)
  values (p_lease, p_task, now() + make_interval(secs => public.aua_knob('lease_ttl_sec')));

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
           -- stubs come only from the digest layer, replay-passed (code 0), and never for effect >= 2
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

-- replay request (S1 registers only); answers the current rp of that use's group.
create function public.aua_put_replay(p_id text, p_rec jsonb) returns jsonb
language plpgsql as $$
declare u public.use%rowtype; rp jsonb;
begin
  select * into u from public.use where id = p_rec->>'use';
  if not found then return jsonb_build_object('err', 12); end if;
  insert into public.replay (id, rec, use_id, by_key, t)
  values (p_id, p_rec, u.id, p_rec #>> '{by,key}', (p_rec->>'t')::bigint)
  on conflict (id) do nothing;
  select jsonb_build_object('tried', count(rr.*), 'pass', count(*) filter (where rr.pass)) into rp
    from public.replay_result rr
    join public.replay r on r.id = rr.req_id
    join public.use u2 on u2.id = r.use_id
   where u2.task = u.task and u2.thing_id = u.thing_id and u2.op = u.op and u2.cin = u.cin and u2.cout = u.cout;
  return jsonb_build_object('id', p_id, 'rp', rp);
end $$;

-- key holder view (AUA §2.6 act=0): the mark is written FIRST, in the same transaction as the read.
create function public.aua_key_view(p_id text, p_rec jsonb, p_table int, p_qid text, p_qkey text,
                                    p_since bigint, p_lim int) returns jsonb
language plpgsql as $$
declare rows jsonb;
begin
  insert into public.key (id, rec, act, by_key, chain, q, until, t)
  values (p_id, p_rec, (p_rec->>'act')::smallint, p_rec #>> '{by,key}', p_rec #>> '{on,chain}',
          p_rec #>> '{on,q}', (p_rec->>'until')::bigint, (p_rec->>'t')::bigint);

  if p_table = 0 then
    select coalesce(jsonb_agg(x), '[]') into rows from (
      select jsonb_build_object('id', id, 'rec', jsonb_build_object('addr', addr, 'iface', iface)) x
        from public.thing
       where (p_qid is null or id = p_qid) and extract(epoch from created_at) >= p_since
       order by created_at desc limit p_lim) s;
  elsif p_table = 1 then
    select coalesce(jsonb_agg(x), '[]') into rows from (
      select jsonb_build_object('id', id, 'rec', rec) x from public.use
       where (p_qid is null or id = p_qid) and (p_qkey is null or key = p_qkey) and t >= p_since
       order by t desc limit p_lim) s;
  elsif p_table = 2 then
    select coalesce(jsonb_agg(x), '[]') into rows from (
      select jsonb_build_object('id', id, 'rec', rec) x from public.talk
       where (p_qid is null or id = p_qid) and (p_qkey is null or key = p_qkey) and t >= p_since
       order by t desc limit p_lim) s;
  else
    select coalesce(jsonb_agg(x), '[]') into rows from (
      select jsonb_build_object('id', id, 'rec', rec) x from public.key
       where (p_qid is null or id = p_qid) and (p_qkey is null or by_key = p_qkey) and t >= p_since
       order by t desc limit p_lim) s;
  end if;
  return jsonb_build_object('id', p_id, 'rows', rows);
end $$;

-- export page (records only; never lease / rate / IP). table: 0 thing 1 use 2 talk 3 key 4 replay
create function public.aua_export_page(p_table int, p_after text, p_lim int) returns jsonb
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
  else
    select coalesce(jsonb_agg(x order by id), '[]') into rows from (
      select id, jsonb_build_object('id', id, 'rec', rec) x from public.replay where id > p_after order by id limit p_lim) s;
  end if;
  return rows;
end $$;

-- housekeeping: expired leases and old rate windows (not records)
create function public.aua_housekeep() returns void language sql as $$
  delete from public.lease where expires_at < now() - interval '1 day';
  delete from public.rate where (split_part(bucket, '/', 2))::bigint * win < extract(epoch from now()) - 172800;
$$;

-- functions: nobody but service_role may execute
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.aua_knob(text), public.aua_hit(text, int, bigint),
  public.aua_gate_write(text, text), public.aua_gate_ask(text),
  public.aua_put_use(text, jsonb, text), public.aua_ask(text, int, numeric, bigint, int, text),
  public.aua_put_replay(text, jsonb),
  public.aua_key_view(text, jsonb, int, text, text, bigint, int),
  public.aua_export_page(int, text, int), public.aua_housekeep()
to service_role;
