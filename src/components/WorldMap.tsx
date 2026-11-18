import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Film } from '../types';

type Position = [number, number, ...number[]];
type PolygonCoordinates = Position[][];
type MultiPolygonCoordinates = PolygonCoordinates[];
type CountryGeometry =
  | { type: 'Polygon'; coordinates: PolygonCoordinates }
  | { type: 'MultiPolygon'; coordinates: MultiPolygonCoordinates };
type CountryFeature = {
  type: 'Feature';
  properties: { iso2cd: string; nam_en: string };
  geometry: CountryGeometry;
};
type CountryCollection = {
  type: 'FeatureCollection';
  features: CountryFeature[];
};
type MapPan = { x: number; y: number };
type DragState = { pointerId: number; start: [number, number]; pan: MapPan };
type DrawFeature = {
  key: string;
  code: string;
  name: string;
  path: string;
};

const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 560;
const MAP_PADDING = 12;

const countryAliases: Record<string, string> = {
  'u s': 'US',
  usa: 'US',
  'united states': 'US',
  'united states of america': 'US',
  uk: 'GB',
  'great britain': 'GB',
  'united kingdom of great britain and northern ireland': 'GB',
  'south korea': 'KR',
  'republic of korea': 'KR',
  'korea republic of': 'KR',
  'north korea': 'KP',
  'democratic peoples republic of korea': 'KP',
  russia: 'RU',
  'russian federation': 'RU',
  turkey: 'TR',
  'czech republic': 'CZ',
  'cape verde': 'CV',
  'ivory coast': 'CI',
  'cote divoire': 'CI',
  swaziland: 'SZ',
  'north macedonia': 'MK',
  macedonia: 'MK',
  'east timor': 'TL',
  'timor leste': 'TL',
  'syria': 'SY',
  'syrian arab republic': 'SY',
  iran: 'IR',
  'iran islamic republic of': 'IR',
  vietnam: 'VN',
  'laos': 'LA',
  'lao peoples democratic republic': 'LA',
  moldova: 'MD',
  'republic of moldova': 'MD',
  bolivia: 'BO',
  'bolivia plurinational state of': 'BO',
  venezuela: 'VE',
  'venezuela bolivarian republic of': 'VE',
  tanzania: 'TZ',
  'united republic of tanzania': 'TZ',
  brunei: 'BN',
  'brunei darussalam': 'BN',
  palestine: 'PS',
  'state of palestine': 'PS',
  kosovo: 'XK',
};

function normalizeCountryName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function project(longitude: number, latitude: number): [number, number] {
  const lambda = (longitude * Math.PI) / 180;
  const phi = (latitude * Math.PI) / 180;
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  const phi6 = phi4 * phi2;
  const x =
    lambda *
    (0.8707 -
      0.131979 * phi2 +
      phi6 * (-0.013791 + phi2 * (0.003971 * phi2 - 0.001529 * phi4)));
  const y =
    phi *
    (1.007226 +
      phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)));
  return [x, y];
}

function getPolygons(geometry: CountryGeometry): PolygonCoordinates[] {
  return geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates;
}

