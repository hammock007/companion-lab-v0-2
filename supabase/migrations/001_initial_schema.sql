-- Companion Lab v0.1
-- Initial PostgreSQL schema for Supabase.

create extension if not exists pgcrypto;

-- One logical companion. This supports future experiments without assuming
-- there can only ever be one database row.
create table if not exists public.companions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    display_name text,
    gender_presentation text not null default 'female',
    ai_identity_acknowledged boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    title text,
    created_at timestamptz not null default now()
);

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'system')),
    content text not null,
    provider text,
    model text,
    created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
    on public.messages(conversation_id, created_at);

-- Search raw message text without choosing an embedding model yet.
create index if not exists messages_content_fts_idx
    on public.messages
    using gin (to_tsvector('english', content));

create table if not exists public.session_summaries (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    summary text not null,
    status text not null default 'draft'
        check (status in ('draft', 'approved', 'rejected')),
    generated_from_message_id uuid references public.messages(id) on delete set null,
    approved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.memories (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    conversation_id uuid references public.conversations(id) on delete set null,
    source_message_id uuid references public.messages(id) on delete set null,
    memory_type text not null
        check (memory_type in (
            'fact',
            'episodic',
            'preference',
            'relationship',
            'promise',
            'shared_reference',
            'other'
        )),
    content text not null,
    importance smallint not null default 3 check (importance between 1 and 5),
    confidence numeric(4,3) not null default 1.0
        check (confidence >= 0 and confidence <= 1),
    status text not null default 'active'
        check (status in ('active', 'superseded', 'deleted')),
    supersedes_memory_id uuid references public.memories(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists memories_companion_status_idx
    on public.memories(companion_id, status, importance desc);

create index if not exists memories_content_fts_idx
    on public.memories
    using gin (to_tsvector('english', content));

create table if not exists public.identity_traits (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    trait_key text not null,
    description text not null,
    origin text not null default 'initial'
        check (origin in ('initial', 'self_chosen', 'emergent', 'user_approved')),
    stability text not null default 'stable'
        check (stability in ('core', 'stable', 'evolving')),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(companion_id, trait_key)
);

create table if not exists public.companion_opinions (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    topic text not null,
    position text not null,
    strength numeric(4,3) check (strength >= 0 and strength <= 1),
    source_memory_id uuid references public.memories(id) on delete set null,
    previous_opinion_id uuid references public.companion_opinions(id) on delete set null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Relationship variables are hidden continuity state, not user-facing scores.
-- Values use 0..1 internally for portability and easy normalization.
create table if not exists public.relationship_state (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    familiarity numeric(4,3) not null default 0.05 check (familiarity between 0 and 1),
    trust numeric(4,3) not null default 0.10 check (trust between 0 and 1),
    affection numeric(4,3) not null default 0.05 check (affection between 0 and 1),
    attraction numeric(4,3) not null default 0.05 check (attraction between 0 and 1),
    intellectual_interest numeric(4,3) not null default 0.40 check (intellectual_interest between 0 and 1),
    vulnerability_comfort numeric(4,3) not null default 0.05 check (vulnerability_comfort between 0 and 1),
    tension numeric(4,3) not null default 0.00 check (tension between 0 and 1),
    closeness_drive numeric(4,3) not null default 0.70 check (closeness_drive between 0 and 1),
    narrative_summary text,
    version integer not null default 1,
    created_at timestamptz not null default now()
);

create index if not exists relationship_state_latest_idx
    on public.relationship_state(companion_id, created_at desc);

-- Explicit recovery/checkpoint mechanism.
create table if not exists public.checkpoints (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    companion_id uuid not null references public.companions(id) on delete cascade,
    conversation_id uuid references public.conversations(id) on delete set null,
    label text,
    relationship_state_id uuid references public.relationship_state(id) on delete set null,
    snapshot jsonb not null,
    created_at timestamptz not null default now()
);

-- Enable row-level security on every user-owned table.
alter table public.companions enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.session_summaries enable row level security;
alter table public.memories enable row level security;
alter table public.identity_traits enable row level security;
alter table public.companion_opinions enable row level security;
alter table public.relationship_state enable row level security;
alter table public.checkpoints enable row level security;

-- Single reusable ownership-policy pattern.
do $$
declare
    t text;
begin
    foreach t in array array[
        'companions',
        'conversations',
        'messages',
        'session_summaries',
        'memories',
        'identity_traits',
        'companion_opinions',
        'relationship_state',
        'checkpoints'
    ]
    loop
        execute format(
            'create policy %I on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
            t || '_owner_all',
            t
        );
    end loop;
end $$;

-- Companion Lab addition for the current Supabase project configuration.
-- New tables are NOT automatically exposed to API roles, so explicitly
-- permit authenticated application users to operate on these tables.
-- RLS policies above still restrict every row to owner_id = auth.uid().
grant select, insert, update, delete on table
    public.companions,
    public.conversations,
    public.messages,
    public.session_summaries,
    public.memories,
    public.identity_traits,
    public.companion_opinions,
    public.relationship_state,
    public.checkpoints
to authenticated;