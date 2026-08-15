DO $$
DECLARE
  cat_barberia uuid;
  cat_bebidas uuid;
  cat_faciales uuid;
  v_site_id uuid := '353b235b-1242-4e5e-9bfa-f0cf23363483';
BEGIN
  -- 1. Crear o recuperar la Categoría: Cuidado y Barbería
  SELECT id INTO cat_barberia FROM public.catalog_categories WHERE site_id = v_site_id AND name = 'Cuidado y Barbería' LIMIT 1;
  IF cat_barberia IS NULL THEN
    INSERT INTO public.catalog_categories (site_id, name) VALUES (v_site_id, 'Cuidado y Barbería') RETURNING id INTO cat_barberia;
  END IF;

  -- 2. Crear o recuperar la Categoría: Bebidas
  SELECT id INTO cat_bebidas FROM public.catalog_categories WHERE site_id = v_site_id AND name = 'Bebidas' LIMIT 1;
  IF cat_bebidas IS NULL THEN
    INSERT INTO public.catalog_categories (site_id, name) VALUES (v_site_id, 'Bebidas') RETURNING id INTO cat_bebidas;
  END IF;

  -- 3. Crear o recuperar la Categoría: Servicios Faciales
  SELECT id INTO cat_faciales FROM public.catalog_categories WHERE site_id = v_site_id AND name = 'Servicios Faciales' LIMIT 1;
  IF cat_faciales IS NULL THEN
    INSERT INTO public.catalog_categories (site_id, name) VALUES (v_site_id, 'Servicios Faciales') RETURNING id INTO cat_faciales;
  END IF;

  -- ==========================================
  -- CLASIFICACIÓN A MANO (INFERENCIA UNO A UNO)
  -- ==========================================

  -- BEBIDAS
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = '3bf0e651-ba55-43cc-8f1a-8bece27993ee'; -- Bohemia
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = 'cdbefdf7-1f00-49f3-a468-9761016dc677'; -- Miller
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = '7868b38b-18c0-42f9-a454-36889a967823'; -- Ultra
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = 'b65a63d8-f046-4e33-8e6d-870af0ec9a52'; -- Stella
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = '1f224fae-ed1a-4238-9eed-20e4e949a653'; -- Negra modelo
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = '7838da95-2241-4894-8507-3ed92ed65614'; -- Victoria
  UPDATE public.catalog_items SET category_id = cat_bebidas WHERE id = 'ca606b47-0a57-4373-ba18-2d1d603e008a'; -- Corona

  -- SERVICIOS FACIALES
  UPDATE public.catalog_items SET category_id = cat_faciales WHERE id = '32765d5e-561f-418a-ae9e-a680f4c9c7c9'; -- Facial premium
  UPDATE public.catalog_items SET category_id = cat_faciales WHERE id = 'fc29d209-766f-4c26-9ce8-528b31016fd5'; -- “T” Zone
  UPDATE public.catalog_items SET category_id = cat_faciales WHERE id = '1f3cba27-6a1f-4a7d-ac5e-3d38befe586e'; -- Eye contour

  -- CUIDADO Y BARBERÍA
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '57c1587f-eda8-4edc-bdb1-fa4956715e0f'; -- AC Macadamia
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '433cb026-0e57-42af-92fe-1bd8a7921b44'; -- AC Argán
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '414996e4-1224-4c67-b1e1-39d87a0f693e'; -- PC Matter
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = 'cebcb4ed-1e82-4843-bf16-36f15e61757b'; -- PC Arcilla
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '97d0c284-4b8d-490e-9341-0f35712f26b8'; -- PC Cera Web
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = 'b5b44994-d873-4f1f-8c7a-02f5b3d8649c'; -- Sultan Parlak
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = 'd8a36fa1-26c1-4f0c-8dab-5626ec42dd00'; -- Mr. Taylor’s Moustache Wax
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = 'a971c0f8-7ef0-4372-a95b-8aa6d3fb440d'; -- The Peaky Matte
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '69d10465-90e5-4745-a928-d3888b2070be'; -- HP Sapphire
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = 'ca5dc168-fb98-476b-a0a0-8b68608ccd7b'; -- HP Ruby
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '127bdd68-e470-4ad9-b026-9f7756fae3fb'; -- PA La Mera Mera
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '3856a9ae-4892-4564-9613-9bb7c37523c8'; -- PA Matte
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '4e232596-eb9e-4bdb-ab7c-39a30cc3d1b4'; -- PA La Dorada
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '3a2f7eb1-ae49-4f51-89db-9dba4a00d9ff'; -- Shampoo Barba Charles
  UPDATE public.catalog_items SET category_id = cat_barberia WHERE id = '9bbc3e2b-0c9a-412c-8abb-100fe3554c65'; -- Corte y barba

END $$;