function buildMapFeatures(features: CountryFeature[]): DrawFeature[] {
  const projected = features.map((feature) => ({
    feature,
    polygons: getPolygons(feature.geometry).map((polygon) =>
      polygon.map((ring) => ring.map(([longitude, latitude]) => project(longitude, latitude))),
    ),
  }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of projected) {
    for (const polygon of item.polygons) {
      for (const ring of polygon) {
        for (const [x, y] of ring) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return [];

  const scale = Math.min(
    (VIEW_WIDTH - MAP_PADDING * 2) / (maxX - minX),
    (VIEW_HEIGHT - MAP_PADDING * 2) / (maxY - minY),
  );
  const mapWidth = (maxX - minX) * scale;
  const mapHeight = (maxY - minY) * scale;
  const offsetX = (VIEW_WIDTH - mapWidth) / 2;
  const offsetY = (VIEW_HEIGHT - mapHeight) / 2;
  const pointToSvg = ([x, y]: [number, number]) => [
    offsetX + (x - minX) * scale,
    offsetY + (maxY - y) * scale,
  ] as const;

  return projected.map(({ feature, polygons }, index) => {
    const path = polygons
      .flatMap((polygon) =>
        polygon.map((ring) => {
          const points = ring.map(pointToSvg);
          if (points.length < 3) return '';
          return `${points
            .map(([x, y], pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
            .join('')}Z`;
        }),
      )
      .join('');

    return {
      key: `${feature.properties.iso2cd}-${index}`,
      code: feature.properties.iso2cd.toUpperCase(),
      name: feature.properties.nam_en,
      path,
    };
  });
}

function getSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): [number, number] | null {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const local = point.matrixTransform(matrix.inverse());
  return [local.x, local.y];
}

function constrainPan(pan: MapPan, zoom: number): MapPan {
  const maxX = (VIEW_WIDTH * (zoom - 1)) / 2;
  const maxY = (VIEW_HEIGHT * (zoom - 1)) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

function getCountryFill(count: number, maxCount: number): string {
  if (count === 0) return '#2d393f';
  const ratio = maxCount <= 1 ? 1 : Math.min(count / maxCount, 1);
  const start = [0, 104, 48];
  const end = [0, 219, 92];
  const color = start.map((channel, index) =>
    Math.round(channel + (end[index] - channel) * ratio),
  );
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

interface WorldMapProps {
  films: Film[];
  period: string;
}

export function WorldMap({ films, period }: WorldMapProps) {
  const [features, setFeatures] = useState<CountryFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<MapPan>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<DragState | null>(null);
  const mapFrameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`${import.meta.env.BASE_URL}countries.geojson`)
      .then((response) => {
        if (!response.ok) throw new Error('The map data could not be loaded.');
        return response.json() as Promise<CountryCollection>;
      })
      .then((collection) => {
        if (!cancelled) setFeatures(collection.features);
      })
      .catch(() => {
        if (!cancelled) setLoadError('The world map data could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const nameToCode = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const feature of features) {
      lookup.set(normalizeCountryName(feature.properties.nam_en), feature.properties.iso2cd.toUpperCase());
    }
    return lookup;
  }, [features]);

  const { counts, representedFilms } = useMemo(() => {
    const result = new Map<string, number>();
    const represented = new Set<string>();

    for (const film of films) {
      const filmCountries = new Set<string>();
      for (const country of film.metadata?.countries ?? []) {
        const normalized = normalizeCountryName(country);
        const code = countryAliases[normalized] ?? nameToCode.get(normalized);
        if (code) filmCountries.add(code.toUpperCase());
      }

      if (filmCountries.size > 0) represented.add(film.key);
      for (const code of filmCountries) {
        result.set(code, (result.get(code) ?? 0) + 1);
      }
    }

    return { counts: result, representedFilms: represented.size };
  }, [films, nameToCode]);

  const drawFeatures = useMemo(() => buildMapFeatures(features), [features]);
  const maxCount = Math.max(0, ...counts.values());
  const countryCount = counts.size;
  const periodLabel = period === 'all-time' ? 'all time' : period;

  const zoomTo = (requestedZoom: number, anchor: [number, number] = [VIEW_WIDTH / 2, VIEW_HEIGHT / 2]) => {
    const nextZoom = Math.max(1, Math.min(4, requestedZoom));
    if (nextZoom === zoom) return;
    setZoom(nextZoom);
    if (nextZoom === 1) {
      setPan({ x: 0, y: 0 });
      return;
    }
    setPan((current) => constrainPan({
      x: current.x + (zoom - nextZoom) * (anchor[0] - VIEW_WIDTH / 2),
      y: current.y + (zoom - nextZoom) * (anchor[1] - VIEW_HEIGHT / 2),
    }, nextZoom));
  };

  useEffect(() => {
    const frame = mapFrameRef.current;
    if (!frame) return;

    const handleWheel = (event: WheelEvent) => {
      const svg = frame.querySelector('svg');
      if (!svg) return;

      // The map owns the wheel while the pointer is inside its frame.
      // Registering as non-passive makes preventDefault reliably stop page scrolling.
      event.preventDefault();

      const nextZoom = Math.max(1, Math.min(4, zoom + (event.deltaY < 0 ? 0.25 : -0.25)));
      if (nextZoom === zoom) return;

      const viewPoint = getSvgPoint(svg, event.clientX, event.clientY) ?? [VIEW_WIDTH / 2, VIEW_HEIGHT / 2];
      const anchor: [number, number] = [
        VIEW_WIDTH / 2 + (viewPoint[0] - VIEW_WIDTH / 2 - pan.x) / zoom,
        VIEW_HEIGHT / 2 + (viewPoint[1] - VIEW_HEIGHT / 2 - pan.y) / zoom,
      ];
      zoomTo(nextZoom, anchor);
    };

    frame.addEventListener('wheel', handleWheel, { passive: false });
    return () => frame.removeEventListener('wheel', handleWheel);
  }, [zoom, pan]);

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (zoom <= 1 || event.button !== 0) return;
    const point = getSvgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = { pointerId: event.pointerId, start: point, pan };
    setIsDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = getSvgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    setPan(constrainPan({
      x: drag.pan.x + point[0] - drag.start[0],
      y: drag.pan.y + point[1] - drag.start[1],
    }, zoom));
  };

  const finishDragging = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section className="review-world-map" aria-label={`Countries of films watched in ${periodLabel}`}>
      <div className="review-world-map-heading">
        <h2>World Map</h2>
        <span aria-hidden="true" />
      </div>

      <div className="review-world-map-frame" ref={mapFrameRef}>
        {loading ? (
          <p className="review-world-map-message">Loading map…</p>
        ) : loadError ? (
          <p className="review-world-map-message">{loadError}</p>
        ) : (
          <svg
            className={`review-world-map-svg ${zoom > 1 ? 'is-zoomed' : ''} ${isDragging ? 'is-dragging' : ''}`}
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            role="img"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDragging}
            onPointerCancel={finishDragging}
            onLostPointerCapture={() => { dragState.current = null; setIsDragging(false); }}
            aria-label={`World map showing ${countryCount} countries represented by ${representedFilms} films watched in ${periodLabel}`}
          >
            <title>{`Countries represented in ${periodLabel} film watching`}</title>
            <g
              transform={`translate(${VIEW_WIDTH / 2 + pan.x} ${VIEW_HEIGHT / 2 + pan.y}) scale(${zoom}) translate(${-VIEW_WIDTH / 2} ${-VIEW_HEIGHT / 2})`}
            >
              {drawFeatures.map((feature) => {
                const count = counts.get(feature.code) ?? 0;
                return (
                  <path
                    key={feature.key}
                    d={feature.path}
                    fill={getCountryFill(count, maxCount)}
                    stroke="#10191c"
                    strokeWidth="0.7"
                    strokeLinejoin="round"
                    className={count > 0 ? 'review-world-map-country is-watched' : 'review-world-map-country'}
                  >
                    <title>
                      {count > 0
                        ? `${feature.name}: ${count} ${count === 1 ? 'film' : 'films'}`
                        : `${feature.name}: no films in this period`}
                    </title>
                  </path>
                );
              })}
            </g>
          </svg>
        )}

        {!loading && !loadError && (
          <div className="review-world-map-controls" role="group" aria-label="World map zoom controls">
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={zoom >= 4}
              onClick={() => zoomTo(zoom + 0.5)}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoom <= 1}
              onClick={() => zoomTo(zoom - 0.5)}
            >
              −
            </button>
          </div>
        )}

        {!loading && !loadError && (
          <div className="review-world-map-legend" aria-label="Map legend">
            <span className="review-world-map-legend-swatch" />
            <span>{countryCount} {countryCount === 1 ? 'country' : 'countries'}</span>
            <span className="review-world-map-legend-divider" aria-hidden="true">·</span>
            <span>{representedFilms} {representedFilms === 1 ? 'film' : 'films'} with country data</span>
          </div>
        )}

        <p className="review-world-map-credit">Map data from UN Geodata</p>
      </div>
    </section>
  );
}
