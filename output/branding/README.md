# VNPAY × TableDB logo

VNPAY reference: official logo downloaded from [VNPAY's website](https://vnpay.vn/ve-chung-toi), asset [logo-primary.svg](https://1889324617.cloud.edgevnpay.vn/assets/images/logo-icon/logo-primary.svg).

TableDB reference: `tabledb-original.svg`, preserved from the original application logo.

The new image combines the official VNPAY wordmark and fingerprint/check emblem with the existing TableDB table-grid/T symbol. The outside background is transparent. The v2 SVG is installed at `apps/web/public/tabledb-logo.svg`; the desktop icon files in `apps/desktop/src-tauri/icons/` are generated from it with the Tauri CLI.

Final deliverables: `tabledb-vnpay-v2.svg` (editable vector) and `tabledb-vnpay-v2.png` (1024 × 1024, RGBA). The final artwork is assembled directly from the original SVG paths with `compose-logo.py`, then rendered to PNG.

Concept exploration used the built-in image_gen tool; the final vector assembly keeps the original brand geometry and clean alpha boundaries. Concept prompt:

> Use case: compositing / logo-brand. Asset type: final square desktop app logo for VNPAY TableDB. Input image 1 is the OFFICIAL VNPAY identity insert, obtained from VNPAY's website: the blue/red fingerprint-check emblem and red VN / blue PAY wordmark. Input image 2 is the existing TableDB app logo edit target: rounded navy square, cyan database-table outline/grid, white capital T and a small turquoise check badge. Primary request: merge these two identities into one refined new app icon, clearly recognizable as VNPAY plus a database/table tool. Preserve the exact distinctive geometry and color order of the official VNPAY wordmark: VN is red, PAY is blue. Design: a white rounded-square app tile, transparent outside it; generously spaced official VNPAY wordmark across the upper area, without the long Vietnamese tagline; below it a large compact navy rounded-square database-table symbol derived closely from image 2, keeping its cyan outline, faint grid and crisp white T. Replace the original small turquoise check badge at the lower-right of the table with the official red/blue fingerprint-check emblem from image 1, keeping it unmistakable and proportionate. Make the elements feel like one polished icon, not two screenshots pasted together. Flat vector-like precise geometry, clean contours, professional enterprise fintech aesthetic, strong visual hierarchy, readable at icon sizes, centered with safe margins. No mockup, no device, no captions, no invented slogan, no extra text or watermark, no 3D, no cast shadows, no background scene. Deliver a single isolated high-resolution logo, with genuine alpha transparency outside the rounded tile.

Regenerate desktop icons from the repository root:

```sh
apps/desktop/node_modules/.bin/tauri icon apps/web/public/tabledb-logo.svg --output /tmp/tabledb-icons
```

Copy `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico`, and `icon.icns` from that output into `apps/desktop/src-tauri/icons/`, then rebuild the desktop application.
