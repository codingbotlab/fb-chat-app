-- FB Chat encrypted direct messages schema.
-- Run once in Supabase SQL Editor for a separate FB Chat project.
-- Never place SUPABASE_SERVICE_ROLE_KEY in frontend code or commit it to Git.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,24}$'),
  display_name text not null check (char_length(display_name) between 2 and 40),
  public_key jsonb,
  key_backup jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  ciphertext text not null,
  iv text not null check (char_length(iv) between 12 and 32),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  constraint no_self_message check (sender_id <> recipient_id)
);

create index if not exists chat_messages_sender_created
  on public.chat_messages (sender_id, created_at desc);
create index if not exists chat_messages_recipient_created
  on public.chat_messages (recipient_id, created_at desc);
create index if not exists chat_messages_conversation_created
  on public.chat_messages (
    least(sender_id, recipient_id),
    greatest(sender_id, recipient_id),
    created_at desc
  );

alter table public.profiles enable row level security;
alter table public.chat_messages enable row level security;
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.chat_messages from anon, authenticated;
grant all on table public.profiles to service_role;
grant all on table public.chat_messages to service_role;
