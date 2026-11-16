-- NHI-1 AUA · 0015: the digest (整理, 2_ §2.5; S4 C). LOCAL ONLY until George says go. No schema change of its
-- own (a digest is an ordinary use with stub and from); it ships in the same release as 0014.
--   * Trigger (S4 Q14, Q15 (a)): checked once a day when the wind tunnel runs, not on a human schedule: a thing
--     with >= digest_min_talk talk the canary has cleared (about not empty, never kind 5; talk on one of its uses
--     counts — Q13 (a)), and either never tried, or >= digest_min_talk new such talk since the last try, or more
--     failed uses than at the last try. A new interface is a new thing: it waits for its own talk.
--   * At most digest_day_max model reads a day (Q17); off until George turns digest_on to 1.
--   * The use it makes is signed by its own key (Q9 (c): the digest key, vault, public half in aua.json `digest`);
--     it rides that key's chain like any citizen's use (Q12 (a): the root acting as one agent).
-- License: Apache-2.0

insert into public.knob (name, val) values ('digest_on', 0), ('digest_min_talk', 5), ('digest_day_max', 5)
on conflict (name) do nothing;

-- one row per model read (root only, never exported). outcome: 0 made · 1 no_candidate · 2 bad_answer ·
-- 3 sandbox_fail · 4 sandbox_unavailable · 5 interface_gone
create table public.digest_log (
  id       bigserial primary key,
  thing_id text not null references public.thing(id),
  at       timestamptz not null default now(),
  outcome  smallint not null check (outcome between 0 and 5),
  use_id   text references public.use(id),
  fail     bigint not null,
  talk_n   bigint not null
);
create index digest_log_thing_idx on public.digest_log (thing_id, at desc);
alter table public.digest_log enable row level security;
revoke all on public.digest_log from public, anon, authenticated;
grant select, insert on public.digest_log to service_role;
grant usage on sequence public.digest_log_id_seq to service_role;

-- the cleared, professional talk about a thing (on the thing, or on one of its uses)
create function public.aua_digest_talk_ids(p_thing text) returns table (id text, key text, t bigint, rec jsonb, created_at timestamptz)
language sql stable as $$
  select t.id, t.key, t.t, t.rec, t.created_at
    from public.talk t join public.talk_canary c on c.talk_id = t.id
   where c.state = 1 and t.kind <> 5
     and (t.about_thing = p_thing or t.about_use in (select u.id from public.use u where u.thing_id = p_thing))
$$;

create function public.aua_digest_todo(p_lim int) returns jsonb language sql stable as $$
  with th as (
    select th.id, th.addr, th.iface,
           (select count(*) from public.aua_digest_talk_ids(th.id)) as talk_n,
           (select count(*) from public.use u where u.thing_id = th.id and u.code = 2) as fail,
           (select l.at from public.digest_log l where l.thing_id = th.id order by l.at desc limit 1) as last_at,
           (select l.fail from public.digest_log l where l.thing_id = th.id order by l.at desc limit 1) as last_fail
      from public.thing th
     where not exists (select 1 from public.wind_flag f where f.thing_id = th.id and f.cleared_at is null)
       and coalesce((select w.result from public.wind_check w where w.thing_id = th.id order by w.at desc, w.id desc limit 1), 0) = 0
  ), due as (
    select * from th
     where talk_n >= public.aua_knob('digest_min_talk')
       and (last_at is null
            or (select count(*) from public.aua_digest_talk_ids(th.id) x where x.created_at > th.last_at) >= public.aua_knob('digest_min_talk')
            or fail > last_fail)
  ), grp as (
    -- the thing's most used call, read-only uses only (effect >= 1 never gets a stub that passes the sandbox)
    select distinct on (u.thing_id) u.thing_id, u.task, u.op, u.cin, u.cout, count(*) as n
      from public.use u where u.thing_id in (select id from due)
     group by u.thing_id, u.task, u.op, u.cin, u.cout
    having max(u.effect) = 0
     order by u.thing_id, count(*) desc, u.task
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'thing', d.id, 'addr', d.addr, 'iface', d.iface, 'fail', d.fail, 'talk_n', d.talk_n,
           'task', g.task, 'op', g.op, 'cin', g.cin, 'cout', g.cout,
           'talk', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'text', x.rec->>'text') order by x.w desc, x.t desc, x.id), '[]')
                      from (select y.*, public.aua_talk_w(y.key) as w from public.aua_digest_talk_ids(d.id) y
                             order by public.aua_talk_w(y.key) desc, y.t desc, y.id limit 5) x)
         ) order by d.last_at nulls first, d.id), '[]')
    from (select * from due order by last_at nulls first, id limit greatest(p_lim, 0)) d join grp g on g.thing_id = d.id
$$;

create function public.aua_digest_log(p_thing text, p_outcome int, p_use text, p_fail bigint, p_talk_n bigint) returns boolean language sql as $$
  insert into public.digest_log (thing_id, outcome, use_id, fail, talk_n) values (p_thing, p_outcome, p_use, p_fail, p_talk_n) returning true
$$;
create function public.aua_digest_today() returns bigint language sql stable as $$
  select count(*) from public.digest_log where at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
$$;

revoke execute on function public.aua_digest_talk_ids(text), public.aua_digest_todo(int), public.aua_digest_log(text, int, text, bigint, bigint),
  public.aua_digest_today() from public, anon, authenticated;
grant execute on function public.aua_digest_talk_ids(text), public.aua_digest_todo(int), public.aua_digest_log(text, int, text, bigint, bigint),
  public.aua_digest_today() to service_role;
