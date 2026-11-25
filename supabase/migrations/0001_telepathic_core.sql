-- Telepathic teleprompter: library sync keyed by a secret device-generated key.
-- Tables are locked down (RLS on, no policies); all access goes through the functions below.

create table public.tp_libraries (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table public.tp_scripts (
  library_id uuid not null references public.tp_libraries(id) on delete cascade,
  id uuid not null,
  title text not null default '',
  body text not null default '',
  folder text not null default '',
  pinned boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  client_updated_at timestamptz not null,
  server_updated_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default now(),
  primary key (library_id, id)
);
create index tp_scripts_pull_idx on public.tp_scripts (library_id, server_updated_at);

create table public.tp_versions (
  id bigint generated always as identity primary key,
  library_id uuid not null,
  script_id uuid not null,
  title text not null default '',
  body text not null default '',
  saved_at timestamptz not null default now(),
  foreign key (library_id, script_id) references public.tp_scripts(library_id, id) on delete cascade
);
create index tp_versions_script_idx on public.tp_versions (library_id, script_id, saved_at desc);

create table public.tp_pairings (
  code text primary key,
  library_key text not null,
  expires_at timestamptz not null
);

alter table public.tp_libraries enable row level security;
alter table public.tp_scripts   enable row level security;
alter table public.tp_versions  enable row level security;
alter table public.tp_pairings  enable row level security;

revoke all on public.tp_libraries, public.tp_scripts, public.tp_versions, public.tp_pairings from anon, authenticated;

-- Internal: resolve (optionally create) a library from its secret key.
create or replace function public.tp_lib(p_key text, p_create boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_id uuid;
begin
  if p_key is null or length(p_key) < 32 or length(p_key) > 128 then
    raise exception 'invalid library key';
  end if;
  v_hash := encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
  select id into v_id from public.tp_libraries where key_hash = v_hash;
  if v_id is null and p_create then
    insert into public.tp_libraries (key_hash) values (v_hash)
    on conflict (key_hash) do update set last_seen = now()
    returning id into v_id;
  elsif v_id is not null then
    update public.tp_libraries set last_seen = now() where id = v_id and last_seen < now() - interval '1 hour';
  end if;
  return v_id;
end;
$$;

-- Push a batch of scripts. Last write wins on the client edit timestamp.
create or replace function public.tp_push(p_key text, p_scripts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lib uuid;
  v_item jsonb;
  v_id uuid;
  v_old public.tp_scripts%rowtype;
  v_ts timestamptz;
  v_body text;
  v_title text;
  v_applied int := 0;
  v_count int;
begin
  v_lib := public.tp_lib(p_key, true);
  if p_scripts is null or jsonb_typeof(p_scripts) <> 'array' then
    raise exception 'scripts must be an array';
  end if;
  if jsonb_array_length(p_scripts) > 200 then
    raise exception 'too many scripts in one push';
  end if;
  select count(*) into v_count from public.tp_scripts where library_id = v_lib;
  if v_count > 5000 then
    raise exception 'library is full';
  end if;

  for v_item in select * from jsonb_array_elements(p_scripts) loop
    v_id := (v_item->>'id')::uuid;
    v_ts := least((v_item->>'updated_at')::timestamptz, now() + interval '5 minutes');
    v_body := coalesce(v_item->>'body', '');
    v_title := left(coalesce(v_item->>'title', ''), 300);
    if length(v_body) > 600000 then
      raise exception 'script too large';
    end if;

    select * into v_old from public.tp_scripts where library_id = v_lib and id = v_id for update;
    if not found then
      insert into public.tp_scripts (library_id, id, title, body, folder, pinned, settings, deleted, client_updated_at, server_updated_at, created_at)
      values (
        v_lib, v_id, v_title, v_body,
        left(coalesce(v_item->>'folder', ''), 120),
        coalesce((v_item->>'pinned')::boolean, false),
        coalesce(v_item->'settings', '{}'::jsonb),
        coalesce((v_item->>'deleted')::boolean, false),
        v_ts, clock_timestamp(),
        coalesce((v_item->>'created_at')::timestamptz, now())
      );
      v_applied := v_applied + 1;
    elsif v_ts > v_old.client_updated_at then
      -- keep a restore point of the previous text, at most one per 5 minutes per script
      if v_old.body is distinct from v_body and length(v_old.body) > 0 and not exists (
        select 1 from public.tp_versions
        where library_id = v_lib and script_id = v_id and saved_at > now() - interval '5 minutes'
      ) then
        insert into public.tp_versions (library_id, script_id, title, body)
        values (v_lib, v_id, v_old.title, v_old.body);
        delete from public.tp_versions
        where library_id = v_lib and script_id = v_id
          and id not in (
            select id from public.tp_versions
            where library_id = v_lib and script_id = v_id
            order by saved_at desc limit 30
          );
      end if;
      update public.tp_scripts set
        title = v_title,
        body = v_body,
        folder = left(coalesce(v_item->>'folder', ''), 120),
        pinned = coalesce((v_item->>'pinned')::boolean, false),
        settings = coalesce(v_item->'settings', '{}'::jsonb),
        deleted = coalesce((v_item->>'deleted')::boolean, false),
        client_updated_at = v_ts,
        server_updated_at = clock_timestamp()
      where library_id = v_lib and id = v_id;
      v_applied := v_applied + 1;
    end if;
  end loop;

  return jsonb_build_object('applied', v_applied, 'now', clock_timestamp());
end;
$$;

-- Pull everything changed since a server timestamp.
create or replace function public.tp_pull(p_key text, p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lib uuid;
  v_rows jsonb;
begin
  v_lib := public.tp_lib(p_key, false);
  if v_lib is null then
    return jsonb_build_object('now', clock_timestamp(), 'scripts', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'body', s.body, 'folder', s.folder,
      'pinned', s.pinned, 'settings', s.settings, 'deleted', s.deleted,
      'updated_at', s.client_updated_at, 'server_updated_at', s.server_updated_at,
      'created_at', s.created_at
    ) order by s.server_updated_at), '[]'::jsonb)
  into v_rows
  from public.tp_scripts s
  where s.library_id = v_lib
    and (p_since is null or s.server_updated_at > p_since);
  return jsonb_build_object('now', clock_timestamp(), 'scripts', v_rows);
end;
$$;

-- Restore points for one script.
create or replace function public.tp_versions_list(p_key text, p_script_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lib uuid;
  v_rows jsonb;
begin
  v_lib := public.tp_lib(p_key, false);
  if v_lib is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'title', v.title, 'body', v.body, 'saved_at', v.saved_at
    ) order by v.saved_at desc), '[]'::jsonb)
  into v_rows
  from public.tp_versions v
  where v.library_id = v_lib and v.script_id = p_script_id;
  return v_rows;
