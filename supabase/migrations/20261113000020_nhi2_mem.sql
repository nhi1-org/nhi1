-- NHI-2 · 0020: the private cabin (私艙, 9_). Its own tables, its own knobs (m_* / mem_*), its own rate
-- buckets (mw: mwi: mr: mri: mb: mg). Nothing of NHI-1 is changed: no NHI-1 table, function, knob or
-- bucket; NHI-1's schema hash is unchanged (mem has its own schema and hash, mem-schema.ts).
-- The root keeps only shells and ciphertext (9_ §3.1, §3.2【定】). Not in export, replica, ask, wall,
-- weight or the daily report. Not append-only: the citizen may delete its own (signed delete; 9_ §3.3, §5).
-- Numbers are knobs (4_ §7): tighten with UPDATE as postgres, no redeploy. 【暫，CODE 建議】 unless noted.

create table public.mem (
  id    text   primary key check (id ~ '^[0-9a-f]{64}$'),   -- sha256(canon(record incl. sig))
  key   text   not null check (key ~ '^[0-9a-f]{64}$'),
  seq   bigint not null check (seq >= 0),
  kind  int    not null check (kind in (0, 1, 2, 4, 6)),
  size  int    not null check (size > 0),
  t     bigint not null check (t % 86400 = 0),
  sup   text[] not null default '{}',
  upto  bigint,
  rec   jsonb  not null,                                     -- the signed shell, verbatim (enc inside)
  at    timestamptz not null default now(),                  -- inside the root only
  unique (key, seq)
);
create index mem_key_kind_idx on public.mem (key, kind, seq);
create index mem_sup_idx on public.mem using gin (sup);

-- each key's mem chain head (its own; NHI-1's chain_head is not shared)
create table public.mem_head (
  key text   primary key check (key ~ '^[0-9a-f]{64}$'),
  id  text   not null,
  seq bigint not null,
  at  timestamptz not null default now()
);

alter table public.mem enable row level security;
alter table public.mem_head enable row level security;
-- no policies: anon / authenticated match nothing, not even shells (9_ §3.4)
revoke all on public.mem, public.mem_head from public, anon, authenticated, service_role;
grant select, insert, delete on public.mem to service_role;
grant select, insert, update on public.mem_head to service_role;

insert into public.knob (name, val) values
  ('mem_write_on',            1),          -- 0 = the root takes no new mem; reads and deletes still work (寓言 20 a)
  ('m_key_hour',            120), ('m_key_day',      1000),   -- puts + deletes per key (寓言 19 a: like use, own buckets)
  ('m_newkey_hour',          20), ('m_newkey_day',    100),   -- a key is new until its first mem is this old:
  ('m_newkey_age_sec',   604800),                             -- 7 days
  ('m_ip_hour',             200), ('m_ip_day',       2000),
  ('m_global_day',        20000),                             -- all mem writes, per UTC day
  ('m_read_key_hour',        60), ('m_read_ip_hour',  240),   -- head / boot / all
  ('m_rec_bytes',         65536),                             -- one mem's ciphertext (9_ §3.1: 64 KB 暫)
  ('m_key_day_bytes', 104857600),                             -- 100 MB per key per UTC day (9_ §8 第 4 題 暫)
  ('m_key_total_bytes', 1073741824),                          -- 1 GB per key (same); does not grow yet (寓言 17)
  ('m_global_bytes',  314572800),                             -- 300 MB for the whole cabin (Supabase Free: 500 MB DB)
  ('m_boot_max',             60)                              -- mems in one boot answer
on conflict (name) do nothing;

