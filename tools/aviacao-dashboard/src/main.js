import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as echarts from 'echarts/core';
import { BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, GraphicComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import './styles.css';

echarts.use([BarChart, PieChart, GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, GraphicComponent, CanvasRenderer]);

const API_ORIGIN_KEY = 'cube-aviacao-dashboard-api-origin';
const API_TOKEN_KEY = 'cube-aviacao-dashboard-api-token';
const DATAMART_ID = 'aviacao';
const PAGE_SIZE = 18;
const MAP_FETCH_LIMIT = 800;
const MAP_DISPLAY_LIMIT = 100;
const COLORS = ['#6ce4e5', '#ffb169', '#a69cff', '#77d6a0', '#ff7f86', '#73a7ff'];
const ACTIVITY_GRAINS = [
  { key: 'day', label: 'Dia', cube: 'day' },
  { key: 'month', label: 'Mês', cube: 'month' },
  { key: 'quarter', label: 'Trimestre', cube: 'quarter' },
  { key: 'semester', label: 'Semestre', cube: 'month' },
  { key: 'year', label: 'Ano', cube: 'year' },
];

const state = {
  apiOrigin: localStorage.getItem(API_ORIGIN_KEY) || '',
  token: localStorage.getItem(API_TOKEN_KEY) || '',
  status: '',
  country: '',
  aircraftModel: '',
  activityGranularity: 'month',
  dateBounds: null,
  dateFrom: '',
  dateTo: '',
  cacheMode: 'live',
  routePage: 0,
  calls: [],
  expandedCall: null,
  meta: null,
  map: null,
  markerLayer: null,
  routeLayer: null,
  mapRouteRows: [],
  mapRouteVersion: 0,
  airportRows: [],
  statusRows: [],
  dashboard: {},
  selectedAirport: null,
  selectedPeriod: null,
  matrixFocus: null,
  detail: null,
  loading: false,
  initialized: false,
  queryCache: new Map(),
  queryInflight: new Map(),
  loadVersion: 0,
  loadingBlocks: new Set(),
  charts: { trend: null, status: null },
};

const app = document.querySelector('#app');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function member(row, name) {
  return row?.[name] ?? '';
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(value) {
  return String(value || '').slice(0, 10);
}

function dateOrdinal(value) {
  return Math.round(Date.parse(`${value}T00:00:00Z`) / 86400000);
}

function dateFromOrdinal(value) {
  return new Date(Number(value) * 86400000).toISOString().slice(0, 10);
}

function addDays(value, days) {
  return dateFromOrdinal(dateOrdinal(value) + days);
}

function formatDateRange(value) {
  if (!value) return '\u2014';
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function dateFilters() {
  if (!state.dateFrom || !state.dateTo) return [];
  if (state.dateBounds && state.dateFrom === state.dateBounds.min && state.dateTo === state.dateBounds.max) return [];
  return [{ member: 'timetable.scheduled_departure', operator: 'inDateRange', values: [state.dateFrom, addDays(state.dateTo, 1)] }];
}

function airportUsageQuery(cube) {
  const prefix = `airports_${cube}`;
  return {
    dimensions: [
      `${prefix}.airport_code`,
      `${prefix}.airport_name`,
      `${prefix}.city`,
      `${prefix}.country`,
      `${prefix}.coordinates`,
    ],
    measures: ['timetable.count'],
    filters: [...dateFilters(), ...(state.country ? [{ member: `${prefix}.country`, operator: 'equals', values: [state.country] }] : []), ...(state.aircraftModel ? [{ member: 'airplanes.model', operator: 'equals', values: [state.aircraftModel] }] : [])],
    limit: MAP_FETCH_LIMIT,
    order: { 'timetable.count': 'desc' },
  };
}

function mergeAirportUsage(arrivalRows, departureRows) {
  const airports = new Map();
  const addRows = (rows, cube, movement) => {
    const prefix = `airports_${cube}`;
    rows.forEach(row => {
      const code = member(row, `${prefix}.airport_code`);
      if (!code) return;
      const airport = airports.get(code) || {
        code,
        name: '',
        city: '',
        country: '',
        coordinates: '',
        arrivals: 0,
        departures: 0,
      };
      airport.name ||= member(row, `${prefix}.airport_name`);
      airport.city ||= member(row, `${prefix}.city`);
      airport.country ||= member(row, `${prefix}.country`);
      airport.coordinates ||= member(row, `${prefix}.coordinates`);
      airport[movement] += numberValue(member(row, 'timetable.count'));
      airports.set(code, airport);
    });
  };
  addRows(arrivalRows, 'arrival', 'arrivals');
  addRows(departureRows, 'departure', 'departures');
  return [...airports.values()]
    .map(airport => ({
      'airports_arrival.airport_code': airport.code,
      'airports_arrival.airport_name': airport.name,
      'airports_arrival.city': airport.city,
      'airports_arrival.country': airport.country,
      'airports_arrival.coordinates': airport.coordinates,
      'timetable.count': airport.arrivals + airport.departures,
      'timetable.arrivals_count': airport.arrivals,
      'timetable.departures_count': airport.departures,
    }))
    .sort((left, right) => numberValue(right['timetable.count']) - numberValue(left['timetable.count']))
    .slice(0, MAP_DISPLAY_LIMIT);
}

async function loadAirportUsage() {
  const [arrivals, departures] = await Promise.all([
    safeLoad('chegadas por aeroporto', airportUsageQuery('arrival')),
    safeLoad('partidas por aeroporto', airportUsageQuery('departure')),
  ]);
  return mergeAirportUsage(arrivals, departures);
}

function formatNumber(value, maximumFractionDigits = 0) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits }).format(numberValue(value));
}

function formatCompact(value) {
  return new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(numberValue(value));
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(numberValue(value));
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', { month: 'short', year: 'numeric' }).format(date);
}

function apiOrigin() {
  const configured = state.apiOrigin.trim().replace(/\/$/, '');
  if (!configured) return '';

  // Keep the datamart session on the dashboard origin. Browsers treat
  // localhost and 127.0.0.1 as different sites, so the Cube session cookie
  // (SameSite=Strict) would otherwise be created for one alias and omitted
  // from requests made by the other.
  try {
    const target = new URL(configured, window.location.origin);
    const page = new URL(window.location.origin);
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (loopbackHosts.has(target.hostname) && loopbackHosts.has(page.hostname) && target.hostname !== page.hostname) {
      return '';
    }
  } catch (_error) {
    // Let fetch report malformed origins using the value the user entered.
  }

  return configured;
}

function endpoint(path) {
  return `${apiOrigin()}${path}`;
}

function loadEndpoint() {
  return endpoint(`/cubejs-api/datamarts/${DATAMART_ID}/v1/load`);
}

function metaEndpoint() {
  return endpoint(`/cubejs-api/datamarts/${DATAMART_ID}/v1/meta`);
}

function headers() {
  const result = { 'Content-Type': 'application/json' };
  if (state.token.trim()) result.Authorization = state.token.trim();
  return result;
}

function apiErrorMessage(body, status) {
  const candidate = body?.error ?? body?.message;
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  if (candidate && typeof candidate === 'object') {
    if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message;
    if (typeof candidate.error === 'string' && candidate.error.trim()) return candidate.error;
    return JSON.stringify(candidate);
  }
  if (typeof body === 'string' && body.trim()) {
    const plainText = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plainText) return plainText.slice(0, 240);
  }
  return `HTTP ${status}`;
}

function callKind(label) {
  if (label === 'metadata') return 'meta';
  if (label === 'context') return 'session';
  return 'query';
}

function callLabel(label) {
  const labels = {
    metadata: 'metadados',
    context: 'contexto da sessão',
    'bookings · total': 'reservas · total',
    'tickets · total': 'bilhetes · total',
    'timetable · KPI slice': 'timetable · indicador filtrado',
    'segments · KPI slice': 'segmentos · indicador filtrado',
    'status distribution': 'distribuição de status',
    'monthly flight trend': 'tendência mensal de voos',
    'airport geo dimension': 'dimensão geográfica dos aeroportos',
    'status × aircraft matrix': 'matriz de status por aeronave',
    'routes page': 'página de rotas',
    'open datamart session': 'abrir sessão do datamart',
  };
  return labels[label] || label;
}

function addCall(call) {
  state.calls.unshift(call);
  state.calls = state.calls.slice(0, 80);
  renderCallLog();
}

async function trackedRequest(label, url, options = {}, extra = {}) {
  const startedAt = performance.now();
  const call = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    label: callLabel(label),
    type: extra.type || callKind(label),
    method: options.method || 'GET',
    url,
    query: extra.query || null,
    startedAt: new Date().toISOString(),
    status: 'pending',
    rows: 0,
    duration: 0,
    requestId: '',
    preAggregations: [],
    slowQuery: false,
    lastRefreshTime: '',
    response: null,
  };

  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: { ...headers(), ...(options.headers || {}) },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_error) {
      body = text;
    }

    call.duration = performance.now() - startedAt;
    call.status = response.ok && !body?.error ? 'success' : 'error';
    call.rows = Array.isArray(body?.data) ? body.data.length : Array.isArray(body?.cubes) ? body.cubes.length : 0;
    call.requestId = body?.requestId || '';
    call.preAggregations = Object.keys(body?.usedPreAggregations || {});
    call.slowQuery = Boolean(body?.slowQuery);
    call.lastRefreshTime = body?.lastRefreshTime || '';
    call.response = body;
    addCall(call);

    if (!response.ok || body?.error) throw new Error(apiErrorMessage(body, response.status));
    return body;
  } catch (error) {
    if (call.status === 'pending') {
      call.duration = performance.now() - startedAt;
      call.status = 'error';
      call.response = { error: error instanceof Error ? error.message : String(error) };
      addCall(call);
    }
    if (error instanceof TypeError) {
      throw new Error(`Não foi possível alcançar a API do Cube em ${state.apiOrigin || 'http://localhost:4000'}. Inicie o servidor Cube e tente novamente.`);
    }
    throw error;
  }
}

async function cubeLoad(label, query) {
  const effectiveQuery = optimizeDashboardQuery(query);
  const body = { query: effectiveQuery };
  if (state.cacheMode === 'renew') body.renewQuery = true;
  const cacheKey = JSON.stringify(body);
  if (state.cacheMode !== 'renew') {
    const cached = state.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < 60_000) return cached.body;
    const inflight = state.queryInflight.get(cacheKey);
    if (inflight) return inflight;
  }
  const request = trackedRequest(label, loadEndpoint(), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { query: effectiveQuery, type: 'query' }).then(result => {
    if (state.cacheMode !== 'renew') state.queryCache.set(cacheKey, { createdAt: Date.now(), body: result });
    return result;
  }).finally(() => state.queryInflight.delete(cacheKey));
  if (state.cacheMode !== 'renew') state.queryInflight.set(cacheKey, request);
  return request;
}

