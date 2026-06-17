-- ============================================================
-- Wayfinder — Supabase Schema
-- Run this entire file in the Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- TABLE: profiles
-- Stores onboarding answers + user preferences
-- ============================================================
create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text,
  language_code         text not null default 'en',
  country_of_origin     text,
  immigration_status    text,   -- see onboarding dropdown values
  arrival_date          date,
  status_granted_date   date,
  state                 text,
  city                  text,
  zip_code              text,
  household_size        integer,
  has_minor_children    boolean default false,
  children_ages         integer[],
  is_pregnant           boolean default false,
  has_disability        boolean default false,
  monthly_income        numeric,
  employment_status     text,
  housing_situation     text,
  has_ssn               boolean default false,
  has_ead               boolean default false,
  resettlement_agency   text,
  onboarding_complete   boolean default false,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- RLS
alter table public.profiles enable row level security;

create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile on sign-up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- TABLE: eligibility_results
-- The full output of the eligibility engine for a user
-- ============================================================
create table if not exists public.eligibility_results (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  generated_at        timestamptz default now(),
  language            text not null default 'en',
  rules_last_checked  date,
  summary             text,
  attorney_needed     boolean default false,
  benefits            jsonb not null default '[]'::jsonb,
  flagged_for_human   jsonb not null default '[]'::jsonb,
  created_at          timestamptz default now()
);

create index idx_eligibility_results_user_id on public.eligibility_results(user_id);
create index idx_eligibility_results_generated_at on public.eligibility_results(generated_at desc);

-- RLS
alter table public.eligibility_results enable row level security;

create policy "Users can view their own eligibility results"
  on public.eligibility_results for select
  using (auth.uid() = user_id);

create policy "Service role can insert eligibility results"
  on public.eligibility_results for insert
  with check (auth.uid() = user_id);

create policy "Service role can update eligibility results"
  on public.eligibility_results for update
  using (auth.uid() = user_id);

-- ============================================================
-- TABLE: documents
-- Uploaded files + Claude vision extracted fields
-- ============================================================
create table if not exists public.documents (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  file_name         text not null,
  file_path         text not null,  -- path in Supabase storage bucket
  file_size         integer,
  mime_type         text,
  document_type     text,           -- e.g. "passport", "i-94", "ead", "birth_certificate"
  extracted_fields  jsonb,          -- non-sensitive fields extracted by Claude vision
  uploaded_at       timestamptz default now()
);

create index idx_documents_user_id on public.documents(user_id);

-- RLS
alter table public.documents enable row level security;

create policy "Users can view their own documents"
  on public.documents for select
  using (auth.uid() = user_id);

create policy "Users can insert their own documents"
  on public.documents for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own documents"
  on public.documents for delete
  using (auth.uid() = user_id);

-- ============================================================
-- TABLE: benefit_progress
-- Per-user, per-benefit status tracking
-- ============================================================
create table if not exists public.benefit_progress (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  benefit_id    text not null,   -- rowId from eligibility_rules.json
  benefit_name  text not null,
  status        text not null default 'not_started'
                  check (status in (
                    'not_started',
                    'in_progress',
                    'documents_ready',
                    'submitted',
                    'needs_attorney',
                    'done'
                  )),
  notes         text,
  updated_at    timestamptz default now(),
  created_at    timestamptz default now(),
  unique(user_id, benefit_id)
);

create index idx_benefit_progress_user_id on public.benefit_progress(user_id);

-- RLS
alter table public.benefit_progress enable row level security;

create policy "Users can view their own benefit progress"
  on public.benefit_progress for select
  using (auth.uid() = user_id);

create policy "Users can insert their own benefit progress"
  on public.benefit_progress for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own benefit progress"
  on public.benefit_progress for update
  using (auth.uid() = user_id);

-- ============================================================
-- TABLE: ui_translations
-- Cached Claude translations of the full UI string set
-- keyed by language_code — fetched once, reused for all users
-- ============================================================
create table if not exists public.ui_translations (
  id              uuid primary key default uuid_generate_v4(),
  language_code   text not null unique,
  language_name   text,          -- native name, e.g. "Español"
  translations    jsonb not null, -- mirrors structure of locales/en.json
  generated_at    timestamptz default now()
);

-- RLS: read-only for all authenticated users; insert/update by service role only
alter table public.ui_translations enable row level security;

create policy "Any authenticated user can read translations"
  on public.ui_translations for select
  using (auth.role() = 'authenticated' or auth.role() = 'anon');

-- Service role bypasses RLS for inserts/updates (no policy needed for service role)

-- ============================================================
-- STORAGE BUCKET: user-documents
-- Private bucket — only the owning user can access their files
-- ============================================================
insert into storage.buckets (id, name, public)
values ('user-documents', 'user-documents', false)
on conflict (id) do nothing;

-- Allow authenticated users to upload to their own folder (user_id/*)
create policy "Users can upload their own documents"
  on storage.objects for insert
  with check (
    bucket_id = 'user-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can view their own documents"
  on storage.objects for select
  using (
    bucket_id = 'user-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete their own documents"
  on storage.objects for delete
  using (
    bucket_id = 'user-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- HELPER: updated_at auto-refresh trigger
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

create trigger set_benefit_progress_updated_at
  before update on public.benefit_progress
  for each row execute procedure public.set_updated_at();
