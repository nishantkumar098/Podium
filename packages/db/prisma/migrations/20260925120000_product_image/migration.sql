-- Product photos. The path is site-relative ("/products/TCS-E-044.jpg") and
-- the files are served as static assets by the app; see
-- scripts/map-product-images.ts, which fills this in from the shop's export.
ALTER TABLE "products" ADD COLUMN "image_url" TEXT;