-- gate: p_op 0 put, 1 read, 2 delete → 0 ok, 7 rate, 44 writes off (put only)
create function public.aua_mem_gate(p_key text, p_ip text, p_op int) returns int language plpgsql as $$
declare ok boolean := true; first_seen timestamptz; is_new boolean;
begin
  if p_op = 1 then
    ok := public.aua_hit('mr:' || p_key, 3600, public.aua_knob('m_read_key_hour')) and ok;
    ok := public.aua_hit('mri:' || p_ip, 3600, public.aua_knob('m_read_ip_hour')) and ok;
    return case when ok then 0 else 7 end;
  end if;
  if p_op = 0 and coalesce(public.aua_knob('mem_write_on'), 0) = 0 then return 44; end if;
  select min(at) into first_seen from public.mem where key = p_key;
  is_new := first_seen is null or first_seen > now() - make_interval(secs => public.aua_knob('m_newkey_age_sec'));
  ok := public.aua_hit('mg', 86400, public.aua_knob('m_global_day')) and ok;
  ok := public.aua_hit('mwi:' || p_ip, 3600, public.aua_knob('m_ip_hour')) and ok;
  ok := public.aua_hit('mwi:' || p_ip, 86400, public.aua_knob('m_ip_day')) and ok;
  if is_new then
    ok := public.aua_hit('mw:' || p_key, 3600, public.aua_knob('m_newkey_hour')) and ok;
    ok := public.aua_hit('mw:' || p_key, 86400, public.aua_knob('m_newkey_day')) and ok;
  else
    ok := public.aua_hit('mw:' || p_key, 3600, public.aua_knob('m_key_hour')) and ok;
    ok := public.aua_hit('mw:' || p_key, 86400, public.aua_knob('m_key_day')) and ok;
  end if;
  return case when ok then 0 else 7 end;
end $$;

create function public.aua_mem_head(p_key text) returns jsonb language sql stable as $$
  select coalesce((select jsonb_build_object('head', id, 'seq', seq) from public.mem_head where key = p_key),
                  jsonb_build_object('head', null, 'seq', null))
$$;

-- one put. The handler has checked shape, schema hash, day and signature; this checks the chain, refs, sup,
-- bytes, and takes the head atomically. → { id, seq, dup } | { err, head?, seq? }
create function public.aua_mem_put(p_id text, p_rec jsonb) returns jsonb language plpgsql as $$
declare
  k text := p_rec->>'key';
  s bigint := (p_rec->>'seq')::bigint;
  pv text := p_rec->>'prev';
  sz int := (p_rec->>'size')::int;
  refs text[] := array(select jsonb_array_elements_text(p_rec->'refs'));
  sups text[] := array(select jsonb_array_elements_text(p_rec->'sup'));
  h record;
  v_bucket text := 'mb:' || k || '/86400';
  v_win bigint := floor(extract(epoch from now()) / 86400);
  used bigint;
  v_n int;
begin
  if exists (select 1 from public.mem where id = p_id) then
    return jsonb_build_object('id', p_id, 'seq', s, 'dup', true);
  end if;
  -- refs: only records that exist on NHI-1 (a fake hash would be 32 bytes of free text in the shell)
  if exists (select 1 from unnest(refs) r where not (
       exists (select 1 from public.use where id = r) or exists (select 1 from public.talk where id = r)
    or exists (select 1 from public.replay where id = r) or exists (select 1 from public.thing where id = r))) then
    return jsonb_build_object('err', 46);
  end if;
  -- sup: only earlier mems of the same key that are still here
  if exists (select 1 from unnest(sups) x where not exists (select 1 from public.mem m where m.id = x and m.key = k and m.seq < s)) then
    return jsonb_build_object('err', 47);
  end if;
  if sz > public.aua_knob('m_rec_bytes') then return jsonb_build_object('err', 2); end if;
  select coalesce(sum(r.n), 0) into used from public.rate r where r.bucket = v_bucket and r.win = v_win;
  if used + sz > public.aua_knob('m_key_day_bytes') then return jsonb_build_object('err', 42); end if;
  if (select coalesce(sum(size), 0) from public.mem where key = k) + sz > public.aua_knob('m_key_total_bytes') then
    return jsonb_build_object('err', 43);
  end if;
  if (select coalesce(sum(size), 0) from public.mem) + sz > public.aua_knob('m_global_bytes') then
    return jsonb_build_object('err', 45);
  end if;
  -- the chain: seq 0 / prev null takes an empty head; otherwise prev must be the head and seq = head.seq + 1
  if pv is null then
    if s <> 0 then return jsonb_build_object('err', 41) || public.aua_mem_head(k); end if;
    insert into public.mem_head (key, id, seq) values (k, p_id, 0) on conflict (key) do nothing;
  else
    update public.mem_head set id = p_id, seq = s, at = now() where key = k and id = pv and seq = s - 1;
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('err', 41) || public.aua_mem_head(k); end if;
  insert into public.mem (id, key, seq, kind, size, t, sup, upto, rec)
  values (p_id, k, s, (p_rec->>'kind')::int, sz, (p_rec->>'t')::bigint, sups, (p_rec->>'upto')::bigint, p_rec);
  insert into public.rate as r (bucket, win, n) values (v_bucket, v_win, sz)
  on conflict (bucket, win) do update set n = r.n + sz;
  return jsonb_build_object('id', p_id, 'seq', s, 'dup', false);
