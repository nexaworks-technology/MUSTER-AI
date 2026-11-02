-- Roles and databases for NexaWorks AI CSM (ARCHITECTURE §7.1). Idempotent.
-- Run with psql variables: owner_password, app_password.
--   nexaworks_owner: owns schema + tables, runs migrations (CREATEDB for Prisma's shadow DB).
--   app_user:        runtime role. Not superuser, not owner, NOBYPASSRLS, so Postgres row-level
--                    security applies to every query the app makes.
SELECT format('CREATE ROLE nexaworks_owner LOGIN CREATEDB PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexaworks_owner') \gexec
SELECT format('CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') \gexec
ALTER ROLE app_user NOSUPERUSER NOBYPASSRLS;

SELECT 'CREATE DATABASE nexaworks_dev OWNER nexaworks_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nexaworks_dev') \gexec
SELECT 'CREATE DATABASE nexaworks_test OWNER nexaworks_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nexaworks_test') \gexec

\connect nexaworks_dev
\ir grants.sql
\connect nexaworks_test
\ir grants.sql
