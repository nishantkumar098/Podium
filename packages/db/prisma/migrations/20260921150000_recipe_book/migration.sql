-- Recipe book: spirit / method / garnish / notes on recipes; ingredient lines
-- carry their own name, quantity (with optional range), unit and note, and
-- linking a line to a stock item becomes optional.
ALTER TABLE "recipes" ADD COLUMN "spirit" TEXT;
ALTER TABLE "recipes" ADD COLUMN "method" TEXT;
ALTER TABLE "recipes" ADD COLUMN "garnish" TEXT;
ALTER TABLE "recipes" ADD COLUMN "notes" TEXT;
ALTER TABLE "recipes" ALTER COLUMN "price" SET DEFAULT 0;

ALTER TABLE "recipe_items" ALTER COLUMN "sku_id" DROP NOT NULL;
ALTER TABLE "recipe_items" ALTER COLUMN "qty_ml" SET DEFAULT 0;
ALTER TABLE "recipe_items" ADD COLUMN "ingredient" TEXT NOT NULL DEFAULT '';
ALTER TABLE "recipe_items" ADD COLUMN "qty" DECIMAL(10,2);
ALTER TABLE "recipe_items" ADD COLUMN "qty_max" DECIMAL(10,2);
ALTER TABLE "recipe_items" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE "recipe_items" ADD COLUMN "note" TEXT;
ALTER TABLE "recipe_items" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Existing lines were all stock-linked ml pours: carry their name and amount over.
UPDATE "recipe_items" ri
SET "ingredient" = ii."name", "qty" = ri."qty_ml", "unit" = 'ml'
FROM "inventory_items" ii
WHERE ii."id" = ri."sku_id";
