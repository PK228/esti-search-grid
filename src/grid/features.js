import { GRID_CELL_KM, SEARCH_AREA, SEARCH_AREA_EXTENDED } from "../core/constants.js";

export function rowLabel(index) {
  let label = "";
  let value = index;
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

export function buildPrimaryCellFeatures(boundary = SEARCH_AREA.boundary) {
  const boundaryPolygon = turf.polygon([boundary]);
  const grid = turf.squareGrid(turf.bbox(boundaryPolygon), GRID_CELL_KM, {
    units: "kilometers",
    mask: boundaryPolygon,
  });

  const enriched = grid.features.map((feature) => {
    const center = turf.centroid(feature).geometry.coordinates;
    return { feature, lng: center[0], lat: center[1] };
  });

  return assignGridIds(enriched, "");
}

export function buildExtendedCellFeatures(
  primaryFeatures,
  boundary = SEARCH_AREA_EXTENDED.boundary,
) {
  const extPolygon = turf.polygon([boundary]);
  const key = (lng, lat) => `${lng.toFixed(5)},${lat.toFixed(5)}`;
  const seen = new Set();

  primaryFeatures.forEach((feature) => {
    const [w, s, e, n] = turf.bbox(feature);
    seen.add(key((w + e) / 2, (s + n) / 2));
  });

  const queue = [...primaryFeatures];
  const newItems = [];

  while (queue.length > 0) {
    const cell = queue.shift();
    const [w, s, e, n] = turf.bbox(cell);
    const cw = e - w;
    const ch = n - s;

    const neighbours = [
      [w, n, e, n + ch],
      [w, s - ch, e, s],
      [e, s, e + cw, n],
      [w - cw, s, w, n],
    ];

    for (const [nw, ns, ne, nn] of neighbours) {
      const cLng = (nw + ne) / 2;
      const cLat = (ns + nn) / 2;
      const k = key(cLng, cLat);
      if (seen.has(k)) continue;
      seen.add(k);

      if (!Number.isFinite(cLng) || !Number.isFinite(cLat)) continue;
      try {
        if (!turf.booleanPointInPolygon(turf.point([cLng, cLat]), extPolygon)) {
          continue;
        }
      } catch {
        continue;
      }

      const feature = turf.polygon([[
        [nw, ns],
        [ne, ns],
        [ne, nn],
        [nw, nn],
        [nw, ns],
      ]]);
      queue.push(feature);
      newItems.push({ feature, lng: cLng, lat: cLat });
    }
  }

  return assignGridIds(newItems, "E-");
}

export function buildSearchCellFeatures(boundary = SEARCH_AREA_EXTENDED.boundary) {
  const primaryFeatures = buildPrimaryCellFeatures();
  const extendedFeatures = buildExtendedCellFeatures(primaryFeatures, boundary);
  return {
    primaryFeatures,
    extendedFeatures,
    cellFeatures: [...primaryFeatures, ...extendedFeatures],
  };
}

function assignGridIds(items, prefix) {
  const rows = [];

  items
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .forEach((item) => {
      const row = rows.find((candidate) => (
        Math.abs(candidate.lat - item.lat) < GRID_CELL_KM * 0.0048
      ));
      if (row) {
        row.items.push(item);
        row.lat =
          row.items.reduce((total, current) => total + current.lat, 0) /
          row.items.length;
      } else {
        rows.push({ lat: item.lat, items: [item] });
      }
    });

  rows.sort((a, b) => b.lat - a.lat);
  return rows.flatMap((row, rowIndex) => {
    row.items.sort((a, b) => a.lng - b.lng);
    return row.items.map((item, colIndex) => {
      const id = `${prefix}${rowLabel(rowIndex)}${String(colIndex + 1).padStart(2, "0")}`;
      item.feature.properties = {
        ...item.feature.properties,
        id,
        center: [item.lng, item.lat],
      };
      return item.feature;
    });
  });
}
