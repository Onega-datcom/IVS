-- Face-verify database (Supabase / PostgreSQL)
-- Run: Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--
-- Security model: every table is locked (RLS on, no policies, no grants).
-- The browser can only call the iv_* functions at the bottom. They check the
-- session token and the verification step on the SERVER, so steps cannot be
-- skipped from the browser. Tables use the "iv_" prefix so they never clash
-- with your POS tables.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables
create table if not exists iv_roles (
  key   text primary key,
  label text not null,
  sort  int  not null default 0
);
insert into iv_roles (key, label, sort) values
  ('admin',       'Admin',                  1),
  ('receptionist','Receptionist',           2),
  ('manager',     'Manager',                3),
  ('inventory',   'Inventory Staff',        4),
  ('kitchen',     'Chef / Kitchen Staff',   5)
on conflict (key) do nothing;          -- the 5 roles of the system; keep the key 'admin' (approvals depend on it)

create table if not exists iv_users (
  id              bigint generated always as identity primary key,
  email           text not null unique,
  pin_hash        text not null,
  requested_role  text not null references iv_roles(key),
  role            text references iv_roles(key),
  status          text not null default 'unverified'
                  check (status in ('unverified','pending','active','rejected')),
  verify_step     smallint not null default 0,      -- 0 account, 1 ID ok, 2 face ok, 3 info saved
  id_attempts     smallint not null default 0,
  face_attempts   smallint not null default 0,
  pin_fails       smallint not null default 0,
  locked_until    timestamptz,                      -- lock for ID / face steps
  pin_locked_until timestamptz,                     -- lock for PIN login
  consent_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create table if not exists iv_id_records (
  user_id        bigint primary key references iv_users(id) on delete cascade,
  id_type        text not null,
  id_number      text not null,
  full_name      text not null,
  dob            date not null,
  address        text,
  expiry         date,
  ocr_confidence real,
  ocr_raw        jsonb,
  id_descriptor  real[] not null,                   -- 128-number face template of the ID photo
  face_ok        boolean not null default false,
  face_distance  real,
  final_status   text not null default 'incomplete' check (final_status in ('incomplete','verified','failed')),
  updated_at     timestamptz not null default now()
);

create table if not exists iv_faces (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references iv_users(id) on delete cascade,
  pose       text not null,
  descriptor real[] not null                        -- templates only, no photos
);

create table if not exists iv_logs (
  id         bigint generated always as identity primary key,
  user_id    bigint,
  step       text not null,
  result     text not null,
  score      real,
  note       text default '',
  created_at timestamptz not null default now()
);

create table if not exists iv_approvals (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references iv_users(id) on delete cascade,
  approved_by   bigint not null,
  role_assigned text,
  decision      text not null check (decision in ('approved','rejected')),
  reason        text default '',
  created_at    timestamptz not null default now()
);

create table if not exists iv_sessions (
  token_hash text primary key,
  user_id    bigint not null references iv_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists iv_signup_drafts (
  id              bigint generated always as identity primary key,
  email           text not null unique,
  pin_hash        text not null,
  requested_role  text not null references iv_roles(key),
  verify_step     smallint not null default 0,
  id_attempts     smallint not null default 0,
  face_attempts   smallint not null default 0,
  pin_fails       smallint not null default 0,
  locked_until    timestamptz,
  pin_locked_until timestamptz,
  consent_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  id_type         text,
  id_number       text,
  full_name       text,
  dob             date,
  address         text,
  expiry          date,
  ocr_confidence  real,
  ocr_raw         jsonb,
  id_descriptor   real[],
  face_ok         boolean not null default false,
  face_distance   real,
  face_frames     jsonb not null default '[]'::jsonb
);

create table if not exists iv_signup_draft_sessions (
  token_hash text primary key,
  draft_id   bigint not null references iv_signup_drafts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Move registrations created by older versions out of iv_users while preserving progress.
do $$
declare u record; r iv_id_records; draft_id bigint;
begin
  for u in select * from iv_users where status = 'unverified' loop
    select * into r from iv_id_records where user_id = u.id;
    insert into iv_signup_drafts (
      email, pin_hash, requested_role, verify_step, id_attempts, face_attempts, pin_fails,
      locked_until, pin_locked_until, consent_at, created_at, id_type, id_number, full_name,
      dob, address, expiry, ocr_confidence, ocr_raw, id_descriptor, face_ok, face_distance,
      face_frames
    ) values (
      u.email, u.pin_hash, u.requested_role, u.verify_step, u.id_attempts, u.face_attempts, u.pin_fails,
      u.locked_until, u.pin_locked_until, u.consent_at, u.created_at, r.id_type, r.id_number, r.full_name,
      r.dob, r.address, r.expiry, r.ocr_confidence, r.ocr_raw, r.id_descriptor, coalesce(r.face_ok, false),
      r.face_distance,
      coalesce((select jsonb_agg(jsonb_build_object('pose', f.pose, 'descriptor', to_jsonb(f.descriptor)) order by f.id)
                from iv_faces f where f.user_id = u.id), '[]'::jsonb)
    ) on conflict (email) do nothing returning id into draft_id;
    if draft_id is null then
      select id into draft_id from iv_signup_drafts where email = u.email;
    end if;
    insert into iv_signup_draft_sessions (token_hash, draft_id, expires_at, created_at)
      select token_hash, draft_id, expires_at, created_at from iv_sessions where user_id = u.id
      on conflict (token_hash) do nothing;
    delete from iv_logs where user_id = u.id;
    delete from iv_users where id = u.id;
  end loop;
end $$;

alter table iv_roles        enable row level security;
alter table iv_users        enable row level security;
alter table iv_id_records   enable row level security;
alter table iv_faces        enable row level security;
alter table iv_logs         enable row level security;
alter table iv_approvals    enable row level security;
alter table iv_sessions     enable row level security;
alter table iv_signup_drafts enable row level security;
alter table iv_signup_draft_sessions enable row level security;
revoke all on iv_roles, iv_users, iv_id_records, iv_faces, iv_logs, iv_approvals, iv_sessions,
  iv_signup_drafts, iv_signup_draft_sessions from anon, authenticated;

-- ------------------------------------------------- internal helpers (not callable from the browser)
create or replace function iv_face_dist(a real[], b real[]) returns real
language sql immutable as $$
  select sqrt(sum((x - y) ^ 2))::real from unnest(a, b) as t(x, y)
$$;

create or replace function iv_json_to_vec(j jsonb) returns real[]
language sql immutable as $$
  select coalesce(array(select v::real from jsonb_array_elements_text(j) with ordinality as t(v, i) order by i), '{}')
$$;

create or replace function iv_fail(msg text, extra jsonb default '{}') returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'message', msg) || extra $$;

create or replace function iv_log(p_user bigint, p_step text, p_result text, p_score real, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into iv_logs (user_id, step, result, score, note) values (p_user, p_step, p_result, p_score, coalesce(p_note, ''))
$$;

create or replace function iv_user_from_token(p_token text) returns iv_users
language sql stable security definer set search_path = public, extensions as $$
  select u.* from iv_sessions s join iv_users u on u.id = s.user_id
  where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires_at > now()
$$;

create or replace function iv_new_session(p_user bigint) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := encode(gen_random_bytes(32), 'hex');
begin
  delete from iv_sessions where expires_at < now();
  insert into iv_sessions (token_hash, user_id, expires_at)
  values (encode(digest(t, 'sha256'), 'hex'), p_user, now() + interval '8 hours');
  return t;
end $$;

create or replace function iv_draft_from_token(p_token text) returns iv_signup_drafts
language sql stable security definer set search_path = public, extensions as $$
  select d.* from iv_signup_draft_sessions s join iv_signup_drafts d on d.id = s.draft_id
  where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires_at > now()
$$;

create or replace function iv_new_draft_session(p_draft bigint) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := encode(gen_random_bytes(32), 'hex');
begin
  delete from iv_signup_draft_sessions where expires_at < now();
  insert into iv_signup_draft_sessions (token_hash, draft_id, expires_at)
  values (encode(digest(t, 'sha256'), 'hex'), p_draft, now() + interval '8 hours');
  return t;
end $$;

create or replace function iv_lock_msg(u iv_users) returns text
language sql stable set search_path = public as $$
  select case when u.locked_until is not null and u.locked_until > now()
    then 'Too many failed attempts. Try again after ' || to_char(u.locked_until at time zone 'Asia/Manila', 'HH12:MI AM') || '.' end
$$;

revoke execute on function iv_face_dist(real[], real[]), iv_json_to_vec(jsonb), iv_fail(text, jsonb),
  iv_log(bigint, text, text, real, text), iv_user_from_token(text), iv_new_session(bigint),
  iv_draft_from_token(text), iv_new_draft_session(bigint), iv_lock_msg(iv_users)
  from public, anon, authenticated;

-- ------------------------------------------------- public functions (the only door for the browser)
create or replace function iv_list_roles() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'label', label) order by sort), '[]'::jsonb) from iv_roles
$$;

