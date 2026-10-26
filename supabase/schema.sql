create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  phone text unique,
  email text,
  google_sub text unique,
  password_hash text,
  workspace_id uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists app_users_username_lower_unique
  on public.app_users (lower(username));

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_workspace_id_fkey') then
    alter table public.app_users
      add constraint app_users_workspace_id_fkey
      foreign key (workspace_id) references public.workspaces(id) on delete set null;
  end if;
end $$;

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_states (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  token_hash text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_expiry_idx on public.app_sessions (expires_at);

create table if not exists public.workspace_invites (
  code_hash text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.app_users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_states enable row level security;
alter table public.app_sessions enable row level security;
alter table public.workspace_invites enable row level security;

revoke all on public.app_users, public.workspaces, public.workspace_members,
  public.workspace_states, public.app_sessions, public.workspace_invites
  from anon, authenticated;

grant all on public.app_users, public.workspaces, public.workspace_members,
  public.workspace_states, public.app_sessions, public.workspace_invites
  to service_role;
