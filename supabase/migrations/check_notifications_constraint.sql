-- Script para verificar las restricciones CHECK en la tabla notifications
-- Ejecuta esto en Supabase SQL Editor

-- 1. Ver la definición completa de la tabla notifications
SELECT 
    table_name,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'notifications' 
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- 2. Ver todas las restricciones CHECK en la tabla notifications
SELECT 
    tc.constraint_name,
    tc.table_name,
    cc.check_clause
FROM information_schema.table_constraints tc
JOIN information_schema.check_constraints cc 
    ON tc.constraint_name = cc.constraint_name
WHERE tc.table_name = 'notifications' 
  AND tc.table_schema = 'public'
  AND tc.constraint_type = 'CHECK';

-- 3. Ver ejemplos de tipos existentes en la tabla (si hay datos)
SELECT DISTINCT type, count(*) as count
FROM notifications 
GROUP BY type
ORDER BY count DESC;

-- 4. Ver la definición completa de la tabla (DDL)
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_tables 
WHERE tablename = 'notifications' 
  AND schemaname = 'public';

-- 5. Ver todos los constraints de la tabla
SELECT 
    conname as constraint_name,
    contype as constraint_type,
    pg_get_constraintdef(oid) as definition
FROM pg_constraint 
WHERE conrelid = 'public.notifications'::regclass; 