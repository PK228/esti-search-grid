import { SEARCH_AREA, GRID_CELL_KM } from "../core/constants.js";
import { store } from "../core/store.js";

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
