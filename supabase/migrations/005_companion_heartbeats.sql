create table if not exists public.companion_heartbeats (
  id uuid primary key default gen_random_uuid(),

  owner_id uuid not null references auth.users(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,

  decision text not null
    check (decision in ('remain_silent', 'send_message')),

  proposed_message text,

  private_reasoning text,

  delivered boolean not null default false,
  delivery_channel text,

  created_at timestamptz not null default now()
);

alter table public.companion_heartbeats
enable row level security;

create policy "Users can view their own companion heartbeats"
on public.companion_heartbeats
for select
to authenticated
using (owner_id = auth.uid());

create policy "Users can insert their own companion heartbeats"
on public.companion_heartbeats
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Users can update their own companion heartbeats"
on public.companion_heartbeats
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Users can delete their own companion heartbeats"
on public.companion_heartbeats
for delete
to authenticated
using (owner_id = auth.uid());

grant select, insert, update, delete
on public.companion_heartbeats
to authenticated;