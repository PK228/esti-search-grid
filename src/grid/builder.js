import { SEARCH_AREA, SEARCH_AREA_EXTENDED, GRID_CELL_KM } from "../core/constants.js";
import { store } from "../core/store.js";
import { state } from "../core/state.js";

export function buildGrid() {
  const boundaryPolygon = turf.polygon([SEARCH_AREA.boundary]);
  const grid = turf.squareGrid(turf.bbox(boundaryPolygon), GRID_CELL_KM, {
    units: "kilometers",
    mask: boundaryPolygon,
  });
  const enriched = grid.features.map((feature) => {
    const center = turf.centroid(feature).geometry.coordinates;
    return { feature, lng: center[0], lat: center[1] };
  });

  const rows = [];
  enriched
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .forEach((item) => {
      const row = rows.find(
        (candidate) => Math.abs(candidate.lat - item.lat) < GRID_CELL_KM * 0.0048,
      );
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
  store.cellFeatures = rows.flatMap((row, rowIndex) => {
    row.items.sort((a, b) => a.lng - b.lng);
    return row.items.map((item, colIndex) => {
      const id = `${rowLabel(rowIndex)}${String(colIndex + 1).padStart(2, "0")}`;
      item.feature.properties = { ...item.feature.properties, id, center: [item.lng, item.lat] };
      store.cellLookup.set(id, item.feature);
      return item.feature;
    });
  });
}

export function rowLabel(index) {
  let label = "";
  let value = index;
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

export function findContainingCell(lng, lat) {
  const point = turf.point([lng, lat]);
  for (const feature of store.cellFeatures) {
    if (turf.booleanPointInPolygon(point, feature)) {
      return feature.properties.id;
    }
  }
  return null;
}

export function buildExtendedGrid() {
  // Strip any previously generated extended cells so rebuilds are clean.
  const extIds = new Set(store.cellFeatures.filter((f) => f.properties.id?.startsWith("E-")).map((f) => f.properties.id));
  extIds.forEach((id) => store.cellLookup.delete(id));
  store.cellFeatures = store.cellFeatures.filter((f) => !f.properties.id?.startsWith("E-"));

  const boundary = state.customExtendedBoundary || SEARCH_AREA_EXTENDED.boundary;
  const extPolygon = turf.polygon([boundary]);

  const key = (lng, lat) => `${lng.toFixed(5)},${lat.toFixed(5)}`;
  const seen = new Set();

  // Seed seen with bbox midpoints — same calculation used for all neighbour
  // centres below, so primary cells are never re-generated as extended cells.
  store.cellFeatures.forEach((f) => {
    const [w, s, e, n] = turf.bbox(f);
    seen.add(key((w + e) / 2, (s + n) / 2));
  });

  const queue = [...store.cellFeatures];
  const newItems = [];

  while (queue.length > 0) {
    const cell = queue.shift();
    const [w, s, e, n] = turf.bbox(cell);
    const cw = e - w;
    const ch = n - s;

    const neighbours = [
      [w,      n,      e,      n + ch],  // north
      [w,      s - ch, e,      s     ],  // south
      [e,      s,      e + cw, n     ],  // east
      [w - cw, s,      w,      n     ],  // west
    ];

    for (const [nw, ns, ne, nn] of neighbours) {
      const cLng = (nw + ne) / 2;
      const cLat = (ns + nn) / 2;
      const k = key(cLng, cLat);
      if (seen.has(k)) continue;
      seen.add(k);

      if (!Number.isFinite(cLng) || !Number.isFinite(cLat)) continue;
      try {
        if (!turf.booleanPointInPolygon(turf.point([cLng, cLat]), extPolygon)) continue;
      } catch { continue; }

      const newCell = turf.polygon([[[nw, ns], [ne, ns], [ne, nn], [nw, nn], [nw, ns]]]);
      queue.push(newCell);
      newItems.push({ feature: newCell, lng: cLng, lat: cLat });
    }
  }

  // Sort into rows and assign E- prefixed IDs.
  const rows = [];
  newItems
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng)
    .forEach((item) => {
      const row = rows.find((r) => Math.abs(r.lat - item.lat) < GRID_CELL_KM * 0.0048);
      if (row) {
        row.items.push(item);
        row.lat = row.items.reduce((t, c) => t + c.lat, 0) / row.items.length;
      } else {
        rows.push({ lat: item.lat, items: [item] });
      }
    });

  rows.sort((a, b) => b.lat - a.lat);
  const extCells = rows.flatMap((row, rowIndex) => {
    row.items.sort((a, b) => a.lng - b.lng);
    return row.items.map((item, colIndex) => {
      const id = `E-${rowLabel(rowIndex)}${String(colIndex + 1).padStart(2, "0")}`;
      item.feature.properties = { id, center: [item.lng, item.lat] };
      store.cellLookup.set(id, item.feature);
      return item.feature;
    });
  });

  store.cellFeatures.push(...extCells);
}
