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


-- Web Push subscriptions. Push payloads must never contain decrypted message text.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%'),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id
  on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant all on table public.push_subscriptions to service_role;

-- Native Android Firebase Cloud Messaging device tokens.
-- FCM registration tokens are not message content, but should still be treated as private.
create table if not exists public.fcm_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique check (char_length(token) between 20 and 4096),
  platform text not null default 'android' check (platform = 'android'),
  device_name text not null default 'Android device',
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fcm_tokens_user_id
  on public.fcm_tokens(user_id);
alter table public.fcm_tokens enable row level security;
revoke all on table public.fcm_tokens from anon, authenticated;
grant all on table public.fcm_tokens to service_role;