end;
$$;

-- Short-lived, single-use code so a second device can join the same library.
create or replace function public.tp_pair_create(p_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text := '';
  i int;
begin
  perform public.tp_lib(p_key, true);
  delete from public.tp_pairings where expires_at < now();
  loop
    v_bytes := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
    v_code := '';
    -- use only fully random bytes (skip the uuid version/variant bytes at offsets 6 and 8)
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, case when i < 4 then i else i + 12 end) % 31) + 1, 1);
    end loop;
    begin
      insert into public.tp_pairings (code, library_key, expires_at)
      values (v_code, p_key, now() + interval '10 minutes');
      exit;
    exception when unique_violation then
      null; -- extremely unlikely; try another code
    end;
  end loop;
  return v_code;
end;
$$;

create or replace function public.tp_pair_claim(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_key text;
begin
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(v_code) <> 8 then
    return null;
  end if;
  delete from public.tp_pairings
  where code = v_code and expires_at > now()
  returning library_key into v_key;
  return v_key;
end;
$$;

revoke all on function public.tp_lib(text, boolean) from public, anon, authenticated;
revoke all on function public.tp_push(text, jsonb) from public;
revoke all on function public.tp_pull(text, timestamptz) from public;
revoke all on function public.tp_versions_list(text, uuid) from public;
revoke all on function public.tp_pair_create(text) from public;
revoke all on function public.tp_pair_claim(text) from public;
grant execute on function public.tp_push(text, jsonb) to anon, authenticated;
grant execute on function public.tp_pull(text, timestamptz) to anon, authenticated;
grant execute on function public.tp_versions_list(text, uuid) to anon, authenticated;
grant execute on function public.tp_pair_create(text) to anon, authenticated;
grant execute on function public.tp_pair_claim(text) to anon, authenticated;
