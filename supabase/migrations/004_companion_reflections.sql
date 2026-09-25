create table if not exists public.companion_reflections (
  id uuid primary key default gen_random_uuid(),

  owner_id uuid not null references auth.users(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,

  reflection text not null,

  relationship_changed boolean not null default false,
  memories_changed boolean not null default false,

  created_at timestamptz not null default now()
);

alter table public.companion_reflections
enable row level security;

create policy "Users can view their own companion reflections"
on public.companion_reflections
for select
to authenticated
using (owner_id = auth.uid());

create policy "Users can insert their own companion reflections"
on public.companion_reflections
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Users can update their own companion reflections"
on public.companion_reflections
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Users can delete their own companion reflections"
on public.companion_reflections
for delete
to authenticated
using (owner_id = auth.uid());

grant select, insert, update, delete
on public.companion_reflections
to authenticated;