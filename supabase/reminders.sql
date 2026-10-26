-- Run once in the Supabase SQL editor. Records which payment reminders were sent,
-- so the same reminder is never sent twice.
create table if not exists public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id text not null,
  stage text not null,
  to_email text,
  status text not null default 'sending',
  sent_at timestamptz not null default now(),
  unique (workspace_id, invoice_id, stage)
);
alter table public.reminder_log enable row level security;
revoke all on public.reminder_log from anon, authenticated;
grant all on public.reminder_log to service_role;