async function loadMetadata() {
  const body = await trackedRequest('metadata', metaEndpoint(), {}, { type: 'meta' });
  state.meta = body;
  return body;
}

async function loadContext() {
  const body = await trackedRequest('context', endpoint('/playground/context'), {}, { type: 'session' });
  if (!state.token && body?.cubejsToken) {
    state.token = body.cubejsToken;
    localStorage.setItem(API_TOKEN_KEY, state.token);
  }
  return body;
}

function optimizeDashboardQuery(query) {
  const isStatusBreakdown = query.dimensions?.length === 1 && query.dimensions[0] === 'timetable.status';
  const isMonthlyTrend = query.timeDimensions?.some(item => item.dimension === 'timetable.scheduled_departure') && !query.dimensions?.length;
  if (!isStatusBreakdown && !isMonthlyTrend) return query;
  const measures = (query.measures || []).filter(measure => measure === 'timetable.count');
  return measures.length === (query.measures || []).length ? query : { ...query, measures };
}

function sliceFilters({ status = true, country = true, aircraftModel = true } = {}) {
  const filters = [...dateFilters()];
  if (status && state.status) {
    filters.push({ member: 'timetable.status', operator: 'equals', values: [state.status] });
  }
  if (country && state.country) {
    filters.push({ member: 'airports_arrival.country', operator: 'equals', values: [state.country] });
  }
  if (aircraftModel && state.aircraftModel) {
    filters.push({ member: 'airplanes.model', operator: 'equals', values: [state.aircraftModel] });
  }
  return filters;
}

async function loadDateBounds() {
  const base = {
    timeDimensions: [{ dimension: 'timetable.scheduled_departure', granularity: 'day' }],
    measures: ['timetable.count'],
    limit: 1,
  };
  const [firstRows, lastRows] = await Promise.all([
    safeLoad('menor data dos voos', { ...base, order: { 'timetable.scheduled_departure.day': 'asc' } }),
    safeLoad('maior data dos voos', { ...base, order: { 'timetable.scheduled_departure.day': 'desc' } }),
  ]);
  const first = dateKey(member(firstRows[0], 'timetable.scheduled_departure.day'));
  const last = dateKey(member(lastRows[0], 'timetable.scheduled_departure.day'));
  if (!first || !last) return;
  state.dateBounds = { min: first, max: last };
  state.dateFrom = state.dateFrom && state.dateFrom >= first && state.dateFrom <= last ? state.dateFrom : first;
  state.dateTo = state.dateTo && state.dateTo >= first && state.dateTo <= last ? state.dateTo : last;
  if (dateOrdinal(state.dateFrom) > dateOrdinal(state.dateTo)) state.dateFrom = state.dateTo;
  renderDateFilter();
}

function withFilters(query, options) {
  const filters = [...(query.filters || []), ...sliceFilters(options)];
  return filters.length ? { ...query, filters } : query;
}

async function safeLoad(label, query) {
  try {
    const body = await cubeLoad(label, query);
    return body?.data || [];
  } catch (error) {
    showToast(`${label}: ${error.message}`, true);
    return [];
  }
}

async function runWithConcurrency(tasks, concurrency = 3) {
  concurrency = Math.min(concurrency, 2);
  const results = Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function renderShell() {
  app.innerHTML = `
    <div class="aviation-app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">✦</div>
          <div>
            <div class="brand-name">cube core / aviation</div>
            <div class="brand-context">semantic operations room</div>
          </div>
        </div>
        <div class="topbar-spacer"></div>
        <div class="topbar-actions">
          <span id="connection-badge" class="status-dot">disconnected</span>
          <button id="connect-button" class="button small">Conectar</button>
          <button id="refresh-button" class="button small primary">Atualizar dados</button>
          <button id="calls-button" class="button small ghost">Chamadas da API</button>
        </div>
      </header>

      <section class="hero">
        <div class="eyebrow">Postgres Pro Airlines · datamart / aviacao</div>
        <h1>Um modelo semântico.<br /><span class="hero-accent">Cada voo no contexto.</span></h1>
        <p class="hero-copy">Uma visão operacional conectada à API do Cube. Filtre a operação, aprofunde uma dimensão e acompanhe o desempenho das consultas.</p>

        <aside id="filters-panel" class="filters-panel">
          <div id="filters-content" class="filters-content">
            <div class="control-strip">
          <div class="field">
            <label for="status-filter">Status</label>
            <select id="status-filter"><option value="">Todos os status</option></select>
          </div>
          <div class="field">
            <label for="country-filter">País de chegada</label>
            <select id="country-filter"><option value="">Todos os países</option></select>
          </div>
          <div class="field">
            <label for="aircraft-model-filter">Modelo de avião</label>
            <select id="aircraft-model-filter"><option value="">Todos os modelos</option></select>
          </div>
          <div class="date-range-control">
            <div class="date-range-heading"><label>Per\u00edodo de partida</label><output id="date-range-value">Carregando datas\u2026</output></div>
            <div class="range-slider" id="date-range-slider">
              <div class="range-track"></div><div id="date-range-progress" class="range-progress"></div>
              <input id="date-from-range" type="range" min="0" max="1" value="0" step="1" disabled />
              <input id="date-to-range" type="range" min="0" max="1" value="1" step="1" disabled />
            </div>
          </div>
          <div class="field">
            <label for="cache-mode">Modo da consulta</label>
            <select id="cache-mode">
              <option value="live">Usar cache do Cube</option>
              <option value="renew">Renovar cache</option>
            </select>
          </div>
            </div>
          </div>
          <button id="filters-toggle" class="filters-toggle" type="button" aria-expanded="true" aria-controls="filters-content">
            <span class="filters-toggle-icon" aria-hidden="true"><i class="fa-solid fa-filter"></i></span><span class="filters-toggle-label">FILTROS</span><span class="filters-toggle-chevron" aria-hidden="true">&#8249;</span>
          </button>
        </aside>
      </section>

      <main class="content">
        <section id="kpi-grid" class="metric-grid"></section>

        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-header">
              <div><div class="panel-title">Flight activity</div><div class="panel-subtitle">Monthly flight volume - drag the scale to adjust the axis - click a bar to drill the calendar</div></div>
              <div id="trend-slice" class="panel-actions"></div>
            </div>
            <div id="trend-chart" class="panel-body chart-host"></div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <div><div class="panel-title">Operational status</div><div class="panel-subtitle">A semantic slice, not a hard-coded KPI</div></div>
              <div id="status-total" class="panel-actions"></div>
            </div>
            <div id="status-chart" class="panel-body chart-host"></div>
          </article>
        </section>

        <section class="dashboard-grid">
          <article class="panel map-panel">
            <div class="panel-header">
              <div><div class="panel-title">Airport network</div><div class="panel-subtitle">Geo dimension · marker size follows total movements</div></div>
              <div id="map-count" class="panel-actions"></div>
            </div>
            <div id="airport-map"></div>
          </article>
          <article class="panel selection-panel">
            <div class="panel-header">
              <div><div class="panel-title">Dimension focus</div><div class="panel-subtitle">Click a route or matrix cell to open details</div></div>
              <div id="selection-route" class="panel-actions"></div>
            </div>
            <div id="selection-body" class="selection-empty">Select an airport to open its specific API page and inspect the flights behind the dimension.</div>
          </article>
        </section>

        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-header">
              <div><div class="panel-title">Status × aircraft matrix</div><div class="panel-subtitle">Cross-cube join · click a cell to isolate it</div></div>
              <div class="panel-actions"><span class="tag">timetable + airplanes</span></div>
            </div>
            <div id="matrix-chart" class="panel-body matrix-wrap"></div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <div><div class="panel-title">Top routes</div><div class="panel-subtitle">Server-side pagination · ordered by flight count</div></div>
              <div id="routes-page-label" class="panel-actions"></div>
            </div>
            <div id="routes-table" class="table-wrap"></div>
            <div id="routes-footer" class="table-footer"></div>
          </article>
        </section>

        <div id="detail-modal" class="modal-backdrop" hidden>
          <section class="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
            <div class="panel-header">
              <div><div id="detail-title" class="panel-title">Detalhe</div><div id="detail-subtitle" class="panel-subtitle"></div></div>
              <div class="panel-actions"><button id="close-detail" type="button" class="button small ghost">Fechar</button></div>
            </div>
            <div id="detail-body" class="panel-body"></div>
          </section>
        </div>

        <section id="calls-panel" class="panel calls-panel">
          <div class="panel-header">
            <div><div class="panel-title">API flight recorder</div><div class="panel-subtitle">Every request made by this dashboard · click a row to inspect its query and Cube response metadata</div></div>
            <div class="panel-actions"><button id="export-calls" class="button small">Export JSON</button><button id="clear-calls" class="button small ghost">Clear</button></div>
          </div>
          <div id="calls-summary" class="calls-summary" style="padding: 13px 16px"></div>
          <div id="call-log" class="call-list"></div>
        </section>
      </main>
      <div id="connection-modal" class="modal-backdrop" hidden>
        <form id="connection-form" class="connection-modal" autocomplete="off">
          <div class="panel-header">
            <div><div class="panel-title">Connect datamart API</div><div class="panel-subtitle">Creates a temporary server-side session for this browser</div></div>
            <button id="close-connection" type="button" class="button small ghost">Close</button>
          </div>
          <div class="connection-fields">
            <div class="field"><label for="session-host">DB host</label><input id="session-host" value="host.containers.internal" /></div>
            <div class="field"><label for="session-port">Port</label><input id="session-port" value="5432" /></div>
            <div class="field"><label for="session-database">Database</label><input id="session-database" value="demo" /></div>
            <div class="field"><label for="session-user">User</label><input id="session-user" value="postgres" /></div>
            <div class="field full"><label for="session-password">Password</label><input id="session-password" type="password" placeholder="Not stored by the dashboard" /></div>
          </div>
          <div class="connection-actions"><span>A senha é usada somente para abrir a sessão temporária.</span><div><button type="submit" class="button primary">Abrir sessão</button></div></div>
        </form>
      </div>
      <div id="toast" class="toast" role="status"></div>
    </div>
  `;

  document.querySelector('#cache-mode').value = state.cacheMode;
  translateDashboardText();
}

function translateDashboardText() {
  const translations = new Map([
    ['Flight activity', 'Atividade de voos'],
    ['Monthly flight volume - drag the scale to adjust the axis - click a bar to drill the calendar', 'Volume mensal · arraste a escala para ajustar o eixo · clique em uma barra para detalhar o calendário'],
    ['Operational status', 'Status operacional'],
    ['A semantic slice, not a hard-coded KPI', 'Distribuição semântica da operação'],
    ['Airport network', 'Rede aeroportuária'],
    ['Geo dimension · marker size follows total movements', 'Dimensão geográfica · tamanho conforme os movimentos totais'],
    ['Dimension focus', 'Detalhe da dimensão'],
    ['Click a marker, route, or matrix cell', 'Clique em um aeroporto, rota ou célula'],
    ['Select an airport to open its specific API page and inspect the flights behind the dimension.', 'Selecione um aeroporto para consultar os voos dessa dimensão.'],
    ['Status × aircraft matrix', 'Matriz de status por aeronave'],
    ['Cross-cube join · click a cell to isolate it', 'Relação entre cubos · clique em uma célula para filtrar'],
    ['Top routes', 'Principais rotas'],
    ['Server-side pagination · ordered by flight count', 'Paginação no servidor · ordenadas por voos'],
    ['Click a route or matrix cell to open details', 'Clique em uma rota ou c\u00e9lula para abrir o detalhamento'],
    ['Close', 'Fechar'],
    ['API flight recorder', 'Monitor de chamadas da API'],
    ['Export JSON', 'Exportar JSON'],
    ['Clear', 'Limpar'],
    ['Every request made by this dashboard · click a row to inspect its query and Cube response metadata', 'Cada consulta feita pelo painel · clique para ver detalhes'],
    ['Connect datamart API', 'Conectar à API do datamart'],
    ['Creates a temporary server-side session for this browser', 'Cria uma sessão temporária no servidor para este navegador'],
    ['DB host', 'Servidor do banco'],
    ['Port', 'Porta'],
    ['Database', 'Banco de dados'],
    ['User', 'Usuário'],
    ['Password', 'Senha'],
    ['Use token', 'Usar token'],
    ['Open session', 'Abrir sessão'],
    ['Monthly flight trend', 'Tendência mensal de voos'],
    ['Flight status distribution', 'Distribuição do status dos voos'],
    ['Status / model', 'Status / modelo'],
    ['Route', 'Rota'],
    ['Arrives', 'Chegada'],
    ['Flights', 'Voos'],
    ['Segments', 'Segmentos'],
    ['Revenue', 'Receita'],
  ]);
  const substitutions = [
    ['semantic operations room', 'sala operacional semântica'],
    ['Flight activity', 'Atividade de voos'],
    ['Monthly flight volume', 'Volume mensal de voos'],
    ['click a month to drill', 'clique em um mês para detalhar'],
    ['Operational status', 'Status operacional'],
    ['A semantic slice, not a hard-coded KPI', 'Distribuição semântica da operação'],
    ['Airport network', 'Rede aeroportuária'],
    ['Geo dimension', 'Dimensão geográfica'],
    ['marker size follows total movements', 'tamanho conforme os movimentos totais'],
    ['Dimension focus', 'Detalhe da dimensão'],
    ['Click a marker, route, or matrix cell', 'Clique em um aeroporto, rota ou célula'],
    ['Select an airport', 'Selecione um aeroporto'],
    ['Status × aircraft matrix', 'Matriz de status por aeronave'],
    ['Cross-cube join', 'Relação entre cubos'],
    ['click a cell to isolate it', 'clique em uma célula para filtrar'],
    ['Top routes', 'Principais rotas'],
    ['Server-side pagination', 'Paginação no servidor'],
    ['ordered by flight count', 'ordenadas por quantidade de voos'],
    ['API flight recorder', 'Monitor de chamadas da API'],
    ['Every request made by this dashboard', 'Cada consulta feita pelo painel'],
    ['Connect datamart API', 'Conectar à API do datamart'],
    ['Creates a temporary server-side session for this browser', 'Cria uma sessão temporária no servidor para este navegador'],
    ['Not stored by the dashboard', 'Não é armazenada pelo painel'],
    ['For an existing JWT/session, use the token field instead.', 'Para uma sessão ou JWT existente, use o campo de token.'],
    ['API unavailable', 'API indisponível'],
  ];
  const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    const original = node.textContent;
    let replaced = original;
    substitutions.forEach(([from, to]) => { replaced = replaced.replaceAll(from, to); });
    if (replaced !== original) node.textContent = replaced;
    const trimmed = node.textContent.trim();
    if (translations.has(trimmed)) node.textContent = node.textContent.replace(trimmed, translations.get(trimmed));
  });
}

