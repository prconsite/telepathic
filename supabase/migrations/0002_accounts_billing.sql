-- Telepathic accounts and billing.
-- A signed-in user (Supabase Auth, email one-time code) owns exactly one library.
-- Subscription state is written only by the billing Edge Function (service role) from Stripe webhooks.
-- The app never reads these tables directly: everything goes through the tp_* functions below.

create table public.tp_settings (
  key text primary key,
  value jsonb not null
);
insert into public.tp_settings (key, value) values
  ('billing_enforced', 'false'::jsonb),      -- false: every signed-in user has sync. true: needs a subscription or a grant.
  ('allow_key_libraries', 'true'::jsonb);    -- true: pairing-code libraries (no account) keep working.

alter table public.tp_libraries alter column key_hash drop not null;
alter table public.tp_libraries add column owner uuid unique references auth.users(id) on delete cascade;
alter table public.tp_libraries add column room text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
alter table public.tp_libraries add constraint tp_libraries_identity check (key_hash is not null or owner is not null);

create table public.tp_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

create table public.tp_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_subscription_id text unique,
  status text not null,
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  disputed boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Complimentary access, by verified sign-in email (lower case).
create table public.tp_grants (
  email text primary key check (email = lower(email)),
  note text not null default '',
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- Audit trail of billing events that need a human eye (disputes, refunds, fraud warnings).
create table public.tp_billing_events (
  id text primary key,
  user_id uuid,
  type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tp_settings       enable row level security;
alter table public.tp_customers      enable row level security;
alter table public.tp_subscriptions  enable row level security;
alter table public.tp_grants         enable row level security;
alter table public.tp_billing_events enable row level security;
revoke all on public.tp_settings, public.tp_customers, public.tp_subscriptions, public.tp_grants, public.tp_billing_events from anon, authenticated;

-- ---------- internals ----------

create or replace function public.tp_flag(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select value = 'true'::jsonb from public.tp_settings where key = p_key), false);
$$;

create or replace function public.tp_has_access(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user is not null and (
      not public.tp_flag('billing_enforced')
      or exists (
        select 1 from public.tp_grants g
        join auth.users u on lower(u.email) = g.email
        where u.id = p_user and (g.expires_at is null or g.expires_at > now())
      )
      or exists (
        select 1 from public.tp_subscriptions s
        where s.user_id = p_user and not s.disputed and s.status in ('active', 'trialing', 'past_due')
      )
    );
$$;

-- The signed-in user's library. Raises if not signed in or not entitled.
create or replace function public.tp_my_lib(p_create boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'sign_in_required';
  end if;
  if not public.tp_has_access(v_uid) then
    raise exception 'subscription_required';
  end if;
  select id into v_id from public.tp_libraries where owner = v_uid;
  if v_id is null and p_create then
    insert into public.tp_libraries (owner) values (v_uid)
    on conflict (owner) do update set last_seen = now()
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

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
  if not public.tp_flag('allow_key_libraries') then
    raise exception 'pairing_closed';
  end if;
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

create or replace function public.tp_push_lib(v_lib uuid, p_scripts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_id uuid;
  v_old public.tp_scripts%rowtype;
  v_ts timestamptz;
  v_body text;
  v_title text;
  v_applied int := 0;
  v_count int;
begin
  if v_lib is null then
    raise exception 'no library';
  end if;
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

create or replace function public.tp_pull_lib(v_lib uuid, p_since timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
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

create or replace function public.tp_versions_lib(v_lib uuid, p_script_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
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

-- ---------- pairing-code libraries (unchanged behaviour, now thin wrappers) ----------

create or replace function public.tp_push(p_key text, p_scripts jsonb)
returns jsonb language sql security definer set search_path = ''
as $$ select public.tp_push_lib(public.tp_lib(p_key, true), p_scripts); $$;

create or replace function public.tp_pull(p_key text, p_since timestamptz default null)
returns jsonb language sql security definer set search_path = ''
as $$ select public.tp_pull_lib(public.tp_lib(p_key, false), p_since); $$;

create or replace function public.tp_versions_list(p_key text, p_script_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select public.tp_versions_lib(public.tp_lib(p_key, false), p_script_id); $$;

-- ---------- account libraries ----------

create or replace function public.tp_acct_push(p_scripts jsonb)
returns jsonb language sql security definer set search_path = ''
as $$ select public.tp_push_lib(public.tp_my_lib(true), p_scripts); $$;

create or replace function public.tp_acct_pull(p_since timestamptz default null)
returns jsonb language sql security definer set search_path = ''
as $$ select public.tp_pull_lib(public.tp_my_lib(false), p_since); $$;

create or replace function public.tp_acct_versions(p_script_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select public.tp_versions_lib(public.tp_my_lib(false), p_script_id); $$;

-- What the app shows on the account card, and whether sync is allowed.
create or replace function public.tp_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_enforced boolean := public.tp_flag('billing_enforced');
  v_access boolean;
  v_comp boolean;
  v_sub public.tp_subscriptions%rowtype;
  v_room text;
  v_lib uuid;
begin
  if v_uid is null then
    raise exception 'sign_in_required';
  end if;
  v_access := public.tp_has_access(v_uid);
  select exists (
    select 1 from public.tp_grants g join auth.users u on lower(u.email) = g.email
    where u.id = v_uid and (g.expires_at is null or g.expires_at > now())
  ) into v_comp;
  select * into v_sub from public.tp_subscriptions where user_id = v_uid;
  if v_access then
    v_lib := public.tp_my_lib(true); -- separate statement, so the row it may create is visible below
    select room into v_room from public.tp_libraries where id = v_lib;
  end if;
  return jsonb_build_object(
    'user_id', v_uid,
    'billing_enforced', v_enforced,
    'access', v_access,
    'plan', case
      when v_comp then 'comp'
      when v_sub.user_id is not null and not v_sub.disputed and v_sub.status in ('active', 'trialing', 'past_due') then 'plus'
      when not v_enforced then 'included'
      else 'none' end,
    'status', v_sub.status,
    'current_period_end', v_sub.current_period_end,
    'cancel_at_period_end', coalesce(v_sub.cancel_at_period_end, false),
    'disputed', coalesce(v_sub.disputed, false),
    'had_subscription', v_sub.user_id is not null,
    'room', v_room
  );
end;
$$;

-- ---------- privileges ----------

revoke all on function public.tp_flag(text) from public, anon, authenticated;
revoke all on function public.tp_has_access(uuid) from public, anon, authenticated;
revoke all on function public.tp_my_lib(boolean) from public, anon, authenticated;
revoke all on function public.tp_lib(text, boolean) from public, anon, authenticated;
revoke all on function public.tp_push_lib(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.tp_pull_lib(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.tp_versions_lib(uuid, uuid) from public, anon, authenticated;

revoke all on function public.tp_acct_push(jsonb) from public, anon;
revoke all on function public.tp_acct_pull(timestamptz) from public, anon;
revoke all on function public.tp_acct_versions(uuid) from public, anon;
revoke all on function public.tp_account() from public, anon;
grant execute on function public.tp_acct_push(jsonb) to authenticated;
grant execute on function public.tp_acct_pull(timestamptz) to authenticated;
grant execute on function public.tp_acct_versions(uuid) to authenticated;
grant execute on function public.tp_account() to authenticated;
