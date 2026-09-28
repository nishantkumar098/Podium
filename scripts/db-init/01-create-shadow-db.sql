-- Prisma's migration diffing needs a database it can safely DROP and recreate.
-- Creating it here means a fresh environment never has a reason to point
-- --shadow-database-url at the real one.
CREATE DATABASE podium_shadow OWNER podium;
