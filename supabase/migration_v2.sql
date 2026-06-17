-- ============================================================
-- Wayfinder — Schema Migration v2
-- Replaces the original profiles columns with the full 24-input
-- eligibility variable set from eligibility-schema.js
--
-- Run this in the Supabase SQL Editor AFTER schema.sql
-- (or drop and re-run schema.sql if the project is fresh)
-- ============================================================

-- Drop old columns that have been renamed / restructured
alter table public.profiles
  drop column if exists country_of_origin,
  drop column if exists immigration_status,
  drop column if exists has_minor_children,
  drop column if exists children_ages,
  drop column if exists has_disability,
  drop column if exists monthly_income,
  drop column if exists employment_status,
  drop column if exists housing_situation,
  drop column if exists resettlement_agency;

-- ── Part A: Immigration / Identity ───────────────────────────────────────────
alter table public.profiles
  add column if not exists immigration_status text,  -- ImmigrationStatus enum
  add column if not exists has_i94 boolean,
  add column if not exists has_ead boolean,
  add column if not exists has_ssn boolean,
  add column if not exists has_orr_eligibility_letter boolean;

-- ── Part A: Key Dates ─────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists eligibility_date date,
  add column if not exists arrival_date date,
  add column if not exists status_grant_date date;

-- ── Part A: Location (already exists from v1, keep as-is) ────────────────────
-- state, city, zip_code already present

-- ── Part A: Household / Income ────────────────────────────────────────────────
alter table public.profiles
  add column if not exists age integer,
  add column if not exists household_size integer,
  add column if not exists household_gross_monthly_income numeric,
  add column if not exists num_children_under_19 integer default 0,
  add column if not exists num_children_under_18 integer default 0,
  add column if not exists num_children_under_5 integer default 0,
  add column if not exists is_pregnant boolean default false,
  add column if not exists receives_other_cash_benefit boolean default false;

-- ── Part A: Special Circumstances ────────────────────────────────────────────
alter table public.profiles
  add column if not exists is_unaccompanied_minor boolean default false,
  add column if not exists is_disabled boolean default false,
  add column if not exists is_blind boolean default false,
  add column if not exists has_40_work_quarters boolean default false;

-- ── Part A: Goals / Services ─────────────────────────────────────────────────
alter table public.profiles
  add column if not exists is_employed_or_seeking boolean default false,
  add column if not exists wants_to_start_business boolean default false,
  add column if not exists wants_english_classes boolean default false,
  add column if not exists needs_interpreter boolean default false;