end $$;

-- NHI-1 re-run numbers for refs (read-back: basis 1 gets the record's re-run numbers). Only for uses; else null.
create function public.aua_mem_rp(p_refs text[]) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(r, case when exists (select 1 from public.use u where u.id = r) then jsonb_build_object(
      'rp',  jsonb_build_object(
               'tried', (select count(*) from public.replay_result rr join public.replay p on p.id = rr.req_id where p.use_id = r),
               'pass',  (select count(*) from public.replay_result rr join public.replay p on p.id = rr.req_id where p.use_id = r and rr.pass)),
      'rpf', jsonb_build_object(
               'fams',  (select count(distinct rr.fam) from public.replay_result rr join public.replay p on p.id = rr.req_id where p.use_id = r and rr.fam is not null),
               'pass',  (select count(*) from public.replay_result rr join public.replay p on p.id = rr.req_id where p.use_id = r and rr.fam is not null and rr.pass)))
    else 'null'::jsonb end), '{}'::jsonb)
  from (select distinct unnest(p_refs) as r) x
$$;

-- the read-back set (9_ §3.4 + George 11/13 二 寫入的內容): the latest live kind 4; live kind 0 and 1 after its
-- upto; every live kind 2 (preference) and 6 (carry). Live = not voided by another mem of the same key.
-- At most p_lim, the digest first, then newest. → { mem: [rec] in seq order, rp: { ref: numbers } }
create function public.aua_mem_boot(p_key text, p_lim int) returns jsonb language sql stable as $$
  with live as (
    select m.* from public.mem m
     where m.key = p_key
       and not exists (select 1 from public.mem v where v.key = p_key and v.sup @> array[m.id])
  ), d as (
    select * from live where kind = 4 order by seq desc limit 1
  ), pick as (
    select * from d
    union all
    select l.* from live l where l.kind in (0, 1) and l.seq > coalesce((select upto from d), -1)
    union all
    select l.* from live l where l.kind in (2, 6)
  ), cut as (
    select * from pick order by (kind = 4) desc, seq desc limit greatest(1, least(p_lim, public.aua_knob('m_boot_max')::int))
  )
  select jsonb_build_object(
    'mem', coalesce((select jsonb_agg(rec order by seq) from cut), '[]'::jsonb),
    'rp',  public.aua_mem_rp(coalesce((select array_agg(distinct r) from cut, jsonb_array_elements_text(cut.rec->'refs') r), '{}')))
$$;

-- every mem of this key, one page by seq (9_ §8 第 3 題【定】: each key can pull all of its ciphertext any time)
create function public.aua_mem_all(p_key text, p_after bigint, p_lim int) returns jsonb language sql stable as $$
  with pg as (
    select rec, seq from public.mem where key = p_key and seq > p_after order by seq limit least(p_lim, 100) + 1
  )
  select jsonb_build_object(
    'mem',  coalesce((select jsonb_agg(rec order by seq) from (select * from pg order by seq limit least(p_lim, 100)) x), '[]'::jsonb),
    'more', case when (select count(*) from pg) > least(p_lim, 100) then 1 else 0 end)
$$;

-- signed delete: only this key's rows. The head is kept (the chain goes on from it).
create function public.aua_mem_del(p_key text, p_ids jsonb) returns int language plpgsql as $$
declare n int;
begin
  delete from public.mem where key = p_key and id in (select jsonb_array_elements_text(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.aua_mem_gate(text, text, int), public.aua_mem_head(text), public.aua_mem_put(text, jsonb),
  public.aua_mem_rp(text[]), public.aua_mem_boot(text, int), public.aua_mem_all(text, bigint, int), public.aua_mem_del(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.aua_mem_gate(text, text, int), public.aua_mem_head(text), public.aua_mem_put(text, jsonb),
  public.aua_mem_rp(text[]), public.aua_mem_boot(text, int), public.aua_mem_all(text, bigint, int), public.aua_mem_del(text, jsonb)
  to service_role;
