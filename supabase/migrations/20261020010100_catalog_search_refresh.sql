-- Source and relationship triggers refresh lexical search in the source transaction.
BEGIN;
CREATE FUNCTION public.catalog_search_item_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_search_bump_revision(OLD.site_id);
    RETURN OLD;
  END IF;
  v_changed := public.refresh_catalog_search_document(NEW.id);
  IF NOT v_changed THEN PERFORM public.catalog_search_bump_revision(NEW.site_id); END IF;
  IF TG_OP = 'UPDATE' AND OLD.site_id IS DISTINCT FROM NEW.site_id THEN
    PERFORM public.catalog_search_bump_revision(OLD.site_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_search_item_changed AFTER INSERT OR UPDATE OR DELETE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_item_changed();

CREATE FUNCTION public.catalog_search_relationship_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_old jsonb; v_new jsonb; v_id uuid; v_site uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'catalog_item_specs' THEN
    FOR v_id IN SELECT DISTINCT x FROM unnest(ARRAY[
      (v_old->>'catalog_item_id')::uuid, (v_new->>'catalog_item_id')::uuid]) x
      WHERE x IS NOT NULL ORDER BY x
    LOOP
      PERFORM public.refresh_catalog_search_document(v_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'catalog_categories' THEN
    FOR v_id IN SELECT i.id FROM public.catalog_items i
      WHERE i.category_id IN ((v_old->>'id')::uuid, (v_new->>'id')::uuid) ORDER BY i.id
    LOOP
      PERFORM public.refresh_catalog_search_document(v_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'item_specs' THEN
    FOR v_id IN SELECT DISTINCT j.catalog_item_id FROM public.catalog_item_specs j
      WHERE j.item_spec_id IN ((v_old->>'id')::uuid, (v_new->>'id')::uuid) ORDER BY j.catalog_item_id
    LOOP
      PERFORM public.refresh_catalog_search_document(v_id);
    END LOOP;
  END IF;
  -- Category archival/relationship-only changes still invalidate cached ranking/visibility.
  FOR v_site IN SELECT DISTINCT x FROM unnest(ARRAY[
    (v_old->>'site_id')::uuid, (v_new->>'site_id')::uuid]) x WHERE x IS NOT NULL ORDER BY x
  LOOP
    PERFORM public.catalog_search_bump_revision(v_site);
  END LOOP;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER catalog_search_category_changed AFTER INSERT OR UPDATE OR DELETE ON public.catalog_categories
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_relationship_changed();
CREATE TRIGGER catalog_search_spec_changed AFTER INSERT OR UPDATE OR DELETE ON public.item_specs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_relationship_changed();
CREATE TRIGGER catalog_search_spec_link_changed AFTER INSERT OR UPDATE OR DELETE ON public.catalog_item_specs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_relationship_changed();

-- Commercial state is NOT embedding input. Invalidate only; never send it to a provider.
CREATE FUNCTION public.catalog_search_commerce_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_old uuid; v_new uuid; v_site uuid;
BEGIN
  IF TG_TABLE_NAME = 'sites' THEN
    IF TG_OP <> 'INSERT' THEN v_old := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := NEW.id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN v_old := OLD.site_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := NEW.site_id; END IF;
  END IF;
  FOR v_site IN SELECT DISTINCT x FROM unnest(ARRAY[v_old, v_new]) x WHERE x IS NOT NULL ORDER BY x
  LOOP
    PERFORM public.catalog_search_bump_revision(v_site);
  END LOOP;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER catalog_search_site_changed AFTER UPDATE OR DELETE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_commerce_changed();
CREATE TRIGGER catalog_search_inventory_changed AFTER INSERT OR UPDATE OR DELETE ON public.inventory_levels
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_commerce_changed();
CREATE TRIGGER catalog_search_price_changed AFTER INSERT OR UPDATE OR DELETE ON public.price_list_items
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_commerce_changed();
CREATE TRIGGER catalog_search_price_list_changed AFTER INSERT OR UPDATE OR DELETE ON public.price_lists
  FOR EACH ROW EXECUTE FUNCTION public.catalog_search_commerce_changed();

REVOKE ALL ON FUNCTION public.catalog_search_item_changed(), public.catalog_search_relationship_changed(),
  public.catalog_search_commerce_changed() FROM PUBLIC, anon, authenticated, service_role;
COMMIT;