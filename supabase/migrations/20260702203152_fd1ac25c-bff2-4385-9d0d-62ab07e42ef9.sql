ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS pack_size integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS stock_packs numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_bottles numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pack_selling_price numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bottle_selling_price numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pack_cost_price numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bottle_cost_price numeric NOT NULL DEFAULT 0;

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS sale_unit text NOT NULL DEFAULT 'bottle',
  ADD COLUMN IF NOT EXISTS pack_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bottle_quantity numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.sync_product_pack_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.pack_size IS NULL OR NEW.pack_size < 1 THEN
    RAISE EXCEPTION 'pack_size must be at least 1';
  END IF;

  IF NEW.stock_packs IS NULL OR NEW.stock_packs < 0 THEN
    RAISE EXCEPTION 'stock_packs cannot be negative';
  END IF;

  IF NEW.stock_bottles IS NULL OR NEW.stock_bottles < 0 THEN
    RAISE EXCEPTION 'stock_bottles cannot be negative';
  END IF;

  IF TG_OP = 'INSERT' AND COALESCE(NEW.stock_packs, 0) = 0 AND COALESCE(NEW.stock_bottles, 0) = 0 AND COALESCE(NEW.current_stock, 0) > 0 THEN
    NEW.stock_bottles := NEW.current_stock;
  END IF;

  NEW.current_stock := (COALESCE(NEW.stock_packs, 0) * NEW.pack_size) + COALESCE(NEW.stock_bottles, 0);

  IF COALESCE(NEW.bottle_selling_price, 0) = 0 THEN
    NEW.bottle_selling_price := COALESCE(NEW.selling_price, 0);
  END IF;
  IF COALESCE(NEW.bottle_cost_price, 0) = 0 THEN
    NEW.bottle_cost_price := COALESCE(NEW.cost_price, 0);
  END IF;
  IF COALESCE(NEW.pack_selling_price, 0) = 0 THEN
    NEW.pack_selling_price := COALESCE(NEW.bottle_selling_price, COALESCE(NEW.selling_price, 0)) * NEW.pack_size;
  END IF;
  IF COALESCE(NEW.pack_cost_price, 0) = 0 THEN
    NEW.pack_cost_price := COALESCE(NEW.bottle_cost_price, COALESCE(NEW.cost_price, 0)) * NEW.pack_size;
  END IF;

  NEW.selling_price := NEW.bottle_selling_price;
  NEW.cost_price := NEW.bottle_cost_price;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_product_pack_stock ON public.products;
CREATE TRIGGER trg_sync_product_pack_stock
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.sync_product_pack_stock();

UPDATE public.products
SET
  pack_size = GREATEST(COALESCE(pack_size, 1), 1),
  stock_packs = COALESCE(stock_packs, 0),
  stock_bottles = CASE WHEN COALESCE(stock_packs, 0) = 0 AND COALESCE(stock_bottles, 0) = 0 THEN COALESCE(current_stock, 0) ELSE COALESCE(stock_bottles, 0) END,
  bottle_selling_price = CASE WHEN COALESCE(bottle_selling_price, 0) = 0 THEN COALESCE(selling_price, 0) ELSE bottle_selling_price END,
  bottle_cost_price = CASE WHEN COALESCE(bottle_cost_price, 0) = 0 THEN COALESCE(cost_price, 0) ELSE bottle_cost_price END,
  pack_selling_price = CASE WHEN COALESCE(pack_selling_price, 0) = 0 THEN COALESCE(selling_price, 0) * GREATEST(COALESCE(pack_size, 1), 1) ELSE pack_selling_price END,
  pack_cost_price = CASE WHEN COALESCE(pack_cost_price, 0) = 0 THEN COALESCE(cost_price, 0) * GREATEST(COALESCE(pack_size, 1), 1) ELSE pack_cost_price END;

CREATE INDEX IF NOT EXISTS idx_products_archived_stock ON public.products (archived, current_stock);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_unit ON public.sale_items (sale_unit);