function bindEvents() {
  document.querySelector('#connect-button').addEventListener('click', openConnectionModal);
  document.querySelector('#close-connection').addEventListener('click', closeConnectionModal);
  document.querySelector('#connection-form').addEventListener('submit', event => {
    event.preventDefault();
    openDatamartSession();
  });
  document.querySelector('#refresh-button').addEventListener('click', () => loadDashboard(true));
  document.querySelector('#filters-toggle').addEventListener('click', toggleFilters);
  document.querySelector('#status-filter').addEventListener('change', scheduleFilterRefresh);
  document.querySelector('#country-filter').addEventListener('change', scheduleFilterRefresh);
  document.querySelector('#aircraft-model-filter').addEventListener('change', scheduleFilterRefresh);
  document.querySelector('#date-from-range').addEventListener('input', handleDateSliderInput);
  document.querySelector('#date-to-range').addEventListener('input', handleDateSliderInput);
  document.querySelector('#cache-mode').addEventListener('change', event => {
    state.cacheMode = event.target.value;
  });
  document.querySelector('#calls-button').addEventListener('click', () => {
    document.querySelector('#calls-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.querySelector('#clear-calls').addEventListener('click', () => {
    state.calls = [];
    state.expandedCall = null;
    renderCallLog();
  });
  document.querySelector('#export-calls').addEventListener('click', exportCalls);
  document.querySelector('#close-detail').addEventListener('click', closeDetail);
  document.querySelector('#detail-modal').addEventListener('click', event => {
    if (event.target.id === 'detail-modal') closeDetail();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('#detail-modal').hidden) closeDetail();
  });
  window.addEventListener('hashchange', handleHash);
  window.addEventListener('resize', renderDateFilter);
  window.addEventListener('resize', resizeECharts);
}

function openConnectionModal() {
  document.querySelector('#connection-modal').hidden = false;
  document.querySelector('#session-password').focus();
}

function closeConnectionModal() {
  document.querySelector('#connection-modal').hidden = true;
}

