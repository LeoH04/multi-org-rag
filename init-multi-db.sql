-- ============================================================
-- Multi-Org Open WebUI — Database Initialization
-- Runs only on FIRST startup (when postgres data volume is empty)
-- ============================================================

-- GWF database
CREATE DATABASE openwebui_gwf;

-- Inge Graessle MdB Buro database
CREATE DATABASE openwebui_ig_mdb;

-- Albert-Schweitzer-Kinderdorf database
CREATE DATABASE openwebui_ask;

-- To add more orgs, add lines like:
-- CREATE DATABASE openwebui_org3;