create or replace function iv_signup(p_email text, p_pin text, p_role text, p_consent boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare uid bigint; em text := lower(trim(coalesce(p_email, ''))); existing iv_users; draft iv_signup_drafts;
begin
  if not coalesce(p_consent, false) then return iv_fail('You must agree to the consent notice to continue.'); end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return iv_fail('Enter a valid email address.'); end if;
  if coalesce(p_pin, '') !~ '^\d{6}$' then return iv_fail('The backup PIN must be exactly 6 digits.'); end if;
  if not exists (select 1 from iv_roles where key = p_role) then return iv_fail('Choose the role you are applying for.'); end if;
  select * into existing from iv_users where email = em;
  if existing.id is not null then
    if existing.status = 'unverified' and existing.pin_hash = crypt(p_pin, existing.pin_hash) then
      perform iv_log(existing.id, 'signup', 'resumed', null, '');
      return jsonb_build_object('ok', true, 'token', iv_new_session(existing.id), 'resumed', true);
    end if;
    return iv_fail('This email is already registered. Use the PIN option on the login page to continue.');
  end if;
  select * into draft from iv_signup_drafts where email = em;
  if draft.id is not null then
    if draft.pin_hash = crypt(p_pin, draft.pin_hash) then
      return jsonb_build_object('ok', true, 'token', iv_new_draft_session(draft.id), 'resumed', true);
    end if;
    return iv_fail('This email already has an unfinished registration. Enter the same PIN to resume it.');
  end if;
  insert into iv_signup_drafts (email, pin_hash, requested_role)
  values (em, crypt(p_pin, gen_salt('bf')), p_role) returning id into uid;
  return jsonb_build_object('ok', true, 'token', iv_new_draft_session(uid));
end $$;

create or replace function iv_cancel_signup(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; draft iv_signup_drafts;
begin
  select * into draft from iv_draft_from_token(p_token);
  if draft.id is not null then
    delete from iv_signup_drafts where id = draft.id;
    return jsonb_build_object('ok', true);
  end if;
  select x.* into u
  from iv_sessions s join iv_users x on x.id = s.user_id
  where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and s.expires_at > now()
  for update of x;
  if u.id is null then return iv_fail('Session expired. Log in again to resume or cancel your registration.'); end if;
  if u.status <> 'unverified' or u.verify_step >= 3 then
    return iv_fail('This registration has already been submitted and cannot be cancelled here.');
  end if;
  delete from iv_logs where user_id = u.id;
  delete from iv_users where id = u.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function iv_pin_login(p_email text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; draft iv_signup_drafts;
begin
  select * into u from iv_users where email = lower(trim(coalesce(p_email, '')));
  if u.id is null then
    select * into draft from iv_signup_drafts where email = lower(trim(coalesce(p_email, '')));
    if draft.id is not null and draft.pin_locked_until is not null and draft.pin_locked_until > now() then
      return iv_fail('Too many tries. Wait a few minutes and try again.');
    end if;
    if draft.id is null or draft.pin_hash <> crypt(coalesce(p_pin, ''), draft.pin_hash) then
      if draft.id is not null then
        update iv_signup_drafts set pin_fails = case when pin_fails >= 4 then 0 else pin_fails + 1 end,
          pin_locked_until = case when pin_fails >= 4 then now() + interval '15 minutes' else pin_locked_until end
        where id = draft.id;
      end if;
      return iv_fail('Email or PIN is incorrect.');
    end if;
    update iv_signup_drafts set pin_fails = 0 where id = draft.id;
    return jsonb_build_object('ok', true, 'token', iv_new_draft_session(draft.id));
  end if;
  if u.id is not null and u.pin_locked_until is not null and u.pin_locked_until > now() then
    return iv_fail('Too many tries. Wait a few minutes and try again.');
  end if;
  if u.id is null or u.pin_hash <> crypt(coalesce(p_pin, ''), u.pin_hash) then
    if u.id is not null then
      update iv_users set pin_fails = case when pin_fails >= 4 then 0 else pin_fails + 1 end,
                          pin_locked_until = case when pin_fails >= 4 then now() + interval '15 minutes' else pin_locked_until end
      where id = u.id;
    end if;
    return iv_fail('Email or PIN is incorrect.');
  end if;
  if u.status = 'pending'  then return iv_fail('Your account is waiting for admin approval.'); end if;
  if u.status = 'rejected' then return iv_fail('Your registration was rejected. Contact the admin.'); end if;
  update iv_users set pin_fails = 0 where id = u.id;
  perform iv_log(u.id, 'login_pin', 'success', null, '');
  return jsonb_build_object('ok', true, 'token', iv_new_session(u.id));
end $$;

create or replace function iv_me(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; draft iv_signup_drafts; r iv_id_records;
begin
  select * into u from iv_user_from_token(p_token);
  if u.id is null then
    select * into draft from iv_draft_from_token(p_token);
    if draft.id is null then return iv_fail('Session expired.'); end if;
    return jsonb_build_object('ok', true, 'id', draft.id, 'email', draft.email, 'role', null,
      'requested_role', draft.requested_role, 'status', 'unverified', 'verify_step', draft.verify_step,
      'locked_until', draft.locked_until, 'full_name', draft.full_name, 'id_type', draft.id_type,
      'id_number', draft.id_number, 'face_distance', draft.face_distance);
  end if;
  select * into r from iv_id_records where user_id = u.id;
  return jsonb_build_object('ok', true, 'id', u.id, 'email', u.email, 'role', u.role, 'requested_role', u.requested_role,
    'status', u.status, 'verify_step', u.verify_step, 'locked_until', u.locked_until,
    'full_name', r.full_name, 'id_type', r.id_type, 'id_number', r.id_number, 'face_distance', r.face_distance);
end $$;

create or replace function iv_report_failure(p_token text, p_kind text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; draft iv_signup_drafts; n smallint;
begin
  select * into u from iv_user_from_token(p_token);
  if u.id is null then
    select * into draft from iv_draft_from_token(p_token);
    if draft.id is null then return iv_fail('Session expired.'); end if;
    if draft.locked_until is not null and draft.locked_until > now() then
      return iv_fail('Too many failed attempts. Try again later.', '{"locked": true}');
    end if;
    if p_kind = 'id' then
      update iv_signup_drafts set id_attempts = id_attempts + 1 where id = draft.id returning id_attempts into n;
    elsif p_kind = 'face' then
      update iv_signup_drafts set face_attempts = face_attempts + 1 where id = draft.id returning face_attempts into n;
    else
      return iv_fail('Unknown step.');
    end if;
    if n >= 3 then
      update iv_signup_drafts set id_attempts = 0, face_attempts = 0,
        locked_until = now() + interval '15 minutes' where id = draft.id;
      return jsonb_build_object('ok', true, 'attempts_left', 0, 'locked', true);
    end if;
    return jsonb_build_object('ok', true, 'attempts_left', 3 - n, 'locked', false);
  end if;
  if u.status <> 'unverified' then return iv_fail('Session expired.'); end if;
  if p_kind = 'id' then
    update iv_users set id_attempts = id_attempts + 1 where id = u.id returning id_attempts into n;
  elsif p_kind = 'face' then
    update iv_users set face_attempts = face_attempts + 1 where id = u.id returning face_attempts into n;
  else
    return iv_fail('Unknown step.');
  end if;
  if n >= 3 then
    update iv_users set id_attempts = 0, face_attempts = 0, locked_until = now() + interval '15 minutes' where id = u.id;
    return jsonb_build_object('ok', true, 'attempts_left', 0, 'locked', true);
  end if;
  return jsonb_build_object('ok', true, 'attempts_left', 3 - n, 'locked', false);
end $$;

create or replace function iv_save_id(p_token text, p_id_type text, p_fields jsonb, p_confidence real, p_descriptor real[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; draft iv_signup_drafts; lm text;
begin
  select * into draft from iv_draft_from_token(p_token);
  if draft.id is not null then
    if draft.locked_until is not null and draft.locked_until > now() then
      return iv_fail('Too many failed attempts. Try again later.', '{"locked": true}');
    end if;
    if p_id_type not in ('philid', 'drivers', 'passport', 'umid') then return iv_fail('Choose a supported ID type.'); end if;
    if coalesce(p_fields->>'full_name', '') = '' or coalesce(p_fields->>'dob', '') = '' or coalesce(p_fields->>'id_number', '') = '' then
      return iv_fail('Required ID details are missing.');
    end if;
    if array_length(p_descriptor, 1) is distinct from 128 then return iv_fail('No face template was received from the ID photo.'); end if;
    if exists (select 1 from iv_id_records where id_number = p_fields->>'id_number')
       or exists (select 1 from iv_signup_drafts where id_number = p_fields->>'id_number' and id <> draft.id) then
      return iv_fail('This ID is already registered to another account.');
    end if;
    update iv_signup_drafts set
      id_type = p_id_type, id_number = p_fields->>'id_number', full_name = p_fields->>'full_name',
      dob = (p_fields->>'dob')::date, address = nullif(p_fields->>'address', ''),
      expiry = nullif(p_fields->>'expiry', '')::date, ocr_confidence = p_confidence, ocr_raw = p_fields,
      id_descriptor = p_descriptor, face_ok = false, face_distance = null, face_frames = '[]'::jsonb,
      verify_step = 1, id_attempts = 0, face_attempts = 0
    where id = draft.id;
    return jsonb_build_object('ok', true);
  end if;
  select * into u from iv_user_from_token(p_token);
  if u.id is null or u.status <> 'unverified' then return iv_fail('Session expired. Log in again.'); end if;
  lm := iv_lock_msg(u);
  if lm is not null then return iv_fail(lm, '{"locked": true}'); end if;
  if p_id_type not in ('philid', 'drivers', 'passport', 'umid') then return iv_fail('Choose a supported ID type.'); end if;
  if coalesce(p_fields->>'full_name', '') = '' or coalesce(p_fields->>'dob', '') = '' or coalesce(p_fields->>'id_number', '') = '' then
    return iv_fail('Required ID details are missing.');
  end if;
  if array_length(p_descriptor, 1) is distinct from 128 then return iv_fail('No face template was received from the ID photo.'); end if;
  if exists (select 1 from iv_id_records where id_number = p_fields->>'id_number' and user_id <> u.id) then
    return iv_fail('This ID is already registered to another account.');
  end if;
  insert into iv_id_records (user_id, id_type, id_number, full_name, dob, address, expiry, ocr_confidence, ocr_raw, id_descriptor)
  values (u.id, p_id_type, p_fields->>'id_number', p_fields->>'full_name', (p_fields->>'dob')::date,
          nullif(p_fields->>'address', ''), nullif(p_fields->>'expiry', '')::date, p_confidence, p_fields, p_descriptor)
  on conflict (user_id) do update set
    id_type = excluded.id_type, id_number = excluded.id_number, full_name = excluded.full_name, dob = excluded.dob,
    address = excluded.address, expiry = excluded.expiry, ocr_confidence = excluded.ocr_confidence, ocr_raw = excluded.ocr_raw,
    id_descriptor = excluded.id_descriptor, face_ok = false, face_distance = null, final_status = 'incomplete', updated_at = now();
  delete from iv_faces where user_id = u.id;                    -- new ID means redo the face step
  update iv_users set verify_step = 1, id_attempts = 0 where id = u.id;
  perform iv_log(u.id, 'id_scan', 'success', p_confidence, p_id_type);
  return jsonb_build_object('ok', true);
end $$;

-- The match decision is made here: distance between the live faces and the ID photo.
-- 0.60 is the usual face-api threshold (lower = stricter). Tune with your test data.
create or replace function iv_save_face(p_token text, p_frames jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u iv_users; draft iv_signup_drafts; r iv_id_records; lm text; f jsonb; d real[]; sd real[];
  poses text[] := '{}'; pose text; total double precision := 0; n int := 0; avg_d real;
  match_max constant real := 0.60; same_max constant real := 0.80;
begin
  select * into draft from iv_draft_from_token(p_token);
  if draft.id is not null then
    if draft.verify_step < 1 or draft.id_descriptor is null then return iv_fail('Complete the ID scan first.'); end if;
    if draft.locked_until is not null and draft.locked_until > now() then
      return iv_fail('Too many failed attempts. Try again later.', '{"locked": true}');
    end if;
    if jsonb_typeof(p_frames) <> 'array' then
      return iv_fail('Incomplete capture. Repeat the face capture.');
    end if;
    if jsonb_array_length(p_frames) not between 4 and 5 then
      return iv_fail('Incomplete capture. Repeat the face capture.');
    end if;
    for f in select value from jsonb_array_elements(p_frames) loop
      pose := f->>'pose';
      d := iv_json_to_vec(f->'descriptor');
      if pose not in ('straight', 'left', 'right', 'closer', 'farther') or array_length(d, 1) is distinct from 128 then
        return iv_fail('Invalid capture data. Repeat the face capture.');
      end if;
      poses := poses || pose;
      if pose = 'straight' then sd := d; end if;
    end loop;
    if sd is null or (select count(distinct x) from unnest(poses) x) <> array_length(poses, 1) then
      return iv_fail('A straight-on capture is required. Repeat the face capture.');
    end if;
    for f in select value from jsonb_array_elements(p_frames) loop
      pose := f->>'pose';
      d := iv_json_to_vec(f->'descriptor');
      if iv_face_dist(d, sd) > same_max then
        return iv_fail('The captures do not look like the same person. Repeat the capture.');
      end if;
      if pose in ('straight', 'closer', 'farther') then
        total := total + iv_face_dist(d, draft.id_descriptor);
        n := n + 1;
      end if;
    end loop;
    if n = 0 then return iv_fail('A straight-on capture is required. Repeat the face capture.'); end if;
    avg_d := (total / n)::real;
    if avg_d > match_max then
      return iv_fail('Your face does not match the photo on the ID.');
    end if;
    update iv_signup_drafts set face_ok = true, face_distance = avg_d, face_frames = p_frames,
      verify_step = 2, face_attempts = 0 where id = draft.id;
    return jsonb_build_object('ok', true, 'distance', avg_d);
  end if;
  select * into u from iv_user_from_token(p_token);
  if u.id is null or u.status <> 'unverified' or u.verify_step < 1 then return iv_fail('Complete the ID scan first.'); end if;
  lm := iv_lock_msg(u);
  if lm is not null then return iv_fail(lm, '{"locked": true}'); end if;
  select * into r from iv_id_records where user_id = u.id;
  if r.user_id is null then return iv_fail('Complete the ID scan first.'); end if;
  if jsonb_typeof(p_frames) <> 'array' then
    return iv_fail('Incomplete capture. Repeat the face capture.');
  end if;
  if jsonb_array_length(p_frames) not between 4 and 5 then
    return iv_fail('Incomplete capture. Repeat the face capture.');
  end if;

  for f in select value from jsonb_array_elements(p_frames) loop
    pose := f->>'pose';
    d := iv_json_to_vec(f->'descriptor');
    if pose not in ('straight', 'left', 'right', 'closer', 'farther') or array_length(d, 1) is distinct from 128 then
      return iv_fail('Invalid capture data. Repeat the face capture.');
    end if;
    poses := poses || pose;
    if pose = 'straight' then sd := d; end if;
  end loop;
  if sd is null or (select count(distinct x) from unnest(poses) x) <> array_length(poses, 1) then
    return iv_fail('A straight-on capture is required. Repeat the face capture.');
  end if;

  for f in select value from jsonb_array_elements(p_frames) loop
    pose := f->>'pose';
    d := iv_json_to_vec(f->'descriptor');
    if iv_face_dist(d, sd) > same_max then
      return iv_fail('The captures do not look like the same person. Repeat the capture.');
    end if;
    if pose in ('straight', 'closer', 'farther') then
      total := total + iv_face_dist(d, r.id_descriptor);
      n := n + 1;
    end if;
  end loop;
  avg_d := (total / n)::real;

  if avg_d > match_max then
    perform iv_log(u.id, 'face_match', 'failed', avg_d, '');
    return iv_fail('Your face does not match the photo on the ID.');
  end if;

  delete from iv_faces where user_id = u.id;
  insert into iv_faces (user_id, pose, descriptor)
    select u.id, x->>'pose', iv_json_to_vec(x->'descriptor') from jsonb_array_elements(p_frames) x;
  update iv_id_records set face_ok = true, face_distance = avg_d where user_id = u.id;
  update iv_users set verify_step = 2, face_attempts = 0 where id = u.id;
  perform iv_log(u.id, 'face_match', 'success', avg_d, '');
  return jsonb_build_object('ok', true, 'distance', avg_d);
end $$;

create or replace function iv_get_record(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; draft iv_signup_drafts; r iv_id_records;
begin
  select * into draft from iv_draft_from_token(p_token);
  if draft.id is not null then
    if draft.verify_step < 2 or not draft.face_ok then
      return iv_fail('Complete the ID scan and face match first.');
    end if;
    return jsonb_build_object('ok', true, 'full_name', draft.full_name, 'dob', draft.dob,
      'address', draft.address, 'id_number', draft.id_number, 'expiry', draft.expiry, 'id_type', draft.id_type);
  end if;
  select * into u from iv_user_from_token(p_token);
  if u.id is null or u.status <> 'unverified' or u.verify_step < 2 then return iv_fail('Complete the ID scan and face match first.'); end if;
  select * into r from iv_id_records where user_id = u.id and face_ok;
  if r.user_id is null then return iv_fail('Complete the ID scan and face match first.'); end if;
  return jsonb_build_object('ok', true, 'full_name', r.full_name, 'dob', r.dob, 'address', r.address,
                            'id_number', r.id_number, 'expiry', r.expiry, 'id_type', r.id_type);
end $$;

create or replace function iv_save_info(p_token text, p_fields jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u iv_users; draft iv_signup_drafts; r iv_id_records; v_dob date; yrs int; new_user_id bigint;
  v_token_hash text := encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
begin
  select * into draft from iv_draft_from_token(p_token);
  if draft.id is not null then
    if draft.verify_step < 2 or not draft.face_ok or draft.id_descriptor is null then
      return iv_fail('Complete the ID scan and face match first.');
    end if;
    if coalesce(trim(p_fields->>'full_name'), '') = '' or coalesce(trim(p_fields->>'id_number'), '') = '' then
      return iv_fail('Full name and ID number are required.');
    end if;
    begin v_dob := (p_fields->>'dob')::date; exception when others then return iv_fail('Enter a valid date of birth.'); end;
    yrs := date_part('year', age(v_dob));
    if v_dob > current_date or yrs > 110 then return iv_fail('Enter a valid date of birth.'); end if;
    if exists (select 1 from iv_id_records where id_number = trim(p_fields->>'id_number'))
       or exists (select 1 from iv_signup_drafts where id_number = trim(p_fields->>'id_number') and id <> draft.id) then
      return iv_fail('This ID is already registered to another account.');
    end if;
    if exists (select 1 from iv_users where email = draft.email) then
      return iv_fail('This email is already registered. Use the PIN option on the login page.');
    end if;
    insert into iv_users (email, pin_hash, requested_role, status, verify_step, consent_at, created_at)
    values (draft.email, draft.pin_hash, draft.requested_role, 'pending', 3, draft.consent_at, draft.created_at)
    returning id into new_user_id;
    insert into iv_id_records (
      user_id, id_type, id_number, full_name, dob, address, expiry, ocr_confidence, ocr_raw,
      id_descriptor, face_ok, face_distance, final_status
    ) values (
      new_user_id, draft.id_type, trim(p_fields->>'id_number'), trim(p_fields->>'full_name'), v_dob,
      nullif(trim(p_fields->>'address'), ''), nullif(p_fields->>'expiry', '')::date, draft.ocr_confidence,
      draft.ocr_raw, draft.id_descriptor, true, draft.face_distance, 'verified'
    );
    insert into iv_faces (user_id, pose, descriptor)
      select new_user_id, x->>'pose', iv_json_to_vec(x->'descriptor')
      from jsonb_array_elements(draft.face_frames) x;
    insert into iv_sessions (token_hash, user_id, expires_at)
      select s.token_hash, new_user_id, s.expires_at from iv_signup_draft_sessions s
      where s.token_hash = v_token_hash;
    perform iv_log(new_user_id, 'final', 'success', draft.face_distance, '');
    delete from iv_signup_drafts where id = draft.id;
    return jsonb_build_object('ok', true);
  end if;
  select * into u from iv_user_from_token(p_token);
  if u.id is null or u.status <> 'unverified' or u.verify_step < 2 then return iv_fail('Complete the ID scan and face match first.'); end if;
  select * into r from iv_id_records where user_id = u.id and face_ok;
  if r.user_id is null then return iv_fail('Complete the ID scan and face match first.'); end if;
  if coalesce(trim(p_fields->>'full_name'), '') = '' or coalesce(trim(p_fields->>'id_number'), '') = '' then
    return iv_fail('Full name and ID number are required.');
  end if;
  begin v_dob := (p_fields->>'dob')::date; exception when others then return iv_fail('Enter a valid date of birth.'); end;
  yrs := date_part('year', age(v_dob));
  if v_dob > current_date or yrs > 110 then return iv_fail('Enter a valid date of birth.'); end if;
  update iv_id_records set full_name = trim(p_fields->>'full_name'), dob = v_dob, address = nullif(trim(p_fields->>'address'), ''),
         id_number = trim(p_fields->>'id_number'), expiry = nullif(p_fields->>'expiry', '')::date,
         final_status = 'verified', updated_at = now()
   where user_id = u.id;
  update iv_users set verify_step = 3, status = 'pending' where id = u.id;
  perform iv_log(u.id, 'final', 'success', r.face_distance, '');
  return jsonb_build_object('ok', true);
end $$;

-- Face login: finds the closest approved face. Liveness (head turn) is checked in the browser.
create or replace function iv_face_login(p_descriptor real[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ids bigint[]; ds real[]; recent int;
  ident_max constant real := 0.50; margin_min constant real := 0.05;
begin
  select count(*) into recent from iv_logs where step = 'login_face' and result = 'failed' and created_at > now() - interval '5 minutes';
  if recent >= 10 then return iv_fail('Too many failed scans. Wait a few minutes or use your PIN.', '{"show_pin": true}'); end if;
  if array_length(p_descriptor, 1) is distinct from 128 then return iv_fail('No clear face found. Try again.'); end if;
  select array_agg(user_id order by dist), array_agg(dist order by dist) into ids, ds
  from (select f.user_id, min(iv_face_dist(f.descriptor, p_descriptor)) as dist
        from iv_faces f join iv_users u on u.id = f.user_id
        where u.status = 'active' group by f.user_id) x;
  if ids is null or ds[1] > ident_max then
    perform iv_log(null, 'login_face', 'failed', ds[1], 'no match');
    return iv_fail('Face not recognized.');
  end if;
  if ds[2] is not null and ds[2] - ds[1] < margin_min then
    perform iv_log(null, 'login_face', 'failed', ds[1], 'ambiguous');
    return iv_fail('The match was not clear enough. Try again or use your PIN.');
  end if;
  perform iv_log(ids[1], 'login_face', 'success', ds[1], '');
  return jsonb_build_object('ok', true, 'token', iv_new_session(ids[1]));
end $$;

create or replace function iv_logout(p_token text) returns jsonb
language sql security definer set search_path = public, extensions as $$
  with d as (delete from iv_sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') returning 1),
       draft_session as (delete from iv_signup_draft_sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') returning 1)
  select jsonb_build_object('ok', true)
$$;

create or replace function iv_list_pending(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users;
begin
  select * into u from iv_user_from_token(p_token);
  if u.id is null or u.status <> 'active' or u.role <> 'admin' then return iv_fail('Admins only.'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'email', x.email, 'requested_role', x.requested_role, 'full_name', r.full_name,
      'dob', r.dob, 'address', r.address, 'id_type', r.id_type, 'id_number', r.id_number,
      'face_distance', r.face_distance, 'ocr_confidence', r.ocr_confidence) order by x.created_at)
    from iv_users x join iv_id_records r on r.user_id = x.id where x.status = 'pending'), '[]'::jsonb));
end $$;

create or replace function iv_decide(p_token text, p_user_id bigint, p_action text, p_role text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u iv_users; n int;
begin
  select * into u from iv_user_from_token(p_token);
  if u.id is null or u.status <> 'active' or u.role <> 'admin' then return iv_fail('Admins only.'); end if;
  if p_action = 'approve' then
    if not exists (select 1 from iv_roles where key = p_role) then return iv_fail('Choose a role to assign.'); end if;
    update iv_users set role = p_role, status = 'active' where id = p_user_id and status = 'pending';
    get diagnostics n = row_count;
    if n = 0 then return iv_fail('That account is no longer pending.'); end if;
    insert into iv_approvals (user_id, approved_by, role_assigned, decision) values (p_user_id, u.id, p_role, 'approved');
  elsif p_action = 'reject' then
    update iv_users set status = 'rejected' where id = p_user_id and status = 'pending';
    get diagnostics n = row_count;
    if n = 0 then return iv_fail('That account is no longer pending.'); end if;
    insert into iv_approvals (user_id, approved_by, decision, reason) values (p_user_id, u.id, 'rejected', left(coalesce(p_reason, ''), 250));
  else
    return iv_fail('Unknown action.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Create the FIRST admin: sign up in the app (full verification), then run:
--   update iv_users set role = 'admin', status = 'active' where email = 'owner@example.com';
-- FIRST ADMIN SETUP
-- After the owner completes registration:
--
--insert into iv_users (
--  email,
--  pin_hash,
--  requested_role,
-- role,
-- status
--)
--values (
--  'admin@test.com',
--  crypt('123456', gen_salt('bf')),
--  'admin',
--  'admin',
--  'active'
--);

--delete from iv_users
--where email='oldadmin@restaurant.com';