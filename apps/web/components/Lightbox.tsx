"use client";

import { useCallback, useEffect } from "react";

/**
 * A photo, full size, over the page.
 *
 * Deliberately small: no zoom, no gallery, no carousel. The need it answers
 * is "the thumbnail in this row is too small to tell what the product is" —
 * so it shows the same file bigger, and gets out of the way on Escape, on a
 * click outside it, or on the close button.
 *
 * Three details that matter more than they look:
 *
 *  - The page behind it stops scrolling while it is open. Without that, a
 *    trackpad scroll moves the table under the overlay and the row you were
 *    looking at is gone when you close it.
 *  - Escape is bound on `document`, not on the overlay, so it works whether
 *    or not focus happens to be inside.
 *  - Clicking the image itself does NOT close it. Only the backdrop does.
 *    People click an image to look closer; closing on that is a small,
 *    constant irritation.
 */
export function Lightbox({ src, alt, caption, onClose }: { src: string; alt: string; caption?: string; onClose: () => void }) {
  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <figure className="lightbox-figure" onClick={stop}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    </div>
  );
}

/**
 * A clickable thumbnail, or a quiet placeholder when there is no photo.
 *
 * The placeholder is not an error: most of the catalogue has no photo, and a
 * broken-image icon on 886 rows would read as a fault in the app rather than
 * a gap in the data.
 */
export function Thumb({ src, alt, onOpen }: { src: string | null; alt: string; onOpen: () => void }) {
  if (!src) return <div className="thumb thumb-empty" aria-hidden="true" />;
  return (
    <button type="button" className="thumb" onClick={onOpen} title={`View ${alt}`} aria-label={`View photo of ${alt}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" />
    </button>
  );
}