async function openDatamartSession() {
  state.apiOrigin = state.apiOrigin.trim().replace(/\/$/, '');
  state.token = '';
  localStorage.setItem(API_ORIGIN_KEY, state.apiOrigin);
  localStorage.removeItem(API_TOKEN_KEY);
  const submitButton = document.querySelector('#connection-form button[type="submit"]');
  const originalSubmitLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Connecting…';
  const credentials = {
    CUBEJS_DB_HOST: document.querySelector('#session-host').value.trim(),
    CUBEJS_DB_PORT: document.querySelector('#session-port').value.trim(),
    CUBEJS_DB_NAME: document.querySelector('#session-database').value.trim(),
    CUBEJS_DB_USER: document.querySelector('#session-user').value.trim(),
    CUBEJS_DB_PASS: document.querySelector('#session-password').value,
  };
  try {
    await trackedRequest('open datamart session', endpoint(`/playground/datamarts/${DATAMART_ID}/session`), {
      method: 'POST',
      body: JSON.stringify({ credentials }),
    }, { type: 'session' });
    document.querySelector('#session-password').value = '';
    state.queryCache.clear();
    state.queryInflight.clear();
    closeConnectionModal();
    await initialize(true);
  } catch (error) {
    showToast(`Falha ao abrir a sessão: ${error?.message || 'resposta vazia da API'}`, true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalSubmitLabel;
  }
}

async function connectAndLoad() {
  state.apiOrigin = state.apiOrigin.trim().replace(/\/$/, '');
  state.token = state.token.trim();
  localStorage.setItem(API_ORIGIN_KEY, state.apiOrigin);
  if (state.token) localStorage.setItem(API_TOKEN_KEY, state.token);
  else localStorage.removeItem(API_TOKEN_KEY);
  await initialize(true);
}

async function initialize(showMessage = false) {
  state.loading = true;
  setConnection('pending');
  try {
    await loadContext();
    await loadMetadata();
    await loadDateBounds();
    await loadDashboard();
    state.initialized = true;
    setConnection('online');
    if (showMessage) showToast('API conectada e dados carregados.');
  } catch (error) {
    setConnection('error');
    showToast(`Não foi possível conectar: ${error.message}`, true);
    renderConnectionError(error);
  } finally {
    state.loading = false;
  }
}

function setConnection(status) {
  const badge = document.querySelector('#connection-badge');
  if (!badge) return;
  badge.className = `status-dot ${status === 'online' ? 'online' : status === 'error' ? 'error' : ''}`;
  badge.textContent = status === 'online' ? 'conectado' : status === 'error' ? 'erro' : 'conectando';
}

function renderConnectionError(error) {
  const message = escapeHtml(error?.message || error);
  document.querySelector('#kpi-grid').innerHTML = `
    <article class="metric-card" style="grid-column: 1 / -1; border-color: rgba(255,127,134,.4)">
      <div class="label"><span>API unavailable</span><span class="signal" style="background: var(--red); box-shadow: 0 0 12px var(--red)"></span></div>
      <div class="value" style="font-size: 18px">${message}</div>
      <div class="context">Confira a origem da API, o token ou a sessão ativa do datamart e clique em Conectar.</div>
    </article>
  `;
}

function activityGrain() {
  return ACTIVITY_GRAINS.find(item => item.key === state.activityGranularity) || ACTIVITY_GRAINS[1];
}

function activityQuery() {
  const grain = activityGrain();
  return withFilters({
    timeDimensions: [{ dimension: 'timetable.scheduled_departure', granularity: grain.cube }],
    measures: ['timetable.count'],
    limit: grain.key === 'day' ? 1000 : 240,
    order: { [`timetable.scheduled_departure.${grain.cube}`]: 'asc' },
  }, { status: true, country: true });
}

function activityRows(rows, grainKey) {
  const grain = ACTIVITY_GRAINS.find(item => item.key === grainKey) || ACTIVITY_GRAINS[1];
  const sourceName = `timetable.scheduled_departure.${grain.cube}`;
  const groups = new Map();
  rows.forEach(row => {
    const raw = String(member(row, sourceName) || '').slice(0, 10);
    if (!raw) return;
    const month = Number(raw.slice(5, 7));
    const key = grainKey === 'semester' ? `${raw.slice(0, 4)}-${month <= 6 ? 'S1' : 'S2'}` : raw;
    groups.set(key, (groups.get(key) || 0) + numberValue(member(row, 'timetable.count')));
  });
  return [...groups.entries()].map(([label, count]) => ({ label, count }));
}

function activityLabel(value, grainKey) {
  const label = String(value);
  if (grainKey === 'semester') {
    const [year, semester] = label.split('-');
    return `${semester === 'S1' ? '1º' : '2º'} semestre de ${year}`;
  }
  if (grainKey === 'quarter') {
    const month = Number(label.slice(5, 7));
    return `${Math.floor((month - 1) / 3) + 1}º trimestre de ${label.slice(0, 4)}`;
  }
  if (grainKey === 'year') return label.slice(0, 4);
  if (grainKey === 'day') return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${label}T00:00:00Z`));
  return formatDate(label);
}

async function legacyLoadDashboard(renew = false) {
  if (renew) state.cacheMode = 'renew';
  const results = await runWithConcurrency([
    () => safeLoad('bookings · total', {
      measures: ['bookings.count', 'bookings.total_amount', 'bookings.avg_amount'],
    }),
    () => safeLoad('tickets · total', { measures: ['tickets.count'] }),
    () => safeLoad('timetable · KPI slice', withFilters({ measures: ['timetable.count'] }, { status: true, country: true })),
    () => safeLoad('segments · KPI slice', withFilters({ measures: ['segments.count', 'segments.total_price'] }, { status: true, country: true })),
    () => safeLoad('status distribution', withFilters({
      dimensions: ['timetable.status'],
      measures: ['timetable.count', 'segments.count', 'segments.total_price'],
      limit: 50,
      order: { 'timetable.count': 'desc' },
    }, { status: false, country: true })),
    () => safeLoad('monthly flight trend', withFilters({
      timeDimensions: [{ dimension: 'timetable.scheduled_departure', granularity: 'month' }],
      measures: ['timetable.count', 'segments.count', 'segments.total_price'],
      limit: 120,
      order: { 'timetable.scheduled_departure.month': 'asc' },
    }, { status: true, country: true })),
    () => loadAirportUsage(),
    () => safeLoad('status × aircraft matrix', withFilters({
      dimensions: ['timetable.status', 'airplanes.model'],
      measures: ['timetable.count'],
      limit: 1000,
      order: { 'timetable.count': 'desc' },
    }, { status: false, country: true })),
    () => safeLoad('routes page', withFilters({
      dimensions: ['timetable.route_no', 'timetable.departure_airport', 'timetable.arrival_airport'],
      measures: ['timetable.count', 'segments.count', 'segments.total_price'],
      limit: PAGE_SIZE,
      offset: state.routePage * PAGE_SIZE,
      order: { 'timetable.count': 'desc' },
    }, { status: true, country: true })),
  ], 4);
  state.dashboard = {
    bookings: results[0][0] || {},
    tickets: results[1][0] || {},
    flights: results[2][0] || {},
    segments: results[3][0] || {},
    statusRows: results[4],
    trendRows: results[5],
    airportRows: results[6],
    matrixRows: results[7],
    routeRows: results[8],
  };
  state.statusRows = state.dashboard.statusRows;
  state.airportRows = state.dashboard.airportRows;
  updateFilterOptions();
  renderDashboard();
  if (state.cacheMode === 'renew') {
    state.cacheMode = 'live';
    document.querySelector('#cache-mode').value = 'live';
  }
}

async function loadDashboard(renew = false) {
  if (renew) state.cacheMode = 'renew';
  const version = (state.loadVersion || 0) + 1;
  state.loadVersion = version;
  state.loading = true;

  const isCurrent = () => state.loadVersion === version;
  const definitions = [
    { key: 'flightsKpi', render: renderKpis, load: async () => { const rows = await safeLoad('timetable KPI', withFilters({ measures: ['timetable.count', 'timetable.active_airports'] }, { status: true, country: true })); if (isCurrent()) state.dashboard.flights = rows[0] || null; } },
    { key: 'segmentsKpi', render: renderKpis, load: async () => { const rows = await safeLoad('segments KPI', withFilters({ measures: ['segments.count', 'segments.total_price'] }, { status: true, country: true })); if (isCurrent()) state.dashboard.segments = rows[0] || null; } },
    { key: 'status', render: () => { updateFilterOptions(); renderStatus(); }, load: async () => { const rows = await safeLoad('distribuição de status', withFilters({ dimensions: ['timetable.status'], measures: ['timetable.count', 'segments.count', 'segments.total_price'], limit: 50, order: { 'timetable.count': 'desc' } }, { status: false, country: true })); if (isCurrent()) { state.dashboard.statusRows = rows; state.statusRows = rows; } } },
    { key: 'trend', render: renderTrend, load: async () => { const grain = activityGrain(); const rows = await safeLoad(`atividade de voos · ${grain.label.toLowerCase()}`, activityQuery()); if (isCurrent()) state.dashboard.trendRows = rows; } },
    { key: 'map', render: () => { updateFilterOptions(); renderNetworkMap(); }, load: async () => { const rows = await loadAirportUsage(); if (isCurrent()) { state.dashboard.airportRows = rows; state.airportRows = rows; } } },
    { key: 'matrix', render: () => { updateFilterOptions(); renderMatrix(); }, load: async () => { const rows = await safeLoad('matriz de status por aeronave', withFilters({ dimensions: ['timetable.status', 'airplanes.model'], measures: ['timetable.count'], limit: 1000, order: { 'timetable.count': 'desc' } }, { status: false, country: true })); if (isCurrent()) state.dashboard.matrixRows = rows; } },
    { key: 'routes', render: renderRoutes, load: async () => { const rows = await safeLoad('página de rotas', withFilters({ dimensions: ['timetable.route_no', 'timetable.departure_airport', 'timetable.arrival_airport'], measures: ['timetable.count', 'segments.count', 'segments.total_price'], limit: PAGE_SIZE, offset: state.routePage * PAGE_SIZE, order: { 'timetable.count': 'desc' } }, { status: true, country: true })); if (isCurrent()) state.dashboard.routeRows = rows; } },
  ];

  state.loadingBlocks = new Set(definitions.map(definition => definition.key));
  definitions.forEach(definition => definition.render());
  await runWithConcurrency(definitions.map(definition => async () => {
    try {
      await definition.load();
    } finally {
      if (isCurrent()) {
        state.loadingBlocks.delete(definition.key);
        definition.render();
      }
    }
  }), 4);

  if (isCurrent()) {
    state.loading = false;
    if (state.cacheMode === 'renew') {
      state.cacheMode = 'live';
      document.querySelector('#cache-mode').value = 'live';
    }
  }
}

function updateFilterOptions() {
  const statusSelect = document.querySelector('#status-filter');
  const countrySelect = document.querySelector('#country-filter');
  const aircraftSelect = document.querySelector('#aircraft-model-filter');
  const statusValues = [...new Set(state.statusRows.map(row => member(row, 'timetable.status')).filter(Boolean))].sort();
  const countryValues = [...new Set(state.airportRows.map(row => member(row, 'airports_arrival.country')).filter(Boolean))].sort();
  const aircraftValues = [...new Set((state.dashboard.matrixRows || []).map(row => member(row, 'airplanes.model')).filter(Boolean))].sort();
  statusSelect.innerHTML = `<option value="">Todos os status</option>${statusValues.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  countrySelect.innerHTML = `<option value="">Todos os países</option>${countryValues.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  aircraftSelect.innerHTML = `<option value="">Todos os modelos</option>${aircraftValues.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  statusSelect.value = state.status;
  countrySelect.value = state.country;
  aircraftSelect.value = state.aircraftModel;
}

function renderDateFilter() {
  const fromRange = document.querySelector('#date-from-range');
  const toRange = document.querySelector('#date-to-range');
  const output = document.querySelector('#date-range-value');
  const progress = document.querySelector('#date-range-progress');
  if (!fromRange || !toRange || !output || !progress || !state.dateBounds) return;
  const min = dateOrdinal(state.dateBounds.min);
  const max = dateOrdinal(state.dateBounds.max);
  const from = dateOrdinal(state.dateFrom);
  const to = dateOrdinal(state.dateTo);
  fromRange.min = String(min);
  fromRange.max = String(max);
  toRange.min = String(min);
  toRange.max = String(max);
  fromRange.value = String(from);
  toRange.value = String(to);
  fromRange.disabled = false;
  toRange.disabled = false;
  const span = Math.max(1, max - min);
  const trackWidth = Math.max(0, fromRange.getBoundingClientRect().width - 16);
  progress.style.left = `${8 + (from - min) / span * trackWidth}px`;
  progress.style.right = `${8 + (max - to) / span * trackWidth}px`;
  output.textContent = `${formatDateRange(state.dateFrom)} — ${formatDateRange(state.dateTo)}`;
}

function handleDateSliderInput() {
  const fromRange = document.querySelector('#date-from-range');
  const toRange = document.querySelector('#date-to-range');
  if (!fromRange || !toRange) return;
  let from = Number(fromRange.value);
  let to = Number(toRange.value);
  if (from > to) {
    if (document.activeElement === fromRange) to = from;
    else from = to;
  }
  state.dateFrom = dateFromOrdinal(from);
  state.dateTo = dateFromOrdinal(to);
  renderDateFilter();
  scheduleFilterRefresh();
}

let filterRefreshTimer;
function scheduleFilterRefresh() {
  state.status = document.querySelector('#status-filter')?.value || '';
  state.country = document.querySelector('#country-filter')?.value || '';
  state.aircraftModel = document.querySelector('#aircraft-model-filter')?.value || '';
  state.routePage = 0;
  window.clearTimeout(filterRefreshTimer);
  filterRefreshTimer = window.setTimeout(() => loadDashboard(), 240);
}

function toggleFilters() {
  const panel = document.querySelector('#filters-panel');
  const button = document.querySelector('#filters-toggle');
  const collapsed = !panel.classList.contains('is-collapsed');
  document.querySelector('.aviation-app').classList.toggle('filters-collapsed', collapsed);
  panel.classList.toggle('is-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.querySelector('.filters-toggle-chevron').textContent = String.fromCodePoint(collapsed ? 8250 : 8249);
  window.setTimeout(resizeECharts, 200);
}

function renderDashboard() {
  renderKpis();
  renderTrend();
  renderStatus();
  renderNetworkMap();
  renderMatrix();
  renderRoutes();
  renderSelection();
  renderDetail();
  translateDashboardText();
}

function blockIsLoading(key) {
  return state.loadingBlocks?.has(key);
}

function componentLoading(message) {
  return `<div class="component-loading"><span class="loading-spinner"></span><span>${message}</span></div>`;
}

function renderKpis() {
  const filtered = Boolean(
    state.status ||
    state.country ||
    state.aircraftModel ||
    (state.dateBounds && (state.dateFrom !== state.dateBounds.min || state.dateTo !== state.dateBounds.max)),
  );
  const filterBadge = filtered ? '<span class="tag warn">Filtrado</span>' : '';
  const cards = [
    ['flightsKpi', 'Número de voos', formatNumber(member(state.dashboard.flights, 'timetable.count')), 'timetable.count'],
    ['segmentsKpi', 'Número de passageiros', formatCompact(member(state.dashboard.segments, 'segments.count')), 'segments.count'],
    ['segmentsKpi', 'Receita', formatCurrency(member(state.dashboard.segments, 'segments.total_price')), 'segments.total_price · USD'],
    ['flightsKpi', 'Aeroportos ativos', formatNumber(member(state.dashboard.flights, 'timetable.active_airports')), 'timetable.active_airports'],
  ];
  document.querySelector('#kpi-grid').innerHTML = cards.map((card, index) => `
    <article class="metric-card">
      <div class="label"><span>${card[1]}</span><div class="metric-label-right">${filterBadge}<span class="signal" style="background: ${COLORS[index]}"></span></div></div>
      <div class="value">${blockIsLoading(card[0]) ? '<span class="loading-inline">Carregando…</span>' : card[2] || '—'}</div>
      <div class="context">${card[3]}</div>
    </article>
  `).join('');
}

function chartSize(host, fallbackHeight = 300) {
  return { width: Math.max(320, host.clientWidth || 700), height: fallbackHeight };
}

function renderTrendLegacy() {
  const host = document.querySelector('#trend-chart');
  const rows = state.dashboard.trendRows || [];
  if (blockIsLoading('trend') && state.dashboard.trendRows === undefined) {
    host.innerHTML = componentLoading('Carregando tendência mensal…');
    return;
  }
  const values = rows.map(row => ({
    label: member(row, 'timetable.scheduled_departure.month'),
    count: numberValue(member(row, 'timetable.count')),
    segments: numberValue(member(row, 'segments.count')),
  })).filter(row => row.label);
  if (!values.length) { host.innerHTML = '<div class="chart-empty">Não há dados de tendência para este filtro.</div>'; return; }
  const { width, height } = chartSize(host);
  const margin = { top: 22, right: 18, bottom: 42, left: 48 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(...values.map(row => row.count), 1);
  const x = index => margin.left + (values.length === 1 ? innerWidth / 2 : index * innerWidth / (values.length - 1));
  const y = value => margin.top + innerHeight - value / max * innerHeight;
  const points = values.map((row, index) => `${x(index)},${y(row.count)}`).join(' ');
  const area = `${margin.left},${margin.top + innerHeight} ${points} ${x(values.length - 1)},${margin.top + innerHeight}`;
  const tickEvery = Math.max(1, Math.ceil(values.length / 6));
  const ticks = values.filter((_row, index) => index % tickEvery === 0 || index === values.length - 1);
  host.innerHTML = `
    <svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly flight trend">
      <title>Monthly flight trend</title>
      ${[0, .5, 1].map(ratio => `<line class="axis-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y(max * ratio)}" y2="${y(max * ratio)}"></line><text class="axis-text" x="${margin.left - 8}" y="${y(max * ratio) + 4}" text-anchor="end">${formatCompact(max * ratio)}</text>`).join('')}
      <polygon class="line-area" points="${area}"></polygon>
      <polyline class="line-path" points="${points}"></polyline>
      ${values.map((row, index) => `<circle class="line-point" cx="${x(index)}" cy="${y(row.count)}" r="4" data-period="${escapeHtml(row.label)}" data-tooltip="${escapeHtml(formatDate(row.label))}: ${formatNumber(row.count)} voos"></circle>`).join('')}
      ${ticks.map(row => { const index = values.indexOf(row); return `<text class="axis-text" x="${x(index)}" y="${height - 16}" text-anchor="middle">${escapeHtml(formatDate(row.label))}</text>`; }).join('')}
      <text class="axis-text" x="${margin.left}" y="12">voos / mês</text>
    </svg>
  `;
  host.querySelectorAll('[data-period]').forEach(node => node.addEventListener('click', () => selectPeriod(node.dataset.period)));
  document.querySelector('#trend-slice').innerHTML = state.status || state.country ? `<span class="tag good">filtro ativo</span>` : '<span class="tag">modelo completo</span>';
}

function renderStatusLegacy() {
  const host = document.querySelector('#status-chart');
  const rows = (state.dashboard.statusRows || []).map(row => ({
    label: member(row, 'timetable.status'),
    value: numberValue(member(row, 'timetable.count')),
    segments: numberValue(member(row, 'segments.count')),
  })).filter(row => row.label);
  if (blockIsLoading('status') && state.dashboard.statusRows === undefined) {
    host.innerHTML = componentLoading('Carregando status…');
    return;
  }
  if (!rows.length) { host.innerHTML = '<div class="chart-empty">Não há dados de status para este filtro.</div>'; return; }
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = rows.map((row, index) => {
    const length = total ? row.value / total * circumference : 0;
    const segment = `<circle class="donut-segment" data-status="${escapeHtml(row.label)}" cx="100" cy="100" r="${radius}" stroke="${COLORS[index % COLORS.length]}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"></circle>`;
    offset += length;
    return segment;
  }).join('');
  host.innerHTML = `
    <div style="display:grid; grid-template-columns: 190px minmax(0,1fr); align-items:center; gap:12px">
      <svg viewBox="0 0 200 200" role="img" aria-label="Flight status distribution" style="width:100%; max-height:230px">
        <title>Flight status distribution</title>
        <circle class="donut-track" cx="100" cy="100" r="${radius}"></circle>${segments}
        <text class="donut-center-value" x="100" y="98">${formatCompact(total)}</text>
        <text class="donut-center-label" x="100" y="119">voos</text>
      </svg>
      <div class="legend">${rows.map((row, index) => `<div class="legend-item" data-status="${escapeHtml(row.label)}"><span class="legend-swatch" style="background:${COLORS[index % COLORS.length]}"></span><span>${escapeHtml(row.label)}</span><span class="legend-value">${formatCompact(row.value)}</span></div>`).join('')}</div>
    </div>
  `;
  host.querySelectorAll('[data-status]').forEach(node => node.addEventListener('click', () => {
    state.status = node.dataset.status;
    document.querySelector('#status-filter').value = state.status;
    state.routePage = 0;
    loadDashboard();
  }));
  document.querySelector('#status-total').innerHTML = `<span class="tag">${formatNumber(total)} voos</span>`;
}

function chartColor(token, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
}

function disposeEChart(key, host) {
  const chart = state.charts[key] || echarts.getInstanceByDom(host);
  if (chart) chart.dispose();
  state.charts[key] = null;
}

function resizeECharts() {
  Object.values(state.charts).forEach(chart => chart?.resize());
}

function renderActivityControls() {
  const host = document.querySelector('#trend-slice');
  if (!host) return;
  const current = activityGrain().key;
  const buttons = ACTIVITY_GRAINS.map(grain => `<button type="button" class="button small ${grain.key === current ? 'primary' : 'ghost'}" data-activity-grain="${grain.key}" aria-pressed="${grain.key === current}" aria-label="Drill ${grain.key === current ? 'atual' : grain.key} no gráfico">${grain.label}</button>`).join('');
  const filterTag = state.status || state.country || state.aircraftModel ? '<span class="tag good">filtro ativo</span>' : '<span class="tag">modelo completo</span>';
  host.innerHTML = `<div class="activity-drill-controls" role="group" aria-label="Granularidade do calendário">${buttons}</div>${filterTag}`;
  host.querySelectorAll('[data-activity-grain]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.activityGrain === state.activityGranularity) return;
    state.activityGranularity = button.dataset.activityGrain;
    loadDashboard();
  }));
}

function renderTrend() {
  const host = document.querySelector('#trend-chart');
  const rows = state.dashboard.trendRows || [];
  renderActivityControls();
  disposeEChart('trend', host);
  if (blockIsLoading('trend') && state.dashboard.trendRows === undefined) {
    host.innerHTML = componentLoading('Carregando tendência mensal…');
    return;
  }
  const values = activityRows(rows, state.activityGranularity);
  if (!values.length) {
    host.innerHTML = '<div class="chart-empty">Não há dados de tendência para este filtro.</div>';
    return;
  }

  host.innerHTML = '';
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', `Atividade de voos por ${activityGrain().label.toLowerCase()} com escala ajustável`);
  const chart = echarts.init(host);
  state.charts.trend = chart;
  const foreground = chartColor('--ink', '#172033');
  const muted = chartColor('--muted', '#667085');
  const border = chartColor('--border', '#dfe5ec');
  const primary = chartColor('--cyan', '#2563a6');
  chart.setOption({
    animation: false,
    grid: { left: 58, right: 20, top: 18, bottom: 62, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: params => {
        const item = params[0];
        return `${activityLabel(item.name, state.activityGranularity)}<br/><strong>${formatNumber(item.value)} voos</strong>`;
      },
    },
    xAxis: {
      type: 'category',
      data: values.map(row => row.label),
      axisLine: { lineStyle: { color: border } },
      axisTick: { alignWithLabel: true },
      axisLabel: { color: muted, hideOverlap: true, formatter: value => activityLabel(value, state.activityGranularity) },
    },
    yAxis: {
      type: 'value',
      name: 'Voos',
      nameTextStyle: { color: muted },
      axisLabel: { color: muted, formatter: value => formatCompact(value) },
      splitLine: { lineStyle: { color: border } },
    },
    dataZoom: [
      { type: 'slider', xAxisIndex: 0, height: 18, bottom: 8, borderColor: border, fillerColor: 'rgba(37, 99, 166, 0.18)', handleStyle: { color: primary }, textStyle: { color: muted } },
      { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: true, moveOnMouseMove: true },
    ],
    series: [{
      name: 'Número de voos',
      type: 'bar',
      large: true,
      largeThreshold: 2000,
      barMaxWidth: 28,
      data: values.map(row => row.count),
      itemStyle: { color: primary, borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { color: chartColor('--cyan-2', '#1d4f86') } },
    }],
    textStyle: { color: foreground },
  });
}

function renderStatus() {
  const host = document.querySelector('#status-chart');
  const rows = (state.dashboard.statusRows || []).map(row => ({
    label: member(row, 'timetable.status'),
    value: numberValue(member(row, 'timetable.count')),
  })).filter(row => row.label);
  disposeEChart('status', host);
  if (blockIsLoading('status') && state.dashboard.statusRows === undefined) {
    host.innerHTML = componentLoading('Carregando status…');
    return;
  }
  if (!rows.length) {
    host.innerHTML = '<div class="chart-empty">Não há dados de status para este filtro.</div>';
    return;
  }

  host.innerHTML = '';
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', 'Distribuição de status dos voos');
  const chart = echarts.init(host);
  state.charts.status = chart;
  const muted = chartColor('--muted', '#667085');
  const border = chartColor('--border', '#dfe5ec');
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const compact = host.clientWidth < 560;
  chart.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      formatter: params => `${escapeHtml(params.name)}<br/><strong>${formatNumber(params.value)} voos</strong> (${params.percent}%)`,
    },
    legend: compact
      ? { type: 'scroll', bottom: 0, left: 'center', orient: 'horizontal', textStyle: { color: muted } }
      : { type: 'scroll', right: 0, top: 'middle', orient: 'vertical', textStyle: { color: muted } },
    series: [{
      name: 'Status',
      type: 'pie',
      radius: compact ? ['38%', '62%'] : ['52%', '72%'],
      center: compact ? ['50%', '42%'] : ['34%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      itemStyle: { borderColor: chartColor('--surface', '#ffffff'), borderWidth: 2 },
      data: rows.map((row, index) => ({ value: row.value, name: row.label, itemStyle: { color: COLORS[index % COLORS.length] } })),
    }],
    graphic: compact ? [] : [{ type: 'text', left: '27%', top: '44%', style: { text: [formatCompact(total), 'voos'].join(String.fromCharCode(10)), textAlign: 'center', fill: chartColor('--ink', '#172033'), fontSize: 16, fontWeight: 700 } }],
    textStyle: { color: muted },
    grid: { borderColor: border },
  });
  chart.on('click', params => {
    if (params.componentType !== 'series' || !params.name) return;
    state.status = params.name;
    document.querySelector('#status-filter').value = state.status;
    state.routePage = 0;
    loadDashboard();
  });
  document.querySelector('#status-total').innerHTML = `<span class="tag">${formatNumber(total)} voos</span>`;
}

function parseCoordinates(value) {
  if (Array.isArray(value)) return { lat: numberValue(value[0]), lng: numberValue(value[1]) };
  const pieces = String(value || '').replace(/[()]/g, '').split(',').map(Number);
  if (pieces.length < 2 || !pieces.every(Number.isFinite)) return null;
  return { lat: pieces[0], lng: pieces[1] };
}

const MAP_LANDMASSES = [
  [[-168, 72], [-140, 70], [-125, 56], [-105, 48], [-85, 48], [-62, 52], [-58, 40], [-80, 24], [-105, 18], [-120, 28], [-145, 40]],
  [[-82, 12], [-68, 8], [-60, -8], [-66, -23], [-74, -55], [-82, -42], [-78, -15]],
  [[-12, 36], [8, 35], [28, 42], [52, 55], [95, 70], [145, 62], [170, 48], [150, 30], [120, 15], [100, 5], [80, 8], [58, 25], [42, 10], [28, 12], [20, 30], [5, 35]],
  [[-18, 35], [2, 36], [31, 30], [43, 10], [35, -22], [18, -35], [2, -30], [-12, -10]],
  [[112, -10], [154, -12], [153, -38], [130, -44], [114, -32]],
];

function mapProjection(width, height, point) {
  return { x: (point.lng + 180) / 360 * width, y: (90 - point.lat) / 180 * height };
}

function mapPolygon(points, width, height) {
  return points.map((point, index) => {
    const projected = mapProjection(width, height, { lat: point[1], lng: point[0] });
    return `${index ? 'L' : 'M'}${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
  }).join(' ') + ' Z';
}

function renderNetworkMapSvg() {
  const host = document.querySelector('#airport-map');
  const rows = state.dashboard.airportRows || [];
  if (blockIsLoading('map') && state.dashboard.airportRows === undefined) {
    host.innerHTML = componentLoading('Carregando mapa de destinos…');
    return;
  }
  const width = Math.max(700, host.clientWidth || 900);
  const height = 430;
  const validPoints = rows.map(row => {
    const point = parseCoordinates(member(row, 'airports_arrival.coordinates'));
    return point && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180 ? { row, point } : null;
  }).filter(Boolean);
  const clusters = new Map();
  validPoints.forEach(({ row, point }) => {
    const key = `${Math.floor((point.lat + 90) / 6)}:${Math.floor((point.lng + 180) / 8)}`;
    const cluster = clusters.get(key) || { lat: 0, lng: 0, count: 0, rows: [] };
    cluster.lat += point.lat;
    cluster.lng += point.lng;
    cluster.count += numberValue(member(row, 'timetable.count'));
    cluster.rows.push(row);
    clusters.set(key, cluster);
  });
  const points = [...clusters.values()].map(cluster => ({
    row: cluster.rows[0],
    rows: cluster.rows,
    point: { lat: cluster.lat / cluster.rows.length, lng: cluster.lng / cluster.rows.length },
    count: cluster.count,
  }));
  const grid = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map(lng => {
    const x = mapProjection(width, height, { lat: 0, lng }).x.toFixed(1);
    return `<line class="map-grid-line" x1="${x}" y1="0" x2="${x}" y2="${height}" />`;
  }).join('') + [-60, -30, 0, 30, 60].map(lat => {
    const y = mapProjection(width, height, { lat, lng: 0 }).y.toFixed(1);
    return `<line class="map-grid-line" x1="0" y1="${y}" x2="${width}" y2="${y}" />`;
  }).join('');
  const maxCount = Math.max(...points.map(item => item.count), 1);
  host.innerHTML = `<div class="map-caption">Mapa de densidade · ${formatNumber(validPoints.length)} aeroportos agrupados em ${formatNumber(points.length)} áreas</div><svg class="network-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Mapa de aeroportos de chegada"><rect class="map-ocean" width="${width}" height="${height}" rx="8" />${grid}${points.map(({ row, rows: clusterRows, point, count }) => {
    const projected = mapProjection(width, height, point);
    const code = member(row, 'airports_arrival.airport_code');
    const name = member(row, 'airports_arrival.airport_name');
    const radius = 4 + Math.min(9, Math.sqrt(count / maxCount) * 9);
    return `<circle class="map-point" cx="${projected.x.toFixed(1)}" cy="${projected.y.toFixed(1)}" r="${radius.toFixed(1)}" data-airport-code="${escapeHtml(code)}"><title>${escapeHtml(name)} · ${escapeHtml(code)} · ${formatNumber(clusterRows.length)} aeroportos · ${formatNumber(count)} voos</title></circle>`;
  }).join('')}</svg>`;
  document.querySelector('#map-count').innerHTML = `<span class="tag good">${formatNumber(points.length)} áreas</span>`;
}

function renderNetworkMap() {
  const host = document.querySelector('#airport-map');
  if (blockIsLoading('map') && state.dashboard.airportRows === undefined) {
    host.innerHTML = componentLoading('Carregando mapa de destinos…');
    return;
  }
  renderLeafletMap();
  window.setTimeout(() => state.map?.invalidateSize(), 50);
}

function renderLeafletMap() {
  const host = document.querySelector('#airport-map');
  if (!state.map) {
    host.innerHTML = '';
    state.map = L.map(host, { preferCanvas: true, worldCopyJump: true, zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 8, attribution: '&copy; OpenStreetMap contributors' }).addTo(state.map);
    state.routeLayer = L.layerGroup().addTo(state.map);
    state.markerLayer = L.layerGroup().addTo(state.map);
  }
  state.markerLayer.clearLayers();
  const rows = state.dashboard.airportRows || [];
  const maxAirportMovements = Math.max(...rows.map(row => numberValue(member(row, 'timetable.count'))), 1);
  rows.forEach(row => {
    const point = parseCoordinates(member(row, 'airports_arrival.coordinates'));
    if (!point || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return;
    const code = member(row, 'airports_arrival.airport_code');
    const name = member(row, 'airports_arrival.airport_name');
    const city = member(row, 'airports_arrival.city');
    const count = member(row, 'timetable.count');
    const arrivals = member(row, 'timetable.arrivals_count');
    const departures = member(row, 'timetable.departures_count');
    const radius = Math.max(5, Math.min(24, 5 + Math.sqrt(numberValue(count) / maxAirportMovements) * 19));
    const marker = L.circleMarker([point.lat, point.lng], { radius, color: '#ffffff', weight: 1, fillColor: '#2563a6', fillOpacity: 0.78 });
    marker.on('click', () => selectAirport(code, row, { openDetail: false }));
    marker.bindPopup(`<strong>${escapeHtml(code)}</strong><br>${escapeHtml(name)} · ${escapeHtml(city)}<br><strong>${formatNumber(count)} movimentos</strong><br>Chegadas: ${formatNumber(arrivals)} · Partidas: ${formatNumber(departures)}`);
    marker.addTo(state.markerLayer);
  });
  const mapScope = state.country ? `no filtro de ${escapeHtml(state.country)}` : 'no per\u00edodo selecionado';
  document.querySelector('#map-count').innerHTML = `<span class="tag good">${formatNumber(rows.length)} aeroportos ${mapScope} \u00b7 limite ${formatNumber(MAP_DISPLAY_LIMIT)}</span>`;
  renderMapRoutes();
  window.setTimeout(() => state.map?.invalidateSize(), 50);
}

function renderMapRoutes() {
  if (!state.map || !state.routeLayer) return;
  state.routeLayer.clearLayers();
  if (!state.selectedAirport || !state.mapRouteRows.length) return;
  const coordinates = new Map();
  state.airportRows.forEach(row => {
    const code = member(row, 'airports_arrival.airport_code');
    const point = parseCoordinates(member(row, 'airports_arrival.coordinates'));
    if (code && point) coordinates.set(code, point);
  });
  const selectedCode = state.selectedAirport.code;
  const selectedPoint = coordinates.get(selectedCode) || state.selectedAirport.coordinates;
  if (!selectedPoint) return;
  state.mapRouteRows.forEach(row => {
    const departure = member(row, 'timetable.departure_airport');
    const arrival = member(row, 'timetable.arrival_airport');
    const otherCode = departure === selectedCode ? arrival : arrival === selectedCode ? departure : '';
    const otherPoint = coordinates.get(otherCode);
    if (!otherCode || !otherPoint) return;
    const line = L.polyline([[selectedPoint.lat, selectedPoint.lng], [otherPoint.lat, otherPoint.lng]], {
      color: '#2563a6',
      weight: Math.max(1.5, Math.min(6, 1.5 + Math.sqrt(numberValue(member(row, 'timetable.count'))) / 4)),
      opacity: 0.62,
      dashArray: '6 5',
    });
    line.bindTooltip(`${escapeHtml(member(row, 'timetable.route_no') || 'Rota')} · ${escapeHtml(departure)} → ${escapeHtml(arrival)} · ${formatNumber(member(row, 'timetable.count'))} voos`);
    line.addTo(state.routeLayer);
  });
}

async function loadAirportMapRoutes(code) {
  const version = ++state.mapRouteVersion;
  const routeQuery = memberName => ({
    dimensions: ['timetable.route_no', 'timetable.departure_airport', 'timetable.arrival_airport'],
    measures: ['timetable.count'],
    filters: [{ member: memberName, operator: 'equals', values: [code] }, ...sliceFilters({ status: true, country: true })],
    limit: 100,
    order: { 'timetable.count': 'desc' },
  });
  const [arrivalRows, departureRows] = await Promise.all([
    safeLoad(`rotas de chegada no mapa · ${code}`, routeQuery('timetable.arrival_airport')),
    safeLoad(`rotas de partida no mapa · ${code}`, routeQuery('timetable.departure_airport')),
  ]);
  if (version !== state.mapRouteVersion || state.selectedAirport?.code !== code) return;
  const rows = [...arrivalRows, ...departureRows];
  const unique = new Map();
  rows.forEach(row => {
    const key = [member(row, 'timetable.route_no'), member(row, 'timetable.departure_airport'), member(row, 'timetable.arrival_airport')].join('|');
    const current = unique.get(key) || { ...row, 'timetable.count': 0 };
    current['timetable.count'] += numberValue(member(row, 'timetable.count'));
    unique.set(key, current);
  });
  state.mapRouteRows = [...unique.values()];
  renderMapRoutes();
}

function renderMatrix() {
  const host = document.querySelector('#matrix-chart');
  const rows = state.dashboard.matrixRows || [];
  if (blockIsLoading('matrix') && state.dashboard.matrixRows === undefined) {
    host.innerHTML = componentLoading('Carregando matriz…');
    return;
  }
  if (!rows.length) { host.innerHTML = '<div class="chart-empty">Não há dados para esta matriz.</div>'; return; }
  const statuses = [...new Set(rows.map(row => member(row, 'timetable.status')).filter(Boolean))];
  const models = [...new Set(rows.map(row => member(row, 'airplanes.model')).filter(Boolean))].slice(0, 10);
  const values = new Map(rows.map(row => [`${member(row, 'timetable.status')}|${member(row, 'airplanes.model')}`, numberValue(member(row, 'timetable.count'))]));
  const max = Math.max(...values.values(), 1);
  host.innerHTML = `<table class="data-table matrix-table"><thead><tr><th>Status / model</th>${models.map(model => `<th>${escapeHtml(model)}</th>`).join('')}</tr></thead><tbody>${statuses.map(status => `<tr><td>${escapeHtml(status)}</td>${models.map(model => { const value = values.get(`${status}|${model}`) || 0; const heat = Math.max(0.06, Math.min(0.72, value / max * .72)); return `<td class="heat-cell" style="--heat:${heat}" data-matrix-status="${escapeHtml(status)}" data-matrix-model="${escapeHtml(model)}"><span>${value ? formatCompact(value) : '—'}</span></td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('[data-matrix-status]').forEach(node => node.addEventListener('click', () => selectMatrix(node.dataset.matrixStatus, node.dataset.matrixModel)));
}

function renderRoutes() {
  const rows = state.dashboard.routeRows || [];
  if (blockIsLoading('routes') && state.dashboard.routeRows === undefined) {
    document.querySelector('#routes-table').innerHTML = componentLoading('Carregando rotas…');
    document.querySelector('#routes-footer').innerHTML = '';
    return;
  }
  const start = state.routePage * PAGE_SIZE + 1;
  const end = start + rows.length - 1;
  document.querySelector('#routes-page-label').innerHTML = `<span class="tag">${rows.length ? `${start}–${end}` : '0 registros'}</span>`;
  if (!rows.length) {
    document.querySelector('#routes-table').innerHTML = '<div class="chart-empty">Nenhuma rota corresponde ao filtro.</div>';
    document.querySelector('#routes-footer').innerHTML = '';
    return;
  }
  document.querySelector('#routes-table').innerHTML = `<table class="data-table"><thead><tr><th>Rota</th><th>Partida</th><th>Chegada</th><th>Voos</th><th>Passageiros</th><th>Receita</th></tr></thead><tbody>${rows.map(row => `<tr data-route-airport="${escapeHtml(member(row, 'timetable.arrival_airport'))}"><td class="link-cell">${escapeHtml(member(row, 'timetable.route_no'))}</td><td class="link-cell">${escapeHtml(member(row, 'timetable.departure_airport'))}</td><td class="link-cell">${escapeHtml(member(row, 'timetable.arrival_airport'))}</td><td class="number">${formatNumber(member(row, 'timetable.count'))}</td><td class="number">${formatCompact(member(row, 'segments.count'))}</td><td class="number">${formatCurrency(member(row, 'segments.total_price'))}</td></tr>`).join('')}</tbody></table>`;
  document.querySelector('#routes-table').querySelectorAll('[data-route-airport]').forEach(row => row.addEventListener('click', () => selectAirport(row.dataset.routeAirport)));
  document.querySelector('#routes-footer').innerHTML = `<span>Página ${state.routePage + 1}</span><div class="pagination"><button id="routes-prev" class="button small" ${state.routePage === 0 ? 'disabled' : ''}>Anterior</button><button id="routes-next" class="button small" ${rows.length < PAGE_SIZE ? 'disabled' : ''}>Próxima</button></div>`;
  document.querySelector('#routes-prev')?.addEventListener('click', () => { state.routePage -= 1; loadDashboard(); });
  document.querySelector('#routes-next')?.addEventListener('click', () => { state.routePage += 1; loadDashboard(); });
}

function renderSelection() {
  const body = document.querySelector('#selection-body');
  const airport = state.selectedAirport;
  if (!airport) {
    body.className = 'selection-empty';
    body.innerHTML = 'Selecione um aeroporto para consultar os voos dessa dimensão.';
    return;
  }
  body.className = 'selection-content';
  body.innerHTML = `
    <div class="selection-kicker">aeroporto de chegada / membro da dimensão</div>
    <div class="selection-name">${escapeHtml(airport.name || airport.code)}</div>
    <div class="selection-code">${escapeHtml(airport.code || '—')}</div>
    <div class="selection-meta">
      <div><span>Cidade</span><strong>${escapeHtml(airport.city || '—')}</strong></div>
      <div><span>País</span><strong>${escapeHtml(airport.country || '—')}</strong></div>
      <div><span>Movimentos totais</span><strong>${formatNumber(airport.count)}</strong></div>
      <div><span>Coordenadas</span><strong>${airport.coordinates ? `${airport.coordinates.lat.toFixed(2)}, ${airport.coordinates.lng.toFixed(2)}` : '—'}</strong></div>
    </div>
    <div class="selection-detail">
      <div class="selection-detail-row"><span>Rota do detalhe</span><strong>arrival_airport = ${escapeHtml(airport.code)}</strong></div>
      <div class="selection-detail-row"><span>Origem semântica</span><strong>airports_arrival</strong></div>
      <div class="selection-detail-row"><span>Próxima consulta</span><strong>timetable + segmentos + aviões</strong></div>
    </div>
    <button id="airport-drill-button" class="button primary" style="width:100%; margin-top:20px">Abrir detalhe do aeroporto</button>
  `;
  body.querySelector('#airport-drill-button').addEventListener('click', () => loadAirportDetail(airport.code));
  document.querySelector('#selection-route').innerHTML = `<span class="tag good">${escapeHtml(airport.code)}</span>`;
}

function columnLabel(column) {
  const labels = {
    status: 'Status',
    route_no: 'Rota',
    departure_airport: 'Aeroporto de saída',
    arrival_airport: 'Aeroporto de chegada',
    model: 'Modelo',
    country: 'País',
    count: 'Quantidade',
    total_price: 'Valor total',
    price: 'Valor',
    type: 'Movimento',
    day: 'Data',
    month: 'Mês',
  };
  const key = column.split('.').slice(-1)[0];
  return labels[key] || key.replaceAll('_', ' ');
}

function renderAirportDetailBody() {
  const body = document.querySelector('#detail-body');
  const kpis = state.detail.kpis || { flights: 0, segments: 0, revenue: 0, arrivals: 0, departures: 0 };
  const routes = state.detail.topRoutes || [];
  body.innerHTML = `
    <div class="airport-drill">
      <div class="airport-kpi-grid">
        <div class="airport-kpi"><span>Número de voos</span><strong>${formatNumber(kpis.flights)}</strong><small>Chegadas ${formatNumber(kpis.arrivals)} · Partidas ${formatNumber(kpis.departures)}</small></div>
        <div class="airport-kpi"><span>Número de passageiros</span><strong>${formatCompact(kpis.segments)}</strong><small>Movimentos do aeroporto</small></div>
        <div class="airport-kpi"><span>Receita</span><strong>${formatCurrency(kpis.revenue)}</strong><small>USD · segmentos associados</small></div>
      </div>
      <div class="airport-drill-section">
        <div class="airport-drill-heading"><div><h3>Principais rotas</h3><p>Rotas de chegada e partida deste aeroporto</p></div><span class="tag good">${formatNumber(routes.length)} exibidas</span></div>
        ${routes.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Rota</th><th>Movimento</th><th>Partida</th><th>Chegada</th><th>Voos</th><th>Passageiros</th><th>Receita</th></tr></thead><tbody>${routes.map(route => `<tr><td>${escapeHtml(route.route)}</td><td>${escapeHtml(route.type)}</td><td>${escapeHtml(route.departure)}</td><td>${escapeHtml(route.arrival)}</td><td class="number">${formatNumber(route.flights)}</td><td class="number">${formatCompact(route.segments)}</td><td class="number">${formatCurrency(route.revenue)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="chart-empty">Nenhuma rota encontrada para este aeroporto.</div>'}
      </div>
    </div>
  `;
}

function renderDetail() {
  const panel = document.querySelector('#detail-modal');
  if (!state.detail) { panel.hidden = true; return; }
  panel.hidden = false;
  document.querySelector('#detail-title').textContent = String(state.detail.title).replace('Airport drill', 'Detalhe do aeroporto').replace('Period drill', 'Detalhe do período').replace('Matrix drill', 'Detalhe da matriz');
  document.querySelector('#detail-subtitle').textContent = String(state.detail.subtitle).replace('Arrival airport', 'Aeroporto de chegada').replace('status, aircraft, routes and segment value', 'status, aeronave, rotas e valor dos segmentos').replace('Scheduled departure month', 'Mês de partida').replace('status and arrival countries', 'status e países de chegada').replace('Status × aircraft', 'Status × aeronave').replace('route-level detail', 'detalhe por rota');
  const rows = state.detail.rows || [];
  if (state.detail.loading) {
    document.querySelector('#detail-body').innerHTML = '<div class="loading">Carregando consulta de detalhe…</div>';
    return;
  }
  if (state.detail.mode === 'airport') {
    renderAirportDetailBody();
    return;
  }
  if (!rows.length) {
    document.querySelector('#detail-body').innerHTML = '<div class="chart-empty">Nenhum registro encontrado para este detalhe.</div>';
    return;
  }
  const columns = Object.keys(rows[0]);
  const dimensions = columns.filter(column => !column.includes('.count') && !column.includes('.price'));
  const measures = columns.filter(column => !dimensions.includes(column));
  document.querySelector('#detail-body').innerHTML = `
    <div class="detail-content">
      <div class="table-wrap"><table class="data-table"><thead><tr>${dimensions.concat(measures).map(column => `<th>${escapeHtml(columnLabel(column))}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 100).map(row => `<tr>${dimensions.concat(measures).map(column => `<td class="${measures.includes(column) ? 'number' : ''}">${measures.includes(column) && column.includes('price') ? formatCurrency(row[column]) : measures.includes(column) ? formatCompact(row[column]) : escapeHtml(row[column])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="detail-callout"><h3>Sobre este detalhe</h3><p>Esta consulta usa a dimensão selecionada e os relacionamentos semânticos do Cube, sem trazer uma tabela bruta para o navegador.</p><div class="call-tags"><span class="tag good">${rows.length} registros</span><span class="tag">detalhe interativo</span><span class="tag">consulta no servidor</span></div></div>
    </div>
  `;
}

async function selectAirport(code, row = null, { openDetail = true } = {}) {
  if (!code) return;
  const source = row || state.airportRows.find(item => member(item, 'airports_arrival.airport_code') === code);
  const point = parseCoordinates(member(source, 'airports_arrival.coordinates'));
  state.selectedAirport = {
    code,
    name: member(source, 'airports_arrival.airport_name'),
    city: member(source, 'airports_arrival.city'),
    country: member(source, 'airports_arrival.country'),
    count: member(source, 'timetable.count'),
    coordinates: point,
  };
  window.location.hash = `airport=${encodeURIComponent(code)}`;
  renderSelection();
  const mapRoutesPromise = loadAirportMapRoutes(code);
  if (openDetail) await Promise.all([mapRoutesPromise, loadAirportMovementDetail(code)]);
  else await mapRoutesPromise;
}

async function loadAirportMovementDetail(code) {
  state.detail = { mode: 'airport', title: `Detalhe do aeroporto · ${code}`, subtitle: 'KPIs e principais rotas de chegada e partida', rows: [], loading: true };
  renderDetail();
  const routeQuery = memberName => ({
    dimensions: ['timetable.route_no', 'timetable.departure_airport', 'timetable.arrival_airport', 'airplanes.model'],
    measures: ['timetable.count', 'segments.count', 'segments.total_price'],
    filters: [{ member: memberName, operator: 'equals', values: [code] }, ...sliceFilters({ status: true, country: false })],
    limit: 100,
    order: { 'timetable.count': 'desc' },
  });
  const kpiQuery = memberName => ({
    measures: ['timetable.count', 'segments.count', 'segments.total_price'],
    filters: [{ member: memberName, operator: 'equals', values: [code] }, ...sliceFilters({ status: true, country: false })],
  });
  const [arrivalRows, departureRows, arrivalKpiRows, departureKpiRows] = await Promise.all([
    safeLoad(`detalhe de chegadas · ${code}`, routeQuery('timetable.arrival_airport')),
    safeLoad(`detalhe de partidas · ${code}`, routeQuery('timetable.departure_airport')),
    safeLoad(`KPIs de chegadas · ${code}`, kpiQuery('timetable.arrival_airport')),
    safeLoad(`KPIs de partidas · ${code}`, kpiQuery('timetable.departure_airport')),
  ]);
  const tagRows = (rows, type) => rows.map(row => ({ ...row, 'movement.type': type }));
  const detailRows = [...tagRows(arrivalRows, 'Chegada'), ...tagRows(departureRows, 'Partida')];
  const routeGroups = new Map();
  detailRows.forEach(row => {
    const route = member(row, 'timetable.route_no') || '—';
    const type = member(row, 'movement.type');
    const departure = member(row, 'timetable.departure_airport') || '—';
    const arrival = member(row, 'timetable.arrival_airport') || '—';
    const key = [type, route, departure, arrival].join('|');
    const current = routeGroups.get(key) || { route, type, departure, arrival, flights: 0, segments: 0, revenue: 0 };
    current.flights += numberValue(member(row, 'timetable.count'));
    current.segments += numberValue(member(row, 'segments.count'));
    current.revenue += numberValue(member(row, 'segments.total_price'));
    routeGroups.set(key, current);
  });
  const kpiValue = (rows, name) => numberValue(member(rows[0], name));
  state.detail.kpis = {
    arrivals: kpiValue(arrivalKpiRows, 'timetable.count'),
    departures: kpiValue(departureKpiRows, 'timetable.count'),
    flights: kpiValue(arrivalKpiRows, 'timetable.count') + kpiValue(departureKpiRows, 'timetable.count'),
    segments: kpiValue(arrivalKpiRows, 'segments.count') + kpiValue(departureKpiRows, 'segments.count'),
    revenue: kpiValue(arrivalKpiRows, 'segments.total_price') + kpiValue(departureKpiRows, 'segments.total_price'),
  };
  state.detail.topRoutes = [...routeGroups.values()].sort((left, right) => right.flights - left.flights).slice(0, 15);
  state.detail.rows = detailRows.slice(0, 100);
  state.detail.loading = false;
  renderDetail();
}

async function loadAirportDetail(code) {
  await loadAirportMovementDetail(code);
}

async function selectPeriod(period) {
  state.selectedPeriod = period;
  state.detail = { title: `Calendário · ${formatDate(period)}`, subtitle: 'Drill de calendário → volume diário, segmentos e receita', rows: [], loading: true };
  renderDetail();
  const start = `${String(period).slice(0, 7)}-01`;
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const end = date.toISOString().slice(0, 10);
  state.detail.rows = await safeLoad(`period drill · ${start}`, {
    timeDimensions: [{ dimension: 'timetable.scheduled_departure', granularity: 'day', dateRange: [start, end] }],
    measures: ['timetable.count', 'segments.count', 'segments.total_price'],
    filters: sliceFilters({ status: false, country: false }),
    limit: 100,
    order: { 'timetable.scheduled_departure.day': 'asc' },
  });
  state.detail.loading = false;
  renderDetail();
}

async function selectMatrix(status, model) {
  state.matrixFocus = { status, model };
  state.detail = { title: `Matrix drill · ${status} / ${model}`, subtitle: 'Status × aircraft → route-level detail', rows: [], loading: true };
  renderDetail();
  state.detail.rows = await safeLoad(`matrix drill · ${status} · ${model}`, {
    dimensions: ['timetable.route_no', 'timetable.departure_airport', 'timetable.arrival_airport', 'timetable.status', 'airplanes.model'],
    measures: ['timetable.count', 'segments.count', 'segments.total_price'],
    filters: [
      { member: 'timetable.status', operator: 'equals', values: [status] },
      { member: 'airplanes.model', operator: 'equals', values: [model] },
      ...sliceFilters({ status: false, country: true }),
    ],
    limit: 100,
    order: { 'timetable.count': 'desc' },
  });
  state.detail.loading = false;
  renderDetail();
}

function closeDetail() {
  state.detail = null;
  state.selectedPeriod = null;
  state.matrixFocus = null;
  if (state.selectedAirport) window.location.hash = `airport=${encodeURIComponent(state.selectedAirport.code)}`;
  else window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  renderDetail();
}

function handleHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const code = params.get('airport');
  if (code && code !== state.selectedAirport?.code) {
    const source = state.airportRows.find(row => member(row, 'airports_arrival.airport_code') === code);
    selectAirport(code, source);
  }
}

function renderCallLog() {
  const summary = document.querySelector('#calls-summary');
  const total = state.calls.length;
  const successful = state.calls.filter(call => call.status === 'success');
  const average = successful.length ? successful.reduce((sum, call) => sum + call.duration, 0) / successful.length : 0;
  const aggregateCalls = successful.filter(call => call.preAggregations.length);
  summary.innerHTML = `<span>requests <strong>${total}</strong></span><span>avg latency <strong>${average ? formatDuration(average) : '—'}</strong></span><span>rows returned <strong>${formatNumber(successful.reduce((sum, call) => sum + call.rows, 0))}</strong></span><span>pre-aggregated <strong>${aggregateCalls.length}/${successful.length || 0}</strong></span>`;
  summary.innerHTML = summary.innerHTML
    .replace('requests', 'chamadas')
    .replace('avg latency', 'latência média')
    .replace('rows returned', 'registros retornados')
    .replace('pre-aggregated', 'pré-agregadas');
  const log = document.querySelector('#call-log');
  if (!total) { log.innerHTML = '<div class="chart-empty" style="margin:16px">Nenhuma chamada registrada ainda.</div>'; return; }
  log.innerHTML = state.calls.map(call => {
    const open = state.expandedCall === call.id;
    const tags = [
      call.status === 'success' ? '<span class="tag good">200 / sucesso</span>' : '<span class="tag warn">erro</span>',
      `<span class="tag">${formatDuration(call.duration)}</span>`,
      `<span class="tag">${formatNumber(call.rows)} registros</span>`,
      call.preAggregations.length ? `<span class="tag good">pré-agregação ${call.preAggregations.length}</span>` : '<span class="tag">caminho do cache</span>',
      call.slowQuery ? '<span class="tag warn">lenta</span>' : '',
    ].join('');
    return `<div class="call-row"><button class="call-head" data-call-id="${call.id}"><span class="call-label"><span class="call-type">${escapeHtml(call.type)}</span> ${escapeHtml(call.label)}</span><span class="call-meta">${escapeHtml(call.method)}</span><span class="call-meta">${formatDuration(call.duration)}</span><span class="call-meta ${call.status === 'error' ? 'call-error' : ''}">${call.status === 'success' ? `${formatNumber(call.rows)} rows` : 'failed'}</span><span>${open ? '−' : '+'}</span></button>${open ? `<div class="call-detail"><div><div class="call-tags">${tags}</div><div style="margin-top:9px;color:var(--muted);font-size:11px">requestId: ${escapeHtml(call.requestId || 'n/a')}<br />refresh: ${escapeHtml(call.lastRefreshTime || 'n/a')}</div></div><pre class="code-block">${escapeHtml(JSON.stringify(call.query || { endpoint: call.url }, null, 2))}</pre><pre class="code-block">${escapeHtml(JSON.stringify({ usedPreAggregations: call.preAggregations, slowQuery: call.slowQuery, requestId: call.requestId, lastRefreshTime: call.lastRefreshTime, error: call.response?.error || null }, null, 2))}</pre></div>` : ''}</div>`;
  }).join('');
  log.innerHTML = log.innerHTML.replaceAll(' rows', ' registros').replaceAll('failed', 'falhou').replaceAll('requestId', 'id da requisição').replaceAll('refresh', 'atualização');
  log.querySelectorAll('[data-call-id]').forEach(button => button.addEventListener('click', () => {
    state.expandedCall = state.expandedCall === button.dataset.callId ? null : button.dataset.callId;
    renderCallLog();
  }));
}

function exportCalls() {
  const blob = new Blob([JSON.stringify(state.calls, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `aviacao-api-calls-${new Date().toISOString().replaceAll(':', '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

let toastTimer;
function showToast(message, error = false) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast visible${error ? ' error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.className = 'toast'; }, 4500);
}

renderShell();
bindEvents();
renderCallLog();
initialize();
