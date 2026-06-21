-- ============================================================================
-- fix-supabase-grants.sql
--
-- Fixes (and PERMANENTLY prevents) the recurring
--   "permission denied for table <month>"
-- error that blocks P4P score saving and submission logging.
--
-- ROOT CAUSE
--   Each month a new score table (e.g. "2569_06") is created. In Postgres a
--   freshly created table grants NOTHING to the API roles (anon / authenticated
--   / service_role) unless privileges are granted explicitly OR default
--   privileges were configured ahead of time. The April table happened to be
--   granted; May, June, and even p4p_submissions ended up without grants.
--
-- WHAT THIS SCRIPT DOES
--   PART 1 — grants on ALL current tables/sequences (fixes today's breakage)
--   PART 2 — ALTER DEFAULT PRIVILEGES so EVERY FUTURE table auto-grants
--   PART 3 — verification queries
--
-- HOW TO RUN
--   Supabase Dashboard → SQL Editor → paste → Run.
--   The SQL Editor runs as the "postgres" role, which both owns the public
--   schema tables and is the role that creates new ones — so PART 2 will apply
--   to the monthly tables going forward.
--
-- SAFETY
--   Idempotent. Grants are additive; re-running causes no harm.
-- ============================================================================


-- ── PART 1 — fix everything that exists right now ───────────────────────────
-- Covers 2569_04, 2569_05, 2569_06, p4p_submissions, and any others.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO anon, authenticated, service_role;

-- Sequences are needed for INSERTs into tables with serial/identity PKs
-- (e.g. p4p_submissions). Harmless where unused.
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO anon, authenticated, service_role;


-- ── PART 2 — make it permanent for all FUTURE tables ────────────────────────
-- Default privileges are tied to the role that CREATES the object. Tables made
-- through the Supabase dashboard / SQL editor are created by "postgres", so we
-- set the defaults FOR ROLE postgres. (If a different role ever creates the
-- monthly tables, repeat these two statements with FOR ROLE <that_role>.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES
  TO anon, authenticated, service_role;


-- ── PART 3 — verification ───────────────────────────────────────────────────
-- 3a. Confirm every public table now grants to the API roles.
--     Expect one row per (table × role); no table should be missing.
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- 3b. Confirm the default-privilege rule is registered (PART 2 worked).
--     Expect rows for roles a=anon, etc. on schema public.
SELECT pg_get_userbyid(d.defaclrole) AS owner_role,
       n.nspname                     AS schema,
       d.defaclacl                   AS default_acl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';


-- ============================================================================
-- PART 4 — MONTHLY PROVISIONING (run this each month instead of dashboard
--          "Duplicate table")
--
-- WHY: Postgres never copies GRANTs when a table is duplicated, so every
--      dashboard-duplicated month starts with no permissions. PART 2 above
--      should auto-grant duplicates, but this explicit snippet GUARANTEES it
--      and documents the safe CSV-import rule.
--
-- HOW TO USE each month — replace the two month keys, then run:
--   • NEW = the month you are creating   (e.g. 2569_07)
--   • OLD = the previous month to copy   (e.g. 2569_06)
-- ============================================================================
--
--   -- 1. Create the new month from the previous month's structure.
--   --    INCLUDING ALL copies columns/defaults/indexes/constraints (NOT data,
--   --    NOT grants — grants are handled in step 2).
--   CREATE TABLE public."2569_07" (LIKE public."2569_06" INCLUDING ALL);
--
--   -- 2. Grant immediately (covers the case where PART 2 defaults don't apply).
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public."2569_07"
--     TO anon, authenticated, service_role;
--
--   -- 3. Import the roster CSV into public."2569_07".
--   --    ⚠️  Use the "append / insert rows" import option.
--   --    Do NOT use any import that DROPS and RECREATES the table — that wipes
--   --    the grant from step 2 and reintroduces the permission-denied bug.
--
-- ============================================================================
