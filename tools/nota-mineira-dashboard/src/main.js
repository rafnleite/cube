import * as echarts from 'echarts';
import sqlFormatter from 'sql-formatter';
import './styles.css';

const DATAMART = 'nota_mineira_2';
const START = '2024-08-04';
const COLORS = ['#741b79', '#e84375', '#f15a24', '#d8a000', '#3478b7', '#198b68', '#8f4ca4', '#1967a8', '#a24627', '#5b7d20', '#b24d7c', '#28665c'];
const PAGES = [
  ['ativos', 'Participantes ativos'],
  ['premiacoes', 'Premiações'],
  ['bilhetagem', 'Bilhetagem'],
  ['requisicoes', 'Requisições'],
  ['documentos', 'Documentos por dia'],
  ['vencer', 'Premiações a vencer'],
  ['placar', 'Placar NFM'],
  ['participante', 'Participante'],
  ['entidade', 'Entidade'],
  ['municipio', 'Município'],
  ['regiao', 'Região fiscal'],
];

const today = new Date().toISOString().slice(0, 10);
const REPORT_DATE_FORMATTER = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const state = {
  page: new URLSearchParams(location.search).get('pagina') || 'ativos',
  from: START,
  to: today,
  activeTableFrom: START,
  activeTableTo: today,
  awardTableFrom: START,
  awardTableTo: today,
  awardOverviewFrom: START,
  awardOverviewTo: today,
  awardWinnersFrom: START,
  awardWinnersTo: today,
  awardWinnersPage: 0,
  awardWinnersPageSize: 20,
  awardWinnersSearch: '',
  awardWinnersSort: 'valor',
  awardWinnersDirection: 'desc',
  awardWinnersRequest: 0,
  awardWinnersPageCache: new Map(),
  awardWinnersTotalsCache: new Map(),
  ticketTopPage: 0,
  ticketTopPageSize: 20,
  ticketTopSearch: '',
  ticketTopRequest: 0,
  ticketTopPageCache: new Map(),
  ticketTopTotalsCache: new Map(),
  awardMatrixRows: [],
  awardMatrixCube: '',
  awardMatrixAmount: '',
  awardMatrixPage: 0,
  awardMatrixRequest: 0,
  region: '',
  origin: localStorage.getItem('nfm-api-origin') || '',
  token: localStorage.getItem('nfm-api-token') || '',
  snapshot: '',
  version: 0,
  calls: [],
  charts: new Map(),
  tables: new Map(),
  cache: new Map(),
  activeMunicipalCache: new Map(),
  resultQueries: new WeakMap(),
  awardType: 'participantes',
  awardMetric: 'quantidade',
  bilhetagem: '',
  bilhetagemType: '',
  bilhetagemSelectedType: '',
  ticketHistogramMetric: 'participantes',
  ticketHistogramRows: { participantes: [], bilhetes: [] },
  ticketOverviewCache: null,
  activeGroup: 'municipio',
  activeHierarchy: null,
  activeChurn: { showStart: true, showEnd: true },
  activeDrillRegion: '',
  activeDrillMunicipality: '',
  params: {
    participant: new URLSearchParams(location.search).get('participante') || '',
    entity: new URLSearchParams(location.search).get('entidade') || '',
    municipality: new URLSearchParams(location.search).get('municipio') || '',
    regionDetail: new URLSearchParams(location.search).get('regiao') || '',
  },
};

const app = document.querySelector('#app');
let callsTimer = 0;

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function num(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function val(row, key) {
  if (!row || !key) return '';
  if (row[key] != null) return row[key];
  // The load endpoint normally returns `cube.member`, while the SQL
  // endpoint/adapter may expose the same column as `cube__member`.
  const member = String(key);
  const aliases = [member.replaceAll('.', '__'), member.replaceAll('.', '_')];
  const alias = aliases.find(candidate => row[candidate] != null);
  if (alias) return row[alias];
  // Keep the merge resilient when a view/adapter adds its own cube prefix.
  const suffix = member.slice(member.lastIndexOf('.') + 1);
  const prefixed = Object.keys(row).find(candidate => candidate.endsWith('.' + suffix) || candidate.endsWith('__' + suffix) || candidate.endsWith('_' + suffix));
  return prefixed ? row[prefixed] : '';
}
function dateKey(value) {
  const key = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : '';
}
function day(value) { return dateKey(value); }
function formatReportDate(value) {
  const key = dateKey(value);
  return key ? REPORT_DATE_FORMATTER.format(new Date(key + 'T00:00:00Z')) : (String(value || '') || '—');
}
function formatReportValue(value, format) {
  if (format === 'number') return n(value);
  if (format === 'compact') return compact(value);
  if (format === 'money') return money(value);
  if (format === 'percent') return pct(value);
  if (format === 'date') return formatReportDate(value);
  return String(value ?? '') || '—';
}
function formatReportChartDates(option) {
  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis];
  axes.filter(axis => axis && axis.type === 'category' && Array.isArray(axis.data) && axis.data.length && axis.data.every(dateKey))
    .forEach(axis => { axis.data = axis.data.map(formatReportDate); });
  return option;
}
function n(value) { return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(num(value)); }
function compact(value) { return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumSignificantDigits: 3 }).format(num(value)); }
function money(value) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(num(value)); }
function compactMoney(value) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumSignificantDigits: 3 }).format(num(value)); }
function pct(value) { return new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(num(value)); }
function chartNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? new Intl.NumberFormat('pt-BR', { useGrouping: true, maximumFractionDigits: 2 }).format(parsed) : String(value ?? '—');
}
function chartTooltip(params) {
  const items = Array.isArray(params) ? params : [params];
  if (!items.length) return '';
  const axisLabel = items[0].axisValueLabel || items[0].axisValue || '';
  const title = axisLabel || items[0].name || '';
  return [title, ...items.map(item => {
    const value = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
    const label = axisLabel ? item.seriesName : (item.name || item.seriesName || 'Valor');
    return (item.marker || '') + esc(label) + ': <strong>' + chartNumber(value) + '</strong>';
  })].filter(Boolean).join('<br>');
}
function ms(value) { return value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(2) + ' s'; }
function addDays(value, amount) { const d = new Date(value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10); }
function rangeLabel() { return formatReportDate(state.from) + ' a ' + formatReportDate(state.to); }
function origin() { return state.origin.replace(/\/$/, ''); }
function endpoint(path) { return origin() + path; }
function loadUrl() { return endpoint('/cubejs-api/datamarts/' + DATAMART + '/v1/load'); }
function metaUrl() { return endpoint('/cubejs-api/datamarts/' + DATAMART + '/v1/meta'); }
function sqlUrl() { return endpoint('/cubejs-api/datamarts/' + DATAMART + '/v1/sql'); }
function dateFilter(member, from = state.from, to = state.to, granularity = 'day') {
  return [{ dimension: member, granularity, dateRange: [from, to] }];
}
function dateRangeFilter(member, from = state.from, to = state.to) {
  return [{ member, operator: 'inDateRange', values: [from, to] }];
}
function regionFilter() {
  return state.region ? filter(activeHierarchyMember('regiao'), state.region) : [];
}
function activeRegionFilter() {
  if (state.activeDrillMunicipality) return filter(activeHierarchyMember('municipio'), state.activeDrillMunicipality);
  return state.activeDrillRegion ? filter(activeHierarchyMember('regiao'), state.activeDrillRegion) : regionFilter();
}
function latestUpdateFilter() {
  return [{ member: 'tf_participante_adesao.fl_last_update', operator: 'equals', values: ['1'] }];
}
function filter(member, value) {
  return value === '' || value == null ? [] : [{ member, operator: 'equals', values: [String(value)] }];
}
function query(label, queryObject) { return safeLoad(label, queryObject); }

function addCall(call) {
  const existing = state.calls.findIndex(item => item.id === call.id);
  if (existing >= 0) state.calls[existing] = call;
  else state.calls.unshift(call);
  state.calls = state.calls.slice(0, 120);
  renderCalls();
}
async function request(label, url, options, queryObject) {
  const started = performance.now();
  const call = { id: Date.now() + '-' + Math.random().toString(36).slice(2), label, url, method: options.method || 'GET', duration: 0, startedAt: started, rows: 0, status: 'pending', query: queryObject || null, response: null, requestId: '', slow: false };
  addCall(call);
  try {
    const response = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: state.token } : {}), ...(options.headers || {}) } });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = { error: raw }; }
    call.duration = performance.now() - started;
    call.rows = Array.isArray(body.data) ? body.data.length : Array.isArray(body.cubes) ? body.cubes.length : 0;
    call.status = response.ok && !body.error ? 'sucesso' : 'erro';
    call.response = body;
    call.requestId = body.requestId || '';
    call.slow = Boolean(body.slowQuery);
    addCall(call);
    if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : JSON.stringify(body.error || body));
    return body;
  } catch (error) {
    if (call.status === 'pending') { call.duration = performance.now() - started; call.status = 'erro'; call.response = { error: error.message || String(error) }; addCall(call); }
    throw error;
  }
}
async function cubeLoad(label, queryObject) {
  const payload = { query: queryObject };
  const key = JSON.stringify(payload);
  if (state.cache.has(key)) return state.cache.get(key);
  const pending = request(label, loadUrl(), { method: 'POST', body: JSON.stringify(payload) }, queryObject).then(body => {
    const rows = Array.isArray(body.data) ? body.data : [];
    state.resultQueries.set(rows, queryObject);
    return rows;
  }).finally(() => state.cache.delete(key));
  state.cache.set(key, pending);
  return pending;
}
async function safeLoad(label, queryObject) {
  try { return await cubeLoad(label, queryObject); } catch (error) {
    const rows = [];
    state.resultQueries.set(rows, queryObject);
    showToast('Falha em ' + label + ': ' + error.message, true);
    return rows;
  }
}
async function queryAll(label, queryObject, pageSize = 5000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const pageQuery = { ...queryObject, limit: pageSize, offset };
    let page;
    try {
      page = await cubeLoad(label + ' · página ' + (offset / pageSize + 1), pageQuery);
    } catch (error) {
      if (!offset) throw error;
      const fallbackQuery = { ...queryObject, limit: offset + pageSize };
      delete fallbackQuery.offset;
      const fallbackRows = await cubeLoad(label + ' · compatibilidade', fallbackQuery);
      page = fallbackRows.slice(offset, offset + pageSize);
    }
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  state.resultQueries.set(rows, queryObject);
  return rows;
}
function card(id, title, subtitle, controls = '') {
  if (id === 'ticket-summary') return standaloneMetricBlock(id, title, subtitle, 5);
  if (id === 'ticket-histogram') { title = 'Histograma por faixa'; subtitle = 'Quantidade de municípios ou regiões em cada faixa da bilhetagem selecionada.'; controls = ticketHistogramControls(); }
  return '<section class="panel" id="' + esc(id) + '"><div class="panel-head"><div><h2>' + esc(title) + '</h2>' + (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') + '</div><div class="panel-head-actions">' + controls + '<span class="loading-pill">Carregando…</span></div></div><div class="panel-body"><div class="skeleton"></div></div></section>';
}
function pageHeading(title, text, controls) {
  return '<div class="page-heading"><div><span class="eyebrow">Nota Fiscal Mineira</span><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></div>' + (controls || '') + '</div>';
}
function setBlock(id, html) {
  const node = document.getElementById(id);
  if (!node) return;
  const body = node.querySelector('.panel-body');
  const pill = node.querySelector('.loading-pill');
  if (body) body.innerHTML = html;
  if (id === 'award-winners') {
    const input = body?.querySelector('#award-winners-search');
    const label = input?.closest('label');
    const identifier = state.awardType === 'entidades' ? 'CNPJ' : 'CPF';
    if (label?.firstChild) label.firstChild.nodeValue = 'Buscar ' + identifier + ' ou Nome';
    if (input) input.placeholder = 'Digite ' + identifier + ' ou nome e clique em Buscar';
  }
  if (pill) pill.remove();
}
function beginBlockLoading(id, selector, mode) {
  const node = document.getElementById(id);
  if (!node) return;
  const body = (selector && node.querySelector(selector)) || node.querySelector('.panel-body, .metric-card-grid') || node;
  const count = Number(node.dataset.loadingCount || 0) + 1;
  node.dataset.loadingCount = String(count);
  node.setAttribute('aria-busy', 'true');
  body.classList.add('is-loading');
  if (mode === 'table') {
    if (!body.querySelector(':scope > .table-loading-overlay')) body.insertAdjacentHTML('beforeend', '<div class="table-loading-overlay" role="status">Carregando dados…</div>');
  } else if (!body.querySelector(':scope > .loading-overlay')) body.insertAdjacentHTML('beforeend', '<div class="loading-overlay skeleton" role="status" aria-label="Carregando dados"></div>');
}
function endBlockLoading(id, selector, mode) {
  const node = document.getElementById(id);
  if (!node) return;
  const count = Math.max(0, Number(node.dataset.loadingCount || 1) - 1);
  node.dataset.loadingCount = String(count);
  if (count > 0) return;
  node.removeAttribute('aria-busy');
  const body = (selector && node.querySelector(selector)) || node.querySelector('.panel-body, .metric-card-grid') || node;
  body.classList.remove('is-loading');
  body.querySelectorAll(':scope > .loading-overlay').forEach(overlay => overlay.remove());
  body.querySelectorAll(':scope > .table-loading-overlay').forEach(overlay => overlay.remove());
}
function flashBlockLoading(id, duration = 280) {
  beginBlockLoading(id);
  window.setTimeout(() => endBlockLoading(id), duration);
}
function flashTableLoading(id, duration = 420) {
  const host = document.getElementById(id);
  if (!host) return;
  host.classList.add('table-is-loading');
  host.setAttribute('aria-busy', 'true');
  window.clearTimeout(host.__loadingTimer);
  host.__loadingTimer = window.setTimeout(() => {
    host.classList.remove('table-is-loading');
    host.removeAttribute('aria-busy');
  }, duration);
}
function beginStandaloneMetricsLoading(id) {
  const node = document.getElementById(id);
  if (!node) return;
  const grid = node.querySelector('.metric-card-grid');
  const count = Math.max(1, grid?.children.length || (id === 'ticket-summary' ? 5 : 3));
  node.dataset.loadingCount = String(Number(node.dataset.loadingCount || 0) + 1);
  node.setAttribute('aria-busy', 'true');
  if (grid) grid.innerHTML = Array.from({ length: count }, () => '<article class="metric-card metric-card-loading"><div class="skeleton"></div></article>').join('');
}
function queriesForResults(results) {
  const unique = new Map();
  results.forEach(result => {
    const queryObject = Array.isArray(result) ? state.resultQueries.get(result) : null;
    if (queryObject) unique.set(JSON.stringify(queryObject), queryObject);
  });
  return [...unique.values()];
}
function bindPanelSql(id, results) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const queries = queriesForResults(results);
  panel.dataset.sqlQueries = JSON.stringify(queries);
  const buttonLabel = queries.length > 1 ? 'Copiar SQL (' + queries.length + ')' : 'Copiar SQL';
  panel.querySelectorAll('[data-copy-panel-sql]').forEach(button => { button.textContent = buttonLabel; });
}
function standaloneMetricBlock(id, title, subtitle, count = 3) {
  const placeholders = Array.from({ length: count }, () => '<article class="metric-card metric-card-loading"><div class="skeleton"></div></article>').join('');
  return '<section class="standalone-metrics" id="' + esc(id) + '"><div class="standalone-metrics-head"><div><h2>' + esc(title) + '</h2>' + (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') + '</div><div class="report-actions"><button class="text-button" data-copy-panel-sql="1">Copiar SQL</button><button class="text-button" data-copy-panel-api="1">Copiar chamada API</button></div></div><div class="metric-card-grid">' + placeholders + '</div></section>';
}
function metricCards(items) {
  return items.map(item => '<article class="metric-card"><span>' + esc(item.label) + '</span><strong>' + esc(item.value) + '</strong>' + (item.note ? '<small>' + esc(item.note) + '</small>' : '') + '</article>').join('');
}
function ticketHistogramControls() {
  return '<div class="metric-toggle ticket-histogram-toggle"><span>Distribuir por</span><button data-ticket-histogram-metric="participantes" class="' + (state.ticketHistogramMetric === 'participantes' ? 'selected' : '') + '">Participantes</button><button data-ticket-histogram-metric="bilhetes" class="' + (state.ticketHistogramMetric === 'bilhetes' ? 'selected' : '') + '">Bilhetes</button></div>';
}
function isStatewideBilhetagem() {
  return /estadual|estado|especial/i.test(String(state.bilhetagemSelectedType || ''));
}
async function loadStandaloneMetrics(id, taskFactory, renderer) {
  const version = state.version;
  const node = document.getElementById(id);
  if (!node) return;
  beginStandaloneMetricsLoading(id);
  try {
    const results = await Promise.all(taskFactory());
    if (version !== state.version) return;
    const content = node.querySelector('.metric-card-grid');
    if (content) content.innerHTML = renderer(...results);
    bindPanelSql(id, results);
  } catch (error) {
    if (version === state.version) node.innerHTML = '<div class="empty error">Não foi possível carregar estes indicadores.</div>';
  } finally {
    if (version === state.version) endBlockLoading(id);
  }
}
async function loadBlock(id, taskFactory, renderer, loadingOptions = {}) {
  if (id === 'ticket-summary') {
    loadStandaloneMetrics(id, taskFactory, ticketSummaryMetrics);
    return;
  }
  if (id === 'ticket-top') {
    loadTicketTopPaged(loadingOptions.selector ? loadingOptions : { selector: '.table-wrap', mode: 'table' });
    return;
  }
  if (id === 'ticket-histogram') {
    loadTicketHistogram();
    return;
  }
  const version = state.version;
  beginBlockLoading(id, loadingOptions.selector, loadingOptions.mode);
  try {
    const results = await Promise.all(taskFactory());
    if (version !== state.version) return;
    const content = renderer(...results);
    if (content == null) return;
    setBlock(id, content);
    bindPanelSql(id, results);
  } catch (error) {
    if (version === state.version) {
      const detail = id === 'award-winners' && error?.message ? '<small>' + esc(error.message) + '</small>' : '';
      setBlock(id, '<div class="empty error">Não foi possível carregar esta seção.' + detail + '</div>');
    }
  } finally {
    if (version === state.version) endBlockLoading(id, loadingOptions.selector, loadingOptions.mode);
  }
}
let chartResizeTimer = 0;
function resizeCharts() {
  window.clearTimeout(chartResizeTimer);
  chartResizeTimer = window.setTimeout(() => {
    state.charts.forEach(instance => {
      if (!instance.isDisposed()) instance.resize();
    });
  }, 100);
}
window.addEventListener('resize', resizeCharts);
function disposeCharts() {
  state.charts.forEach(chart => chart.dispose());
  state.charts.clear();
}
function chart(id, rows, option, description) {
  window.setTimeout(() => {
    const node = document.getElementById(id);
    if (!node) return;
    const old = state.charts.get(id);
    if (old) old.dispose();
    const instance = echarts.init(node);
    const chartOption = { ...option };
    const onClick = chartOption.onClick;
    delete chartOption.onClick;
    formatReportChartDates(chartOption);
    instance.setOption({
      color: COLORS,
      textStyle: { fontFamily: 'Inter, Arial, sans-serif' },
      ...chartOption,
      tooltip: {
        trigger: 'axis',
        formatter: chartTooltip,
        renderMode: 'html',
        appendToBody: true,
        confine: false,
        ...(chartOption.tooltip || {}),
      },
    });
    if (onClick) instance.on('click', onClick);
    state.charts.set(id, instance);
  }, 0);
  window.__nfmExports = window.__nfmExports || {};
  window.__nfmExports[id] = rows;
  return '<div class="chart-tools"><span>' + esc(description || '') + '</span><div class="report-actions"><button class="text-button" data-copy-panel-sql="1">Copiar SQL</button><button class="text-button" data-copy-panel-api="1">Copiar chamada API</button><button class="text-button" data-export="' + esc(id) + '">Exportar Excel</button></div></div><div class="chart" id="' + esc(id) + '"></div>';
}
function chartRows(rows, fields) {
  return rows.map(row => fields.map(field => val(row, field)));
}
function table(id, rows, columns, options = {}) {
  state.tables.set(id, { rows, columns, page: 0, sort: options.sort || columns.find(item => item.measure)?.key || columns[0]?.key, direction: options.direction || 'desc', search: '', showFilter: options.showFilter !== false, showTotal: options.showTotal !== false });
  return '<div id="' + esc(id) + '" class="table-host"></div>';
}
function renderTable(id) {
  const source = state.tables.get(id);
  const host = document.getElementById(id);
  if (!source || !host) return;
  const activeFilter = document.activeElement && document.activeElement.dataset.tableFilter === id ? document.activeElement : null;
  const selectionStart = activeFilter && typeof activeFilter.selectionStart === 'number' ? activeFilter.selectionStart : null;
  const selectionEnd = activeFilter && typeof activeFilter.selectionEnd === 'number' ? activeFilter.selectionEnd : null;
  const needle = source.search.trim().toLocaleLowerCase('pt-BR');
  const rows = source.rows.filter(row => !needle || source.columns.some(col => String(val(row, col.key)).toLocaleLowerCase('pt-BR').includes(needle))).sort((a, b) => {
    const aa = val(a, source.sort); const bb = val(b, source.sort);
    const compare = Number.isFinite(Number(aa)) && Number.isFinite(Number(bb)) ? num(aa) - num(bb) : String(aa).localeCompare(String(bb), 'pt-BR', { numeric: true });
    return source.direction === 'asc' ? compare : -compare;
  });
  const size = 12; const pages = Math.max(1, Math.ceil(rows.length / size)); source.page = Math.min(source.page, pages - 1);
  const view = rows.slice(source.page * size, source.page * size + size);
  const header = source.columns.map(col => '<th' + (col.measure ? ' class="measure"' : '') + '><button class="sort-button" data-table-sort="' + esc(id) + '" data-key="' + esc(col.key) + '">' + esc(col.label) + (source.sort === col.key ? (source.direction === 'asc' ? ' ↑' : ' ↓') : '') + '</button></th>').join('');
  const body = view.length ? view.map(row => '<tr>' + source.columns.map(col => {
    const raw = val(row, col.key); const display = esc(formatReportValue(raw, col.format));
    const drillKind = col.menuDrill || col.drill;
    const classes = [col.measure ? 'measure' : '', drillKind ? 'drill' : ''].filter(Boolean).join(' ');
    const fullValue = col.format === 'compact' && raw !== '' ? ' title="' + esc(formatReportValue(raw, 'number')) + '"' : '';
    const menuDrill = drillKind ? ' data-drill-menu="' + esc(drillKind) + '" data-drill-mode="' + (col.drillThroughOnly ? 'through' : '') + '" data-value="' + esc(raw) + '"' : '';
    return '<td' + (classes ? ' class="' + classes + '"' : '') + fullValue + menuDrill + '>' + display + '</td>';
  }).join('') + '</tr>').join('') : '<tr><td colspan="' + source.columns.length + '" class="empty">Nenhum registro encontrado.</td></tr>';
  const totalLabelColumn = source.columns.find(col => !col.measure);
  const totalValues = {};
  source.columns.filter(col => col.measure).forEach(col => {
    if (col.format === 'percent') {
      const numerator = col.key.includes('NFM')
        ? source.columns.find(candidate => candidate.key.includes('NFCe NFM'))
        : col.key.includes('CPF')
          ? source.columns.find(candidate => candidate.key.includes('NFCe com CPF'))
          : null;
      const denominator = source.columns.find(candidate => candidate.key === 'NFCe');
      totalValues[col.key] = numerator && denominator
        ? (source.rows.reduce((sum, row) => sum + num(val(row, numerator.key)), 0) / Math.max(1, source.rows.reduce((sum, row) => sum + num(val(row, denominator.key)), 0)))
        : '';
    } else {
      totalValues[col.key] = source.rows.reduce((sum, row) => sum + num(val(row, col.key)), 0);
    }
  });
  const totals = source.showTotal ? '<tfoot><tr>' + source.columns.map(col => {
    const raw = col.measure ? totalValues[col.key] : (totalLabelColumn && col.key === totalLabelColumn.key ? 'Total' : '');
    const fullValue = col.format === 'compact' && raw !== '' ? ' title="' + esc(formatReportValue(raw, 'number')) + '"' : '';
    return '<td' + (col.measure ? ' class="measure"' : '') + fullValue + '>' + esc(raw === '' ? '—' : formatReportValue(raw, col.format)) + '</td>';
  }).join('') + '</tr></tfoot>' : '';
  host.innerHTML = '<div class="table-actions"><label>Filtrar <input data-table-filter="' + esc(id) + '" value="' + esc(source.search) + '" placeholder="Pesquisar"></label><button class="text-button" data-export-table="' + esc(id) + '">Exportar Excel</button></div><div class="table-wrap"><table><thead><tr>' + header + '</tr></thead><tbody>' + body + '</tbody>' + totals + '</table></div><div class="pager"><span>' + n(rows.length) + ' registros</span><div><button data-table-page="' + esc(id) + '" data-direction="-1" ' + (source.page === 0 ? 'disabled' : '') + '>Anterior</button><span>Página ' + (source.page + 1) + ' de ' + pages + '</span><button data-table-page="' + esc(id) + '" data-direction="1" ' + (source.page === pages - 1 ? 'disabled' : '') + '>Próxima</button></div></div>';
  if (!source.showFilter) host.querySelector('.table-actions label')?.remove();
  const actions = host.querySelector('.table-actions');
  if (actions) actions.insertAdjacentHTML('beforeend', '<span class="report-actions"><button class="text-button" data-copy-panel-sql="1">Copiar SQL</button><button class="text-button" data-copy-panel-api="1">Copiar chamada API</button></span>');
  if (activeFilter) {
    const nextFilter = host.querySelector('input[data-table-filter]');
    if (nextFilter) {
      nextFilter.focus();
      if (selectionStart !== null) nextFilter.setSelectionRange(selectionStart, selectionEnd);
    }
  }
}
function renderAllTables() { state.tables.forEach((_, id) => renderTable(id)); }
function exportExcel(name, rows, columns = []) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const outputColumns = columns.length ? columns : keys.map(key => ({ key, label: key, format: /^data($|\s)/i.test(key) ? 'date' : undefined }));
  const head = outputColumns.map(column => '<th>' + esc(column.label || column.key) + '</th>').join('');
  const body = rows.map(row => '<tr>' + outputColumns.map(column => '<td>' + esc(formatReportValue(val(row, column.key), column.format)) + '</td>').join('') + '</tr>').join('');
  const blob = new Blob(['<html><head><meta charset="UTF-8"></head><body><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></body></html>'], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name + '.xls'; link.click(); URL.revokeObjectURL(link.href);
}
function tableHtml(id, title, rows, columns, options) {
  const output = table(id, rows, columns, options);
  window.setTimeout(renderTable, 0, id);
  return '<h3 class="subheading">' + esc(title) + '</h3>' + output;
}
function awardMatrixHtml(id, rows, cube, amount) {
  const dateMember = cube + '.dt_sorteio.day';
  const statusMember = 'td_premio_status.ds_premio_status';
  const statuses = [...new Set(rows.map(row => val(row, statusMember)).filter(Boolean))];
  const byDate = new Map();
  const totalsByStatus = new Map(statuses.map(status => [status, { quantity: 0, amount: 0 }]));
  rows.forEach(row => {
    const date = day(val(row, dateMember));
    const status = val(row, statusMember);
    if (!date || !status) return;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const current = byDate.get(date).get(status) || { quantity: 0, amount: 0 };
    current.quantity += num(val(row, cube + '.count'));
    current.amount += num(val(row, amount));
    byDate.get(date).set(status, current);
    const statusTotal = totalsByStatus.get(status) || { quantity: 0, amount: 0 };
    statusTotal.quantity += num(val(row, cube + '.count'));
    statusTotal.amount += num(val(row, amount));
    totalsByStatus.set(status, statusTotal);
  });
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  const pageSize = 12;
  const pages = Math.max(1, Math.ceil(dates.length / pageSize));
  state.awardMatrixPage = Math.min(state.awardMatrixPage, pages - 1);
  const page = state.awardMatrixPage;
  const visibleDates = dates.slice(page * pageSize, page * pageSize + pageSize);
  const total = { quantity: 0, amount: 0 };
  totalsByStatus.forEach(value => { total.quantity += value.quantity; total.amount += value.amount; });
  const cell = value => value.quantity || value.amount ? n(value.quantity) + ' <span class="matrix-value">(' + esc(money(value.amount)) + ')</span>' : '<span class="matrix-empty">—</span>';
  const exportRows = dates.map(date => {
    const values = byDate.get(date);
    const dateTotal = { quantity: 0, amount: 0 };
    const output = { Data: date };
    statuses.forEach(status => {
      const value = values.get(status) || { quantity: 0, amount: 0 };
      output[status] = value.quantity || value.amount ? n(value.quantity) + ' (' + money(value.amount) + ')' : '—';
      dateTotal.quantity += value.quantity;
      dateTotal.amount += value.amount;
    });
    output.Total = dateTotal.quantity || dateTotal.amount ? n(dateTotal.quantity) + ' (' + money(dateTotal.amount) + ')' : '—';
    return output;
  });
  window.__nfmExports = window.__nfmExports || {};
  window.__nfmExports[id] = exportRows;
  const head = '<tr><th>Data de sorteio</th>' + statuses.map(status => '<th>' + esc(status) + '</th>').join('') + '<th>Total</th></tr>';
  const body = visibleDates.map(date => {
    const values = byDate.get(date);
    const rowTotal = { quantity: 0, amount: 0 };
    const cells = statuses.map(status => {
      const value = values.get(status) || { quantity: 0, amount: 0 };
      rowTotal.quantity += value.quantity;
      rowTotal.amount += value.amount;
      return '<td>' + cell(value) + '</td>';
    }).join('');
    return '<tr><th class="matrix-date">' + esc(formatReportDate(date)) + '</th>' + cells + '<td class="matrix-total">' + cell(rowTotal) + '</td></tr>';
  }).join('');
  const foot = '<tr><th>Total</th>' + statuses.map(status => '<td class="matrix-total">' + cell(totalsByStatus.get(status)) + '</td>').join('') + '<td class="matrix-total">' + cell(total) + '</td></tr>';
  const pager = '<div class="pager"><span>' + n(dates.length) + ' datas</span><div><button data-award-matrix-page="-1" ' + (page === 0 ? 'disabled' : '') + '>Anterior</button><span>Página ' + (page + 1) + ' de ' + pages + '</span><button data-award-matrix-page="1" ' + (page === pages - 1 ? 'disabled' : '') + '>Próxima</button></div></div>';
  window.setTimeout(setupAwardTableFilters, 0);
  return '<div class="matrix-toolbar"><div>' + awardTableDateControl() + '</div><span class="report-actions"><button class="text-button" data-copy-panel-sql="1">Copiar SQL</button><button class="text-button" data-copy-panel-api="1">Copiar chamada API</button><button class="text-button" data-export="' + esc(id) + '">Exportar Excel</button></span></div><div class="matrix-key">Quantidade (Valor total)</div><div class="table-wrap matrix-wrap"><table class="matrix-table"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' + pager;
}

function renderShell() {
  const nav = PAGES.map(item => '<button data-page="' + item[0] + '" class="' + (state.page === item[0] ? 'active' : '') + '">' + item[1] + '</button>').join('');
  const globalFilters = '';
  app.innerHTML = '<header><div class="brand"><span class="brand-mark">◒</span><div><strong>Nota Fiscal Mineira</strong><small>Painel analítico</small></div></div><div class="header-actions"><button class="header-button" data-modal="calls">Chamadas da API <span id="call-count">0</span></button><button class="header-button" data-modal="connection">Conexão</button><button id="refresh" class="header-button">Atualizar dados</button></div></header><div class="hero"><div class="hero-ribbon"></div><div><span class="eyebrow">Governo de Minas Gerais</span><h1>Dados que viram transparência.</h1><p>Monitoramento de participantes, documentos fiscais, sorteios e premiações.</p></div></div><div class="workspace"><aside><div class="nav-title">Relatórios</div>' + nav + '</aside><main>' + globalFilters + '<div id="page"></div></main></div><div class="modal" id="calls-modal" hidden></div><div class="modal" id="connection-modal" hidden></div><div id="drill-menu" hidden></div><div id="toast"></div>';
  setupFilters();
  renderCalls();
}
function setupFilters() {
  const min = Date.parse(START + 'T00:00:00Z') / 86400000;
  const max = Date.parse(today + 'T00:00:00Z') / 86400000;
  const from = document.getElementById('date-range-from'); const to = document.getElementById('date-range-to');
  if (!from || !to) return;
  [from, to].forEach(node => { node.min = min; node.max = max; node.step = 1; });
  from.value = Date.parse(state.from + 'T00:00:00Z') / 86400000; to.value = Date.parse(state.to + 'T00:00:00Z') / 86400000;
  updateDateRangePreview();
}
function updateDateRangePreview() {
  const from = document.getElementById('date-range-from'); const to = document.getElementById('date-range-to'); const range = document.getElementById('date-range');
  if (!from || !to || !range) return;
  const min = Number(from.min); const max = Number(from.max); const start = Math.min(Number(from.value), Number(to.value)); const end = Math.max(Number(from.value), Number(to.value));
  range.style.setProperty('--from', ((start - min) * 100 / (max - min)) + '%');
  range.style.setProperty('--to', ((end - min) * 100 / (max - min)) + '%');
  const startDate = new Date(start * 86400000).toISOString().slice(0, 10); const endDate = new Date(end * 86400000).toISOString().slice(0, 10);
  document.getElementById('from-label').textContent = formatReportDate(startDate);
  document.getElementById('to-label').textContent = formatReportDate(endDate);
  document.getElementById('range-label').textContent = formatReportDate(startDate) + ' a ' + formatReportDate(endDate);
}
function populateRegions(rows) {
  const select = document.getElementById('global-region'); if (!select) return;
  select.innerHTML = '<option value="">Todas as regiões</option>' + rows.map(row => '<option value="' + esc(val(row, 'td_regiao_fiscal.nm_regiao_fiscal')) + '">' + esc(val(row, 'td_regiao_fiscal.nm_regiao_fiscal')) + '</option>').join('');
  select.value = state.region;
}
function renderCurrentPage() {
  disposeCharts(); state.tables.clear(); state.version += 1; state.cache.clear();
  const target = document.getElementById('page');
  const renderers = { ativos: pageActives, premiacoes: pageAwards, bilhetagem: pageTickets, requisicoes: pageRequests, documentos: pageDocuments, vencer: pageExpiring, placar: pageScore, participante: pageParticipant, entidade: pageEntity, municipio: pageMunicipality, regiao: pageRegion };
  if (!renderers[state.page]) state.page = 'ativos';
  renderers[state.page](target);
  updateUrl();
}
function updateUrl() {
  const params = new URLSearchParams();
  params.set('pagina', state.page);
  if (state.params.participant) params.set('participante', state.params.participant);
  if (state.params.entity) params.set('entidade', state.params.entity);
  if (state.params.municipality) params.set('municipio', state.params.municipality);
  if (state.params.regionDetail) params.set('regiao', state.params.regionDetail);
  history.replaceState(null, '', location.pathname + '?' + params.toString());
}
function showToast(message, error) {
  const node = document.getElementById('toast'); if (!node) return;
  node.textContent = message; node.className = error ? 'visible error' : 'visible';
  window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => { node.className = ''; }, 5000);
}

function metrics(items) {
  return '<div class="metric-list">' + items.map(item => '<div class="metric"><span>' + esc(item.label) + '</span><strong>' + esc(item.value) + '</strong>' + (item.note ? '<small>' + esc(item.note) + '</small>' : '') + '</div>').join('') + '</div>';
}
function recordSheet(items) {
  return '<dl class="record-sheet">' + items.map(item => '<div><dt>' + esc(item.label) + '</dt><dd>' + esc(item.value || '—') + '</dd></div>').join('') + '</dl>';
}
function activeSnapshotFilter() { return state.snapshot ? dateFilter('tf_participante_adesao.sk_dt_adesao', state.snapshot, state.snapshot) : dateFilter('tf_participante_adesao.sk_dt_adesao', state.to, state.to); }
function activeObservationRange() {
  const to = state.snapshot || state.to;
  return { from: addDays(to, -29), to };
}
const ACTIVE_GROUPS = {
  municipio: { key: 'municipio', label: 'Município', dimension: 'td_municipio.ds_municipio_ibge', drill: 'municipality' },
  regiao: { key: 'regiao', label: 'Região fiscal', dimension: 'td_regiao_fiscal.nm_regiao_fiscal', drill: 'region' },
  delegacia: { key: 'delegacia', label: 'Delegacia fiscal', dimension: 'td_municipio.ds_df_circunscricao' },
};
const ACTIVE_MUNICIPAL_MEMBERS = {
  municipio: 'td_municipio.ds_municipio_ibge',
  regiao: 'td_regiao_fiscal.nm_regiao_fiscal',
  delegacia: 'td_municipio.ds_df_circunscricao',
};
const ACTIVE_MUNICIPAL_FACT_MEMBERS = {
  dateEmission: 'tf_qt_nfce_dia.dt_emissao',
  population: 'td_municipio.populacao',
  activeEligible: 'tf_participante_adesao.count_current_actives_eligible',
  nfce: 'tf_qt_nfce_dia.qt_nfce',
  nfceCpf: 'tf_qt_nfce_dia.qt_nfce_cpf',
  nfceNfm: 'tf_qt_nfce_dia.qt_nfce_nota_mineira',
};
function activeMunicipalMember(key) { return ACTIVE_MUNICIPAL_MEMBERS[key] || ACTIVE_MUNICIPAL_MEMBERS.municipio; }
function activeMunicipalScopeFilter() {
  if (state.activeDrillMunicipality) return filter(activeMunicipalMember('municipio'), state.activeDrillMunicipality);
  if (state.activeDrillRegion) return filter(activeMunicipalMember('regiao'), state.activeDrillRegion);
  return state.region ? filter(activeMunicipalMember('regiao'), state.region) : [];
}
function activeHierarchyMember(key) {
  const fallback = ACTIVE_GROUPS[key]?.dimension || ACTIVE_GROUPS.municipio.dimension;
  const levels = state.activeHierarchy?.levels;
  if (!Array.isArray(levels)) return fallback;
  return levels.find(level => level === fallback) || fallback;
}
function activeGroupConfig(key = state.activeGroup) {
  const base = ACTIVE_GROUPS[key] || ACTIVE_GROUPS.municipio;
  return { ...base, dimension: activeHierarchyMember(base.key) };
}
function activeGroupControl() {
  const group = activeGroupConfig();
  return '<div class="active-group-tabs" role="tablist" aria-label="Agrupar tabela por">' + ['municipio', 'regiao', 'delegacia'].map(key => { const item = activeGroupConfig(key); const selected = group.key === item.key; return '<button type="button" role="tab" data-active-group="' + key + '" aria-selected="' + selected + '" class="' + (selected ? 'selected' : '') + '">' + (key === 'delegacia' ? 'DF' : esc(item.label)) + '</button>'; }).join('') + '</div>';
}

function activeTableDateControl() {
  return '<div class="panel-date-filter"><div class="date-range-labels"><span>De <strong id="active-from-label"></strong></span><span>Até <strong id="active-to-label"></strong></span></div><div class="date-range" id="active-date-range"><div class="date-range-fill"></div><input id="active-date-range-from" type="range" aria-label="Data inicial da tabela"><input id="active-date-range-to" type="range" aria-label="Data final da tabela"></div><small>Período dos documentos da tabela</small></div>';
}

function activeTableControls() { return activeGroupControl() + activeTableDateControl(); }
function activeChurnControls() {
  return '<div class="chart-toggles"><label><input id="active-churn-start" type="checkbox"' + (state.activeChurn.showStart ? ' checked' : '') + '> Início de adesão</label><label><input id="active-churn-end" type="checkbox"' + (state.activeChurn.showEnd ? ' checked' : '') + '> Fim de adesão</label></div>';
}

function setupActiveTableFilters() {
  const min = Date.parse(START + 'T00:00:00Z') / 86400000;
  const max = Date.parse(today + 'T00:00:00Z') / 86400000;
  const from = document.getElementById('active-date-range-from'); const to = document.getElementById('active-date-range-to');
  if (!from || !to) return;
  [from, to].forEach(node => { node.min = min; node.max = max; node.step = 1; });
  from.value = Date.parse(state.activeTableFrom + 'T00:00:00Z') / 86400000; to.value = Date.parse(state.activeTableTo + 'T00:00:00Z') / 86400000;
  updateActiveTableDatePreview();
}

function updateActiveTableDatePreview() {
  const from = document.getElementById('active-date-range-from'); const to = document.getElementById('active-date-range-to'); const range = document.getElementById('active-date-range');
  if (!from || !to || !range) return;
  const min = Number(from.min); const max = Number(from.max); const start = Math.min(Number(from.value), Number(to.value)); const end = Math.max(Number(from.value), Number(to.value));
  range.style.setProperty('--from', ((start - min) * 100 / (max - min)) + '%');
  range.style.setProperty('--to', ((end - min) * 100 / (max - min)) + '%');
  document.getElementById('active-from-label').textContent = formatReportDate(new Date(start * 86400000).toISOString().slice(0, 10));
  document.getElementById('active-to-label').textContent = formatReportDate(new Date(end * 86400000).toISOString().slice(0, 10));
}

function activeTableDateDimension() {
  return [{
    dimension: ACTIVE_MUNICIPAL_FACT_MEMBERS.dateEmission,
    dateRange: [state.activeTableFrom, state.activeTableTo],
  }];
}

function activeMunicipalTable(activeGroup, sourceRows) {
  const regionKey = activeMunicipalMember('regiao');
  const { activeEligible: activeMeasure, population: populationMeasure, nfce: nfceMeasure, nfceCpf: nfceCpfMeasure, nfceNfm: nfceNfmMeasure } = ACTIVE_MUNICIPAL_FACT_MEMBERS;
  const grouped = new Map();
  sourceRows.forEach(row => {
    const groupValue = val(row, activeMunicipalMember(activeGroup.key)) || 'Sem classificação';
    const current = grouped.get(groupValue) || {
      [activeMunicipalMember(activeGroup.key)]: groupValue,
      [regionKey]: val(row, regionKey),
      [activeMunicipalMember('delegacia')]: val(row, activeMunicipalMember('delegacia')),
      População: 0,
      'Ativos e não impedidos': 0,
      NFCe: 0,
      'NFCe com CPF': 0,
      'NFCe NFM': 0,
    };
    current.População += num(val(row, populationMeasure));
    current['Ativos e não impedidos'] += num(val(row, activeMeasure));
    current.NFCe += num(val(row, nfceMeasure));
    current['NFCe com CPF'] += num(val(row, nfceCpfMeasure));
    current['NFCe NFM'] += num(val(row, nfceNfmMeasure));
    grouped.set(groupValue, current);
  });
  const groupKey = activeGroup.label;
  const tableRows = [...grouped.values()].map(row => {
    const result = { [groupKey]: val(row, activeMunicipalMember(activeGroup.key)), População: row.População, 'Ativos e não impedidos': row['Ativos e não impedidos'], NFCe: row.NFCe, 'NFCe com CPF': row['NFCe com CPF'], 'NFCe NFM': row['NFCe NFM'], '% com CPF': row['NFCe com CPF'] / Math.max(1, row.NFCe), '% NFM': row['NFCe NFM'] / Math.max(1, row.NFCe) };
    if (activeGroup.key === 'municipio') {
      result['Região fiscal'] = row[regionKey];
      result['DF circunscrição'] = row[activeMunicipalMember('delegacia')];
    }
    return result;
  });
  const columns = [{ key: groupKey, label: activeGroup.label, menuDrill: activeGroup.drill }];
  if (activeGroup.key === 'municipio') columns.push({ key: 'Região fiscal', label: 'Região fiscal', menuDrill: 'region' }, { key: 'DF circunscrição', label: 'DF circunscrição' });
  columns.push({ key: 'População', label: 'População', format: 'compact', measure: true }, { key: 'Ativos e não impedidos', label: 'Ativos e não impedidos', format: 'compact', measure: true }, { key: 'NFCe', label: 'NFCe', format: 'compact', measure: true }, { key: 'NFCe com CPF', label: 'NFCe com CPF', format: 'compact', measure: true }, { key: 'NFCe NFM', label: 'NFCe NFM', format: 'compact', measure: true }, { key: '% com CPF', label: '% com CPF', format: 'percent', measure: true }, { key: '% NFM', label: '% NFM', format: 'percent', measure: true });
  return tableHtml('municipal-active-table', activeGroup.label, tableRows, columns, { sort: 'NFCe NFM' });
}

function activeMunicipalData() {
  const key = JSON.stringify([state.region, state.activeDrillRegion, state.activeDrillMunicipality, state.activeTableFrom, state.activeTableTo, state.activeHierarchy?.levels]);
  const municipality = activeMunicipalMember('municipio');
  const region = activeMunicipalMember('regiao');
  const delegacia = activeMunicipalMember('delegacia');
  const limit = 5000;
  if (!state.activeMunicipalCache.has(key)) {
    const dimensions = [municipality, region, delegacia];
    const scope = activeMunicipalScopeFilter();
    const tableQuery = query('participantes ativos, população e documentos por município', {
      dimensions,
      measures: [
        ACTIVE_MUNICIPAL_FACT_MEMBERS.population,
        ACTIVE_MUNICIPAL_FACT_MEMBERS.activeEligible,
        ACTIVE_MUNICIPAL_FACT_MEMBERS.nfce,
        ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceCpf,
        ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceNfm,
      ],
      // The date range belongs only to the documents fact. The native
      // multi-fact planner keeps the population/current-participant facts
      // independent and applies the range to TF_QT_NFCE_DIA.
      timeDimensions: activeTableDateDimension(),
      filters: scope,
      limit,
    });
    state.activeMunicipalCache.set(key, tableQuery);
  }
  return state.activeMunicipalCache.get(key);
}

function loadActiveMunicipalBlock() {
  const activeGroup = activeGroupConfig();
  loadBlock('active-municipal', () => [activeMunicipalData()], rows => activeMunicipalTable(activeGroup, rows));
}
function switchActiveGroup(value) {
  if (!ACTIVE_GROUPS[value]) return;
  state.activeGroup = value;
  document.querySelectorAll('[data-active-group]').forEach(button => {
    const selected = button.dataset.activeGroup === value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  const panel = document.getElementById('active-municipal');
  const group = activeGroupConfig();
  if (panel) {
    const title = panel.querySelector('h2');
    const body = panel.querySelector('.panel-body');
    if (title) title.textContent = 'Participantes e documentos por ' + group.label.toLocaleLowerCase('pt-BR');
    if (body) body.innerHTML = '<div class="skeleton"></div>';
  }
  loadActiveMunicipalBlock();
}

function closeDrillMenu() {
  const modal = document.getElementById('drill-menu');
  if (!modal) return;
  modal.hidden = true;
  modal.innerHTML = '';
}

function clickPoint(event) {
  const nativeEvent = event && event.event ? event.event : event;
  return {
    x: Number(nativeEvent && nativeEvent.clientX) || 0,
    y: Number(nativeEvent && nativeEvent.clientY) || 0,
  };
}

function openDrillMenu(kind, value, source, event, mode) {
  const modal = document.getElementById('drill-menu');
  if (!modal || !value || value === 'Outros municípios') return;
  const labels = { region: 'região fiscal', municipality: 'município', participant: 'participante', entity: 'entidade' };
  const label = labels[kind] || kind;
  const origin = source === 'chart' ? 'gráfico' : 'tabela';
  const throughOnly = mode === 'through' || kind === 'participant' || kind === 'entity';
  const down = throughOnly ? '' : '<button data-drill-action="down" data-drill-kind="' + esc(kind) + '" data-drill-value="' + esc(value) + '" role="menuitem"><strong>Drill-down</strong><small>Continuar explorando por ' + label + '</small></button>';
  const through = '<button data-drill-action="through" data-drill-kind="' + esc(kind) + '" data-drill-value="' + esc(value) + '" role="menuitem"><strong>Drill-through</strong><small>Abrir a página de detalhes</small></button>';
  modal.className = 'drill-context-menu';
  modal.innerHTML = '<div class="drill-context-panel" role="menu" aria-label="Ações de detalhamento"><div class="drill-context-title">' + esc(value) + '<small>' + origin + ' · escolha uma ação</small></div>' + down + through + '</div>';
  modal.hidden = false;
  const point = clickPoint(event);
  const panel = modal.firstElementChild;
  const margin = 8;
  const panelRect = panel.getBoundingClientRect();
  modal.style.left = Math.max(margin, Math.min(point.x + 10, window.innerWidth - panelRect.width - margin)) + 'px';
  modal.style.top = Math.max(margin, Math.min(point.y + 10, window.innerHeight - panelRect.height - margin)) + 'px';
}

function applyDrillAction(action, kind, value) {
  closeDrillMenu();
  if (action === 'down') {
    if (kind === 'region') {
      state.activeDrillRegion = value;
      state.activeDrillMunicipality = '';
    } else {
      state.activeDrillMunicipality = value;
    }
    state.activeGroup = 'municipio';
    renderCurrentPage();
    return;
  }
  state.activeDrillRegion = '';
  state.activeDrillMunicipality = '';
  state.page = kind === 'region' ? 'regiao' : 'municipio';
  state.params[kind === 'region' ? 'regionDetail' : 'municipality'] = value;
  renderShell();
  renderCurrentPage();
}

function activeChurnSeries(rows) {
  const series = [];
  if (state.activeChurn.showStart) series.push({ name: 'Adesões', type: 'bar', barGap: '-100%', barCategoryGap: '0%', data: rows.map(row => row.Adesões), itemStyle: { color: '#3478b7' } });
  if (state.activeChurn.showEnd) series.push({ name: 'Encerramentos', type: 'bar', barGap: '-100%', barCategoryGap: '0%', data: rows.map(row => -row.Encerramentos), itemStyle: { color: '#e84343' } });
  return series;
}
function updateActiveChurnChart() {
  const instance = state.charts.get('active-churn-chart');
  if (!instance || !Array.isArray(window.__activeChurn)) return;
  instance.setOption({ series: activeChurnSeries(window.__activeChurn) }, { replaceMerge: ['series'] });
}

function activeTrendControls() {
  return state.activeDrillMunicipality
    ? '<span class="chart-drill-hint">Município selecionado: ' + esc(state.activeDrillMunicipality) + '</span>'
    : state.activeDrillRegion
      ? '<span class="chart-drill-hint">Top 15 municípios + Outros</span>'
      : '<span class="chart-drill-hint">Clique em uma regional para detalhar</span>';
}
function activeDrillBanner() {
  if (!state.activeDrillRegion && !state.activeDrillMunicipality) return '';
  const scope = state.activeDrillMunicipality
    ? 'Região fiscal: ' + esc(state.activeDrillRegion) + ' › Município: ' + esc(state.activeDrillMunicipality)
    : 'Região fiscal: ' + esc(state.activeDrillRegion);
  const back = state.activeDrillMunicipality ? '<button id="active-drill-back" class="secondary">Voltar para municípios</button>' : '';
  return '<div class="active-drill-banner" role="status"><div class="active-drill-message"><span class="active-drill-kicker">⚠ VISÃO FILTRADA POR DRILL-DOWN</span><strong>' + scope + '</strong><small>Os indicadores abaixo mostram somente este recorte — não representam a visão completa do estado.</small></div><div class="active-drill-actions">' + back + '<button id="active-drill-clear" class="secondary">Remover drill</button></div></div>';
}

function activeTrendChart(rows, ranking) {
  const regionMember = activeHierarchyMember('regiao');
  const municipalityMember = activeHierarchyMember('municipio');
  const dates = [...new Set(rows.map(row => day(val(row, 'tf_participante_adesao.sk_dt_adesao.day'))).filter(Boolean))].sort();
  const valuesByNameAndDate = new Map();
  let names;
  if (!state.activeDrillRegion) {
    rows.forEach(row => {
      const date = day(val(row, 'tf_participante_adesao.sk_dt_adesao.day'));
      const name = val(row, regionMember) || 'Sem região fiscal';
      valuesByNameAndDate.set(name + '\u0000' + date, num(val(row, 'tf_participante_adesao.count_actives')));
    });
    names = [...new Set(rows.map(row => val(row, regionMember) || 'Sem região fiscal'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  } else if (!state.activeDrillMunicipality) {
    const topNames = [...ranking].sort((a, b) => num(val(b, 'tf_participante_adesao.count_current_actives_eligible')) - num(val(a, 'tf_participante_adesao.count_current_actives_eligible'))).slice(0, 15).map(row => val(row, municipalityMember)).filter(Boolean);
    const topSet = new Set(topNames);
    let hasOthers = false;
    rows.forEach(row => {
      const date = day(val(row, 'tf_participante_adesao.sk_dt_adesao.day'));
      const municipality = val(row, municipalityMember);
      if (!date || !municipality) return;
      const name = topSet.has(municipality) ? municipality : 'Outros municípios';
      if (name === 'Outros municípios') hasOthers = true;
      const key = name + '\u0000' + date;
      valuesByNameAndDate.set(key, (valuesByNameAndDate.get(key) || 0) + num(val(row, 'tf_participante_adesao.count_actives')));
    });
    names = topNames.slice();
    if (hasOthers) names.push('Outros municípios');
  } else {
    const name = state.activeDrillMunicipality;
    rows.forEach(row => {
      const date = day(val(row, 'tf_participante_adesao.sk_dt_adesao.day'));
      if (date) valuesByNameAndDate.set(name + '\u0000' + date, num(val(row, 'tf_participante_adesao.count_actives')));
    });
    names = [name];
  }
  const series = names.map((name, index) => ({ name, type: 'line', stack: 'participantes-ativos', triggerEvent: true, showSymbol: false, showAllSymbol: false, symbol: 'none', symbolSize: 0, hoverAnimation: false, connectNulls: true, areaStyle: { opacity: 1 }, lineStyle: { width: 0 }, itemStyle: { color: COLORS[index % COLORS.length] }, emphasis: { focus: 'series', scale: false, lineStyle: { width: 0 } }, data: dates.map(date => valuesByNameAndDate.get(name + '\u0000' + date) || 0) }));
  const click = params => {
    const nativeEvent = params.event && (params.event.event || params.event);
    if (nativeEvent && typeof nativeEvent.stopPropagation === 'function') nativeEvent.stopPropagation();
    if (params.componentType !== 'series' || !params.seriesName) return;
    const kind = state.activeDrillRegion ? 'municipality' : 'region';
    openDrillMenu(kind, params.seriesName, 'chart', params.event);
  };
  const description = state.activeDrillMunicipality ? 'Evolução do município selecionado. Clique na área para escolher outra ação.' : state.activeDrillRegion ? 'Top 15 municípios por participantes ativos atualmente; os demais estão em “Outros municípios”. Clique em uma área para escolher uma ação.' : 'Clique em uma área para escolher entre drill-down e drill-through.';
  return { rows, option: { legend: { type: 'plain', icon: 'rect', top: 4, left: 8, right: 8, itemGap: 8, itemWidth: 14, itemHeight: 10, textStyle: { fontSize: 11 } }, grid: { left: 65, right: 30, top: 74, bottom: 85 }, xAxis: { type: 'category', data: dates }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 18 }, { type: 'inside' }], series, onClick: click }, description };
}

function loadActiveTrendBlock() {
  const regionMember = activeHierarchyMember('regiao');
  const municipalityMember = activeHierarchyMember('municipio');
  const trendQueries = state.activeDrillRegion ? [
    query('evolução de participantes ativos por município', { dimensions: [municipalityMember], measures: ['tf_participante_adesao.count_actives'], timeDimensions: dateFilter('tf_participante_adesao.sk_dt_adesao', START, today), filters: activeRegionFilter(), order: { 'tf_participante_adesao.sk_dt_adesao.day': 'asc' }, limit: 50000 }),
    query('ranking atual de participantes por município', { dimensions: [municipalityMember], measures: ['tf_participante_adesao.count_current_actives_eligible'], filters: activeRegionFilter(), order: { 'tf_participante_adesao.count_current_actives_eligible': 'desc' }, limit: 1000 }),
  ] : [
    query('evolução de participantes ativos', { dimensions: [regionMember], measures: ['tf_participante_adesao.count_actives'], timeDimensions: dateFilter('tf_participante_adesao.sk_dt_adesao', START, today), filters: activeRegionFilter(), order: { 'tf_participante_adesao.sk_dt_adesao.day': 'asc' }, limit: 5000 }),
  ];
  loadBlock('active-trend', () => trendQueries, (rows, ranking = []) => {
    const rendered = activeTrendChart(rows, ranking);
    return chart('active-trend-chart', rendered.rows, rendered.option, rendered.description);
  });
}

function pageActives(target) {
  const activeGroup = activeGroupConfig();
  const observation = activeObservationRange();
  const observationLabel = formatReportDate(observation.from) + ' a ' + formatReportDate(observation.to);
  const trendTitle = state.activeDrillMunicipality ? 'Participantes ativos em ' + state.activeDrillMunicipality : state.activeDrillRegion ? 'Participantes ativos por município' : 'Participantes ativos por regional';
  const trendSubtitle = state.activeDrillMunicipality ? 'Detalhamento de ' + state.activeDrillMunicipality + '.' : state.activeDrillRegion ? 'Detalhamento de ' + state.activeDrillRegion + '; clique em uma área para escolher uma ação.' : 'Uma área por regional; clique em uma área para escolher entre drill-down e drill-through.';
  target.innerHTML = pageHeading('Participantes ativos', 'Visão atual de adesões e evolução por regional, município ou delegacia fiscal.') + activeDrillBanner() + standaloneMetricBlock('active-kpis', 'Situação atual', 'O retrato mais recente de adesões é usado nestes indicadores.') + card('active-trend', trendTitle, trendSubtitle, activeTrendControls()) + card('active-municipal', 'Participantes e documentos por ' + activeGroup.label.toLocaleLowerCase('pt-BR'), 'Escolha o nível territorial do agrupamento.', activeTableControls()) + '<div class="grid active-churn-layout">' + card('active-churn', 'Adesões e encerramentos por dia', 'Adesões em azul e encerramentos em vermelho.', activeChurnControls()) + card('active-churn-table', 'Detalhamento diário de adesões', 'Saldo líquido por data.') + '</div>';
  setupActiveTableFilters();
  loadStandaloneMetrics('active-kpis', () => [
    query('participantes ativos e não impedidos atualmente', { measures: ['tf_participante_adesao.count_current_actives_eligible'], filters: activeRegionFilter() }),
    query('última data de atualização do cubo', { measures: ['tf_participante_adesao.last_update_date'] }),
    query('impedidos atualmente', { measures: ['tf_participante_adesao.count_current_blocked'], filters: activeRegionFilter() }),
    query('adesões de ' + observationLabel + ' na última atualização', { measures: ['tf_participante_adesao.count'], filters: [...dateRangeFilter('tf_participante_adesao.dt_inicio_adesao', observation.from, observation.to), ...latestUpdateFilter(), ...activeRegionFilter()] }),
    query('encerramentos de ' + observationLabel + ' na última atualização', { measures: ['tf_participante_adesao.count'], filters: [...dateRangeFilter('tf_participante_adesao.dt_fim_adesao', observation.from, observation.to), ...latestUpdateFilter(), ...activeRegionFilter()] }),
  ], (active, latest, blocked, joined, ended) => {
    const latestDate = val(latest[0], 'tf_participante_adesao.last_update_date');
    const joinedCount = num(val(joined[0], 'tf_participante_adesao.count'));
    const endedCount = num(val(ended[0], 'tf_participante_adesao.count'));
    const balance = joinedCount - endedCount;
    return metricCards([
      { label: 'Participantes ativos e não impedidos atualmente', value: n(val(active[0], 'tf_participante_adesao.count_current_actives_eligible')), note: latestDate ? 'Atualizado em ' + formatReportDate(latestDate) : 'Data de atualização indisponível' },
      { label: 'Participantes impedidos atualmente', value: n(val(blocked[0], 'tf_participante_adesao.count_current_blocked')), note: latestDate ? 'Retrato de ' + formatReportDate(latestDate) : 'No último retrato disponível' },
      { label: 'Saldo de adesões nos últimos 30 dias', value: (balance >= 0 ? '+' : '') + n(balance), note: 'Adesões menos encerramentos · ' + observationLabel },
    ]);
  });
  loadActiveTrendBlock();
  loadActiveMunicipalBlock();
  loadBlock('active-churn', () => [
    query('adesões por dia na última atualização', { measures: ['tf_participante_adesao.count'], timeDimensions: dateFilter('tf_participante_adesao.dt_inicio_adesao', START, today), filters: [...latestUpdateFilter(), ...activeRegionFilter()], order: { 'tf_participante_adesao.dt_inicio_adesao.day': 'asc' }, limit: 3000 }),
    query('encerramentos por dia na última atualização', { measures: ['tf_participante_adesao.count'], timeDimensions: dateFilter('tf_participante_adesao.dt_fim_adesao', START, today), filters: [...latestUpdateFilter(), ...activeRegionFilter()], order: { 'tf_participante_adesao.dt_fim_adesao.day': 'asc' }, limit: 3000 }),
  ], (joins, ends) => {
    const dates = [...new Set(joins.map(row => day(val(row, 'tf_participante_adesao.dt_inicio_adesao.day'))).concat(ends.map(row => day(val(row, 'tf_participante_adesao.dt_fim_adesao.day')))))].sort();
    const rows = dates.map(date => ({ Data: date, Adesões: num(val(joins.find(row => day(val(row, 'tf_participante_adesao.dt_inicio_adesao.day')) === date), 'tf_participante_adesao.count')), Encerramentos: num(val(ends.find(row => day(val(row, 'tf_participante_adesao.dt_fim_adesao.day')) === date), 'tf_participante_adesao.count')) }));
    window.__activeChurn = rows;
    return chart('active-churn-chart', rows, { grid: { left: 60, right: 25, bottom: 75 }, xAxis: { type: 'category', data: dates }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 12 }, { type: 'inside', zoomOnMouseWheel: true, moveOnMouseWheel: true, moveOnMouseMove: true, preventDefaultMouseMove: true }], series: activeChurnSeries(rows) }, 'O tooltip apresenta entradas, encerramentos e saldo por data. Use o scroll do mouse para ampliar ou reduzir o período.');
  });
  loadBlock('active-churn-table', () => [
    query('adesões por dia na última atualização para tabela', { measures: ['tf_participante_adesao.count'], timeDimensions: dateFilter('tf_participante_adesao.dt_inicio_adesao', START, today), filters: [...latestUpdateFilter(), ...activeRegionFilter()], order: { 'tf_participante_adesao.dt_inicio_adesao.day': 'asc' }, limit: 3000 }),
    query('encerramentos por dia na última atualização para tabela', { measures: ['tf_participante_adesao.count'], timeDimensions: dateFilter('tf_participante_adesao.dt_fim_adesao', START, today), filters: [...latestUpdateFilter(), ...activeRegionFilter()], order: { 'tf_participante_adesao.dt_fim_adesao.day': 'asc' }, limit: 3000 }),
  ], (joins, ends) => {
    const dates = [...new Set(joins.map(row => day(val(row, 'tf_participante_adesao.dt_inicio_adesao.day'))).concat(ends.map(row => day(val(row, 'tf_participante_adesao.dt_fim_adesao.day')))))].sort();
    const data = dates.map(date => ({ Data: date, Adesões: num(val(joins.find(row => day(val(row, 'tf_participante_adesao.dt_inicio_adesao.day')) === date), 'tf_participante_adesao.count')), Encerramentos: num(val(ends.find(row => day(val(row, 'tf_participante_adesao.dt_fim_adesao.day')) === date), 'tf_participante_adesao.count')) })).map(row => ({ ...row, 'Saldo líquido': row.Adesões - row.Encerramentos }));
    return tableHtml('active-churn-data', 'Dados do gráfico', data, [{ key: 'Data', label: 'Data', format: 'date' }, { key: 'Adesões', label: 'Início de adesão', format: 'number', measure: true }, { key: 'Encerramentos', label: 'Fim de adesão', format: 'number', measure: true }, { key: 'Saldo líquido', label: 'Saldo líquido', format: 'number', measure: true }], { sort: 'Data', direction: 'desc' });
  });
}

function awardsCube() { return state.awardType === 'entidades' ? 'tf_premiacoes_entidades' : 'tf_premiacoes_participantes'; }
function awardMeasure() { return state.awardType === 'entidades' ? 'tf_premiacoes_entidades.vlr_premio_entidade' : 'tf_premiacoes_participantes.vlr_premio_participante'; }
function loadAwardCharts() {
  const cube = awardsCube(); const amount = awardMeasure(); const measure = state.awardMetric === 'valor' ? amount : cube + '.count';
  loadBlock('award-chart', () => [query('premiações por status e data', { dimensions: ['td_premio_status.ds_premio_status'], measures: [measure], timeDimensions: dateFilter(cube + '.dt_sorteio', state.awardOverviewFrom, state.awardOverviewTo), filters: regionFilter(), order: { [cube + '.dt_sorteio.day']: 'asc' }, limit: 5000 })], rows => {
    const dates = [...new Set(rows.map(row => day(val(row, cube + '.dt_sorteio.day'))))]; const statuses = [...new Set(rows.map(row => val(row, 'td_premio_status.ds_premio_status')))];
    return chart('award-status-chart', rows, { legend: { top: 5 }, grid: { top: 52, left: 70, right: 25, bottom: 72 }, xAxis: { type: 'category', data: dates }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 12 }], series: statuses.map(name => ({ name, type: 'bar', stack: 'premios', data: dates.map(date => num(val(rows.find(row => day(val(row, cube + '.dt_sorteio.day')) === date && val(row, 'td_premio_status.ds_premio_status') === name), measure))) })) }, 'Cada cor representa um status de premiação.');
  });
  loadBlock('award-donut', () => [query('total de premiações por status', { dimensions: ['td_premio_status.ds_premio_status'], measures: [measure], filters: [...dateRangeFilter(cube + '.dt_sorteio', state.awardOverviewFrom, state.awardOverviewTo), ...regionFilter()], limit: 100 })], rows => {
    const statusTotals = new Map();
    rows.forEach(row => {
      const status = val(row, 'td_premio_status.ds_premio_status');
      statusTotals.set(status, (statusTotals.get(status) || 0) + num(val(row, measure)));
    });
    const data = [...statusTotals].map(([name, value]) => ({ name, value }));
    const total = data.reduce((sum, item) => sum + item.value, 0);
    const totalLabel = state.awardMetric === 'valor' ? compactMoney(total) : compact(total);
    const totalCaption = state.awardMetric === 'valor' ? 'Valor total' : 'Total de premiações';
    const tooltipFormatter = params => {
      const item = Array.isArray(params) ? params[0] : params;
      const value = num(item.value);
      if (item.data?.isTotal) return '<strong>' + esc(totalCaption) + ': ' + esc(state.awardMetric === 'valor' ? money(value) : n(value)) + '</strong>';
      const formatted = state.awardMetric === 'valor' ? money(value) : n(value);
      const percentage = total ? new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / total * 100) : '0,00';
      return (item.marker || '') + esc(item.name || '') + ': <strong>' + esc(formatted) + '</strong> (' + percentage + '%)';
    };
    const totalData = { name: totalCaption, value: total, isTotal: true };
    return chart('award-donut-chart', rows, { tooltip: { trigger: 'item', formatter: tooltipFormatter }, legend: { bottom: 0, data: data.map(item => item.name) }, series: [{ type: 'pie', radius: ['42%', '72%'], z: 1, label: { show: true, position: 'center', formatter: '{value|' + totalLabel + '}\n{caption|' + totalCaption + '}', rich: { value: { color: '#45284e', fontSize: 20, fontWeight: 800, lineHeight: 28 }, caption: { color: '#86758c', fontSize: 11, fontWeight: 700, lineHeight: 16 } } }, data }, { type: 'pie', radius: ['0%', '41%'], z: 0, label: { show: false }, itemStyle: { color: 'transparent' }, data: [totalData] }] }, 'Usa a mesma paleta do gráfico de barras.');
  });
}
function awardTableDateControl() {
  return '<div class="panel-date-filter award-table-date-filter"><div class="date-range-labels"><span>De <strong id="award-table-from-label"></strong></span><span>Até <strong id="award-table-to-label"></strong></span></div><div class="date-range" id="award-table-date-range"><div class="date-range-fill"></div><input id="award-table-date-range-from" type="range" aria-label="Data inicial da matriz"><input id="award-table-date-range-to" type="range" aria-label="Data final da matriz"></div><small>Período dos sorteios desta matriz</small></div>';
}
function setupAwardTableFilters() {
  const min = Date.parse(START + 'T00:00:00Z') / 86400000;
  const max = Date.parse(today + 'T00:00:00Z') / 86400000;
  const from = document.getElementById('award-table-date-range-from'); const to = document.getElementById('award-table-date-range-to');
  if (!from || !to) return;
  [from, to].forEach(node => { node.min = min; node.max = max; node.step = 1; });
  from.value = Date.parse(state.awardTableFrom + 'T00:00:00Z') / 86400000;
  to.value = Date.parse(state.awardTableTo + 'T00:00:00Z') / 86400000;
  updateAwardTableDatePreview();
}
function updateAwardTableDatePreview() {
  const from = document.getElementById('award-table-date-range-from'); const to = document.getElementById('award-table-date-range-to'); const range = document.getElementById('award-table-date-range');
  if (!from || !to || !range) return;
  const min = Number(from.min); const max = Number(from.max); const start = Math.min(Number(from.value), Number(to.value)); const end = Math.max(Number(from.value), Number(to.value));
  range.style.setProperty('--from', ((start - min) * 100 / (max - min)) + '%');
  range.style.setProperty('--to', ((end - min) * 100 / (max - min)) + '%');
  document.getElementById('award-table-from-label').textContent = formatReportDate(new Date(start * 86400000).toISOString().slice(0, 10));
  document.getElementById('award-table-to-label').textContent = formatReportDate(new Date(end * 86400000).toISOString().slice(0, 10));
}
const AWARD_DATE_FILTERS = {
  overview: { from: 'awardOverviewFrom', to: 'awardOverviewTo', label: 'Período dos gráficos' },
  winners: { from: 'awardWinnersFrom', to: 'awardWinnersTo', label: 'Período dos participantes premiados' },
};
function awardDateControl(key) {
  const prefix = 'award-' + key;
  const config = AWARD_DATE_FILTERS[key];
  return '<div class="panel-date-filter award-date-filter"><div class="date-range-labels"><span>De <strong id="' + prefix + '-from-label"></strong></span><span>Até <strong id="' + prefix + '-to-label"></strong></span></div><div class="date-range" id="' + prefix + '-date-range"><div class="date-range-fill"></div><input id="' + prefix + '-date-range-from" type="range" aria-label="Data inicial · ' + esc(config.label) + '"><input id="' + prefix + '-date-range-to" type="range" aria-label="Data final · ' + esc(config.label) + '"></div><small>' + esc(config.label) + '</small></div>';
}
function setupAwardDateFilter(key) {
  const config = AWARD_DATE_FILTERS[key]; const prefix = 'award-' + key;
  const min = Date.parse(START + 'T00:00:00Z') / 86400000; const max = Date.parse(today + 'T00:00:00Z') / 86400000;
  const from = document.getElementById(prefix + '-date-range-from'); const to = document.getElementById(prefix + '-date-range-to');
  if (!from || !to) return;
  [from, to].forEach(node => { node.min = min; node.max = max; node.step = 1; });
  from.value = Date.parse(state[config.from] + 'T00:00:00Z') / 86400000;
  to.value = Date.parse(state[config.to] + 'T00:00:00Z') / 86400000;
  updateAwardDatePreview(key);
}
function updateAwardDatePreview(key) {
  const prefix = 'award-' + key;
  const from = document.getElementById(prefix + '-date-range-from'); const to = document.getElementById(prefix + '-date-range-to'); const range = document.getElementById(prefix + '-date-range');
  if (!from || !to || !range) return;
  const min = Number(from.min); const max = Number(from.max); const start = Math.min(Number(from.value), Number(to.value)); const end = Math.max(Number(from.value), Number(to.value));
  range.style.setProperty('--from', ((start - min) * 100 / (max - min)) + '%');
  range.style.setProperty('--to', ((end - min) * 100 / (max - min)) + '%');
  document.getElementById(prefix + '-from-label').textContent = formatReportDate(new Date(start * 86400000).toISOString().slice(0, 10));
  document.getElementById(prefix + '-to-label').textContent = formatReportDate(new Date(end * 86400000).toISOString().slice(0, 10));
}
function commitAwardDateFilter(key) {
  const config = AWARD_DATE_FILTERS[key]; const prefix = 'award-' + key;
  const from = Number(document.getElementById(prefix + '-date-range-from').value); const to = Number(document.getElementById(prefix + '-date-range-to').value);
  state[config.from] = new Date(Math.min(from, to) * 86400000).toISOString().slice(0, 10);
  state[config.to] = new Date(Math.max(from, to) * 86400000).toISOString().slice(0, 10);
  setupAwardDateFilter(key);
  if (key === 'overview') loadAwardCharts();
  if (key === 'winners') { clearAwardWinnersCache(); state.awardWinnersPage = 0; loadAwardWinnersPaged(); }
}
function awardChartSlot(id, title, subtitle) {
  return '<section class="award-chart-slot" id="' + esc(id) + '"><div class="award-chart-slot-head"><h3>' + esc(title) + '</h3><p>' + esc(subtitle) + '</p></div><div class="panel-body"><div class="skeleton"></div></div></section>';
}
function awardOverviewCard() {
  return '<section class="panel award-overview-panel" id="award-overview"><div class="panel-head"><div><h2>Premiações por status</h2><p>Compare a evolução diária e a composição do período selecionado.</p></div></div><div class="panel-body"><div class="award-overview-controls"><div class="metric-toggle"><span>Métrica</span><button data-award-metric="quantidade" class="' + (state.awardMetric === 'quantidade' ? 'selected' : '') + '">Quantidade</button><button data-award-metric="valor" class="' + (state.awardMetric === 'valor' ? 'selected' : '') + '">Valor total</button></div>' + awardDateControl('overview') + '</div><div class="grid two award-overview-grid">' + awardChartSlot('award-chart', 'Premiações por status e data', 'Barras empilhadas por data de sorteio.') + awardChartSlot('award-donut', 'Composição por status', 'Total para o intervalo selecionado.') + '</div></div></section>';
}
function renderAwardMatrix() {
  const panel = document.getElementById('award-matrix');
  const body = panel?.querySelector('.panel-body');
  if (!body) return;
  body.innerHTML = '<h3 class="subheading">Quantidade e valor por data e status</h3>' + awardMatrixHtml('award-matrix-table', state.awardMatrixRows, state.awardMatrixCube, state.awardMatrixAmount);
  bindPanelSql('award-matrix', [state.awardMatrixRows]);
}
function loadAwardMatrix() {
  const cube = awardsCube(); const amount = awardMeasure();
  const requestId = ++state.awardMatrixRequest;
  loadBlock('award-matrix', () => [query('matriz de premiações', { dimensions: ['td_premio_status.ds_premio_status'], measures: [cube + '.count', amount], timeDimensions: dateFilter(cube + '.dt_sorteio', state.awardTableFrom, state.awardTableTo), filters: regionFilter(), order: { [cube + '.dt_sorteio.day']: 'desc' }, limit: 5000 })], rows => {
    if (requestId !== state.awardMatrixRequest) return null;
    state.awardMatrixRows = rows;
    state.awardMatrixCube = cube;
    state.awardMatrixAmount = amount;
    state.awardMatrixPage = 0;
    return '<h3 class="subheading">Quantidade e valor por data e status</h3>' + awardMatrixHtml('award-matrix-table', rows, cube, amount);
  });
}
function awardWinnersFilters(idMember, nameMember) {
  const filters = [...regionFilter()];
  const term = state.awardWinnersSearch.trim();
  if (term) filters.push({ or: [{ member: idMember, operator: 'contains', values: [term] }, { member: nameMember, operator: 'contains', values: [term] }] });
  return filters;
}
function clearAwardWinnersCache() {
  state.awardWinnersPageCache.clear();
  state.awardWinnersTotalsCache.clear();
}
function awardWinnersContextKey(type) {
  return JSON.stringify({ type, from: state.awardWinnersFrom, to: state.awardWinnersTo, search: state.awardWinnersSearch.trim(), sort: state.awardWinnersSort, direction: state.awardWinnersDirection, region: state.region });
}
function loadAwardWinnersCached(cache, key, label, queryObject) {
  if (cache.has(key)) return cache.get(key);
  const pending = cubeLoad(label, queryObject).then(rows => {
    cache.set(key, rows);
    return rows;
  }).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}
function loadAwardWinnersPage(cache, key, label, queryObject) {
  const offset = Number(queryObject.offset || 0);
  const pageLimit = Number(queryObject.limit || 0);
  const fallbackKey = key + '|without-offset';
  if (offset && cache.has(fallbackKey)) return Promise.resolve(cache.get(fallbackKey)).then(rows => rows.slice(offset, offset + pageLimit));
  return Promise.resolve(loadAwardWinnersCached(cache, key, label, queryObject)).catch(error => {
    if (!offset) throw error;
    const fallbackQuery = { ...queryObject, limit: offset + pageLimit };
    delete fallbackQuery.offset;
    return loadAwardWinnersCached(cache, fallbackKey, label + ' · compatibilidade', fallbackQuery)
      .then(rows => rows.slice(offset, offset + pageLimit));
  });
}
function awardWinnersSortMember(cube, amount, idMember, nameMember) {
  return { identificador: idMember, nome: nameMember, quantidade: cube + '.count', valor: amount, requisitadas: cube + '.count_requisitado_pago', valor_requisitado: cube + '.vlr_premio_requisitado_pago' }[state.awardWinnersSort] || amount;
}
function awardWinnersTableHtml(id, rows, totalsRow, cube, amount, idMember, nameMember, type, page, pageSize, hasNext) {
  const requestedCount = cube + '.count_requisitado_pago';
  const requestedAmount = cube + '.vlr_premio_requisitado_pago';
  const value = (row, member) => num(val(row, member));
  const columns = [
    { key: 'Identificador', label: type === 'entidades' ? 'CNPJ' : 'CPF', sort: 'identificador' },
    { key: 'Nome', label: type === 'entidades' ? 'Nome fantasia' : 'Nome', sort: 'nome' },
    { key: 'Premiações', label: 'Número de premiações', sort: 'quantidade' },
    { key: 'Valor total', label: 'Valor de premiações', sort: 'valor' },
    { key: 'Requisitadas ou pagas', label: 'Nº requisitadas ou pagas', sort: 'requisitadas' },
    { key: 'Valor requisitado ou pago', label: 'Valor requisitado ou pago', sort: 'valor_requisitado' },
  ];
  const exportRows = rows.map(row => ({
    Identificador: val(row, idMember),
    Nome: val(row, nameMember),
    Premiações: value(row, cube + '.count'),
    'Valor total': value(row, amount),
    'Requisitadas ou pagas': value(row, requestedCount),
    'Valor requisitado ou pago': value(row, requestedAmount),
  }));
  window.__nfmExports = window.__nfmExports || {};
  window.__nfmExports[id] = exportRows;
  const body = exportRows.length ? exportRows.map(row => '<tr><td class="drill" data-drill-menu="' + (type === 'entidades' ? 'entity' : 'participant') + '" data-drill-mode="through" data-value="' + esc(row.Identificador) + '">' + esc(row.Identificador) + '</td><td>' + esc(row.Nome) + '</td><td class="measure">' + esc(n(row.Premiações)) + '</td><td class="measure">' + esc(money(row['Valor total'])) + '</td><td class="measure">' + esc(n(row['Requisitadas ou pagas'])) + '</td><td class="measure">' + esc(money(row['Valor requisitado ou pago'])) + '</td></tr>').join('') : '<tr><td colspan="6" class="empty">Nenhum registro encontrado.</td></tr>';
  const total = totalsRow[0] || {};
  const totalBeneficiaries = value(total, cube + '.count_distinct_premiado');
  const totalAwards = value(total, cube + '.count');
  const totalCells = [
    n(value(total, cube + '.count')),
    money(value(total, amount)),
    n(value(total, requestedCount)),
    money(value(total, requestedAmount)),
  ].map(item => '<td class="measure">' + esc(item) + '</td>').join('');
  const totalLabel = n(totalBeneficiaries) + ' beneficiários · ' + n(totalAwards) + ' premiações';
  const pager = '<div class="pager"><span>Total: ' + totalLabel + '</span><div><button data-award-winners-page="-1" ' + (page === 0 ? 'disabled' : '') + '>Anterior</button><span>Página ' + (page + 1) + '</span><button data-award-winners-page="1" ' + (!hasNext ? 'disabled' : '') + '>Próxima</button></div></div>';
  const header = columns.map(column => { const active = state.awardWinnersSort === column.sort; const arrow = active ? (state.awardWinnersDirection === 'asc' ? ' ↑' : ' ↓') : ''; return '<th' + (column.sort === 'identificador' || column.sort === 'nome' ? '' : ' class="measure"') + '><button class="sort-button" data-award-winners-sort="' + esc(column.sort) + '">' + esc(column.label) + arrow + '</button></th>'; }).join('');
  return '<div class="table-actions backend-table-toolbar"><label class="backend-search">Buscar nome ou CPF/CNPJ<input id="award-winners-search" value="' + esc(state.awardWinnersSearch) + '" placeholder="Digite e clique em Buscar"></label><button class="primary" data-award-winners-search="1">Buscar</button><span class="report-actions"><button class="text-button" data-copy-panel-sql="1">Copiar SQL</button><button class="text-button" data-copy-panel-api="1">Copiar chamada API</button><button class="text-button" data-export="' + esc(id) + '">Exportar página</button></span></div><div class="table-wrap"><table><thead><tr>' + header + '</tr></thead><tbody>' + body + '</tbody><tfoot><tr><th colspan="2">Total (' + totalLabel + ')</th>' + totalCells + '</tr></tfoot></table></div>' + pager;
}
function loadAwardWinnersPaged() {
  const type = state.awardType === 'entidades' ? 'entidades' : 'participantes';
  const cube = awardsCube(); const amount = awardMeasure(); const requestedCount = cube + '.count_requisitado_pago'; const requestedAmount = cube + '.vlr_premio_requisitado_pago'; const distinctAwarded = cube + '.count_distinct_premiado';
  const requestId = ++state.awardWinnersRequest; const idMember = type === 'entidades' ? 'td_entidade_social.id_entidade_social' : 'td_participante.id_participante'; const nameMember = type === 'entidades' ? 'td_entidade_social.nm_fantasia' : 'td_participante.nm_participante';
  const dateScope = dateRangeFilter(cube + '.dt_sorteio', state.awardWinnersFrom, state.awardWinnersTo); const filters = [...dateScope, ...awardWinnersFilters(idMember, nameMember)]; const page = state.awardWinnersPage; const offset = page * state.awardWinnersPageSize; const pageLimit = state.awardWinnersPageSize + 1; const sortMember = awardWinnersSortMember(cube, amount, idMember, nameMember); const order = { [sortMember]: state.awardWinnersDirection }; if (sortMember !== idMember) order[idMember] = 'asc'; const contextKey = awardWinnersContextKey(type);
  const pageQuery = { dimensions: [idMember, nameMember], measures: [cube + '.count', amount, requestedCount, requestedAmount], filters, order, limit: pageLimit, offset };
  const totalsQuery = { measures: [cube + '.count', amount, requestedCount, requestedAmount, distinctAwarded], filters };
  loadBlock('award-winners', () => [
    loadAwardWinnersPage(state.awardWinnersPageCache, contextKey + '|page=' + page, 'beneficiários premiados · página ' + (page + 1), pageQuery),
    loadAwardWinnersCached(state.awardWinnersTotalsCache, contextKey, 'totais de beneficiários premiados', totalsQuery),
  ], (rows, totalsRow) => {
    if (requestId !== state.awardWinnersRequest) return null;
    const hasNext = rows.length > state.awardWinnersPageSize;
    const pagesToPrefetch = [page - 2, page - 1, page + 1, page + 2].filter(candidate => candidate >= 0 && (candidate <= page || hasNext));
    pagesToPrefetch.reduce((chain, candidate) => chain.then(() => loadAwardWinnersPage(state.awardWinnersPageCache, contextKey + '|page=' + candidate, 'beneficiários premiados · página ' + (candidate + 1), { ...pageQuery, offset: candidate * state.awardWinnersPageSize }).catch(() => {})), Promise.resolve());
    const visibleRows = rows.slice(0, state.awardWinnersPageSize);
    window.setTimeout(() => setupAwardDateFilter('winners'), 0);
    return awardDateControl('winners') + awardWinnersTableHtml('award-winners-table', visibleRows, totalsRow, cube, amount, idMember, nameMember, type, page, state.awardWinnersPageSize, hasNext);
  }, { selector: '.table-wrap', mode: 'table' });
}
function pageAwards(target) {
  const type = state.awardType === 'entidades' ? 'entidades' : 'participantes';
  const controls = '<div class="segment"><button data-award-type="participantes" class="' + (type === 'participantes' ? 'selected' : '') + '">Participantes</button><button data-award-type="entidades" class="' + (type === 'entidades' ? 'selected' : '') + '">Entidades</button></div>';
  target.innerHTML = pageHeading('Premiações', 'Acompanhe os sorteios, status e beneficiários no período selecionado.', controls) + awardOverviewCard() + card('award-matrix', 'Matriz de sorteios por status', 'Sorteios mais recentes primeiro.') + card('award-winners', type === 'entidades' ? 'Entidades premiadas' : 'Participantes premiados', 'Os identificadores permitem abrir o detalhe correspondente.');
  setupAwardDateFilter('overview');
  loadAwardCharts();
  loadAwardMatrix();
  clearAwardWinnersCache();
  state.awardWinnersPage = 0;
  loadAwardWinnersPaged();
  return;
  target.innerHTML = pageHeading('Premiações', 'Acompanhe os sorteios, status e beneficiários no período selecionado.', controls) + '<div class="metric-toggle"><span>Métrica</span><button data-award-metric="quantidade" class="' + (state.awardMetric === 'quantidade' ? 'selected' : '') + '">Quantidade</button><button data-award-metric="valor" class="' + (state.awardMetric === 'valor' ? 'selected' : '') + '">Valor total</button></div><div class="grid two">' + card('award-chart', 'Premiações por status e data', 'Barras empilhadas por data de sorteio.') + card('award-donut', 'Composição por status', 'Total para o intervalo selecionado.') + '</div>' + card('award-matrix', 'Matriz de sorteios por status', 'Sorteios mais recentes primeiro.') + card('award-winners', type === 'entidades' ? 'Entidades premiadas' : 'Participantes premiados', 'Os identificadores permitem abrir o detalhe correspondente.');
  loadAwardCharts();
  loadAwardMatrix();
  const cube = awardsCube(); const amount = awardMeasure();
  const idMember = type === 'entidades' ? 'td_entidade_social.id_entidade_social' : 'td_participante.id_participante';
  const nameMember = type === 'entidades' ? 'td_entidade_social.nm_fantasia' : 'td_participante.nm_participante';
  loadBlock('award-winners', () => [queryAll('beneficiários premiados', { dimensions: [idMember, nameMember], measures: [cube + '.count', amount, cube + '.qtd_requisicoes'], timeDimensions: dateFilter(cube + '.dt_sorteio'), filters: regionFilter(), order: { [amount]: 'desc', [idMember]: 'asc' } })], rows => {
    const data = rows.map(row => ({ Identificador: val(row, idMember), Nome: val(row, nameMember), Premiações: num(val(row, cube + '.count')), 'Valor total': num(val(row, amount)), Requisitadas: num(val(row, cube + '.qtd_requisicoes')) }));
    return tableHtml('award-winners-table', type === 'entidades' ? 'Entidades com premiações' : 'Participantes com premiações', data, [{ key: 'Identificador', label: type === 'entidades' ? 'CNPJ' : 'CPF', drill: type === 'entidades' ? 'entity' : 'participant' }, { key: 'Nome', label: type === 'entidades' ? 'Nome fantasia' : 'Nome' }, { key: 'Premiações', label: 'Contagem', format: 'number', measure: true }, { key: 'Valor total', label: 'Valor total', format: 'money', measure: true }, { key: 'Requisitadas', label: 'Prêmios requisitados', format: 'number', measure: true }], { sort: 'Valor total' });
  });
}

function pageTickets(target) {
  window.setTimeout(() => {
    if (state.page !== 'bilhetagem' || !target.isConnected) return;
    target.innerHTML = target.innerHTML.replace('<div class="inline-filters">', card('ticket-overview', 'Agenda de bilhetagens', 'Últimas realizadas e próximas bilhetagens previstas.') + '<div class="inline-filters">');
    const histogram = document.getElementById('ticket-histogram');
    if (histogram) {
      histogram.insertAdjacentHTML('afterend', card('ticket-participant-distribution', 'Distribuição de bilhetes por participante', 'Quantidade de participantes em cada número de bilhetes.'));
      if (state.bilhetagem) loadTicketParticipantDistribution();
    }
    loadTicketOverview();
  }, 0);
  target.innerHTML = pageHeading('Bilhetagem', 'Selecione uma bilhetagem para detalhar participantes, bilhetes e faixas de distribuição.') + '<div class="inline-filters"><label>Tipo de sorteio<select id="ticket-type"><option value="">Todos os tipos</option></select></label><label>Bilhetagem<select id="ticket-select"><option value="">Carregando…</option></select></label><button data-ticket-shift="-1">← Anterior</button><button data-ticket-shift="1">Próxima →</button></div><div class="grid two">' + card('ticket-summary', 'Resumo da bilhetagem', 'Data de geração e cobertura selecionada.') + card('ticket-histogram', 'Bilhetes por participante', 'Histograma da quantidade exata de bilhetes.') + '</div>' + card('ticket-detail', 'Detalhamento territorial', 'Municípios ou regiões da bilhetagem selecionada.') + card('ticket-top', 'Participantes com mais bilhetes', 'Ordenado pela quantidade de bilhetes em ordem decrescente.');
  loadBilhetagemOptions();
}
function daysUntil(value) {
  const key = dateKey(value);
  if (!key) return null;
  return Math.round((Date.parse(key + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
function ticketSummaryMetrics(rows) {
  const row = rows[0] || {};
  return metricCards([
    { label: 'Data de geração', value: formatReportDate(val(row, 'td_bilhetagem.dt_gerar_bilhete')) },
    { label: 'Período de referência', value: formatReportDate(val(row, 'td_bilhetagem.dt_inicio_ref_compra')) + ' a ' + formatReportDate(val(row, 'td_bilhetagem.dt_fim_ref_compra')) },
    { label: 'Tipo de sorteio', value: val(row, 'td_sorteio_tipo.ds_sorteio_tipo') },
    { label: 'Participantes', value: n(val(row, 'tf_bilhetagem_resumo.qtd_participante')) },
    { label: 'Bilhetes', value: n(val(row, 'tf_bilhetagem_resumo.qtd_bilhete')) },
  ]);
}
function ticketHistogramChart() {
  const isParticipants = state.ticketHistogramMetric === 'participantes';
  const cube = isParticipants ? 'td_faixa_histograma_participante' : 'td_faixa_histograma_bilhete';
  const rows = state.ticketHistogramRows[isParticipants ? 'participantes' : 'bilhetes'] || [];
  const data = rows.map(row => ({
    Faixa: val(row, cube + '.ds_faixa_completo') || val(row, cube + '.ds_faixa'),
    Quantidade: num(val(row, 'tf_bilhetagem_resumo.count')),
  }));
  return chart('ticket-histogram-chart', data, {
    grid: { left: 75, right: 25, bottom: 72 },
    xAxis: { type: 'category', data: data.map(row => row.Faixa), name: 'Faixa de ' + (isParticipants ? 'participantes' : 'bilhetes') },
    yAxis: { type: 'value', name: 'Municípios/regiões' },
    dataZoom: [{ type: 'slider', bottom: 10 }, { type: 'inside' }],
    series: [{ name: 'Municípios/regiões', type: 'bar', data: data.map(row => row.Quantidade), itemStyle: { color: isParticipants ? '#741b79' : '#e84375' } }],
  }, 'Quantidade de municípios ou regiões em cada faixa de ' + (isParticipants ? 'participantes.' : 'bilhetes.'));
}
async function loadTicketHistogram() {
  if (isStatewideBilhetagem()) {
    document.getElementById('ticket-histogram')?.remove();
    return;
  }
  const version = state.version;
  beginBlockLoading('ticket-histogram');
  const participantQuery = {
    dimensions: ['tf_bilhetagem_resumo.sk_faixa_qtd_participante', 'td_faixa_histograma_participante.sk_faixa', 'td_faixa_histograma_participante.ds_faixa_completo', 'td_faixa_histograma_participante.ds_faixa', 'td_faixa_histograma_participante.vlr_min'],
    measures: ['tf_bilhetagem_resumo.count'],
    filters: ticketFilters(),
    order: { 'td_faixa_histograma_participante.vlr_min': 'asc' },
    limit: 100,
  };
  const ticketQuery = {
    dimensions: ['tf_bilhetagem_resumo.sk_faixa_qtd_bilhete', 'td_faixa_histograma_bilhete.sk_faixa', 'td_faixa_histograma_bilhete.ds_faixa_completo', 'td_faixa_histograma_bilhete.ds_faixa', 'td_faixa_histograma_bilhete.vlr_min'],
    measures: ['tf_bilhetagem_resumo.count'],
    filters: ticketFilters(),
    order: { 'td_faixa_histograma_bilhete.vlr_min': 'asc' },
    limit: 100,
  };
  try {
    const results = await Promise.all([
      cubeLoad('histograma por faixa de participantes', participantQuery),
      cubeLoad('histograma por faixa de bilhetes', ticketQuery),
    ]);
    if (version !== state.version) return;
    state.ticketHistogramRows = { participantes: results[0], bilhetes: results[1] };
    setBlock('ticket-histogram', ticketHistogramChart());
    bindPanelSql('ticket-histogram', results);
  } catch (error) {
    if (version === state.version) setBlock('ticket-histogram', '<div class="empty error">Não foi possível carregar o histograma.<br><small>' + esc(error.message || error) + '</small></div>');
  } finally {
    if (version === state.version) endBlockLoading('ticket-histogram');
  }
}
async function loadTicketHistogramLegacy() {
  if (isStatewideBilhetagem()) {
    document.getElementById('ticket-histogram')?.remove();
    return;
  }
  const version = state.version;
  beginBlockLoading('ticket-histogram');
  try {
    const results = await Promise.all([
      query('histograma por faixa de participantes', { dimensions: ['td_faixa_histograma_participante.ds_faixa_completo', 'td_faixa_histograma_participante.ds_faixa', 'td_faixa_histograma_participante.vlr_min'], measures: ['tf_bilhetagem_resumo.count'], filters: ticketFilters(), order: { 'td_faixa_histograma_participante.vlr_min': 'asc' }, limit: 100 }),
      query('histograma por faixa de bilhetes', { dimensions: ['td_faixa_histograma_bilhete.ds_faixa_completo', 'td_faixa_histograma_bilhete.ds_faixa', 'td_faixa_histograma_bilhete.vlr_min'], measures: ['tf_bilhetagem_resumo.count'], filters: ticketFilters(), order: { 'td_faixa_histograma_bilhete.vlr_min': 'asc' }, limit: 100 }),
    ]);
    if (version !== state.version) return;
    state.ticketHistogramRows = { participantes: results[0], bilhetes: results[1] };
    setBlock('ticket-histogram', ticketHistogramChart());
    bindPanelSql('ticket-histogram', results);
  } catch (error) {
    if (version === state.version) setBlock('ticket-histogram', '<div class="empty error">Não foi possível carregar o histograma.</div>');
  } finally {
    if (version === state.version) endBlockLoading('ticket-histogram');
  }
}
function clearTicketTopCache() {
  state.ticketTopPageCache.clear();
  state.ticketTopTotalsCache.clear();
}
function ticketTopContextKey() {
  return JSON.stringify({ bilhetagem: state.bilhetagem, search: state.ticketTopSearch.trim() });
}
function ticketTopTableHtml(rows, page, hasNext, totalParticipants) {
  const exportRows = rows.map(row => ({
    Participante: val(row, 'td_participante.id_participante'),
    Nome: val(row, 'td_participante.nm_participante'),
    Município: val(row, 'td_municipio.ds_municipio_ibge'),
    'Região fiscal': val(row, 'td_regiao_fiscal.nm_regiao_fiscal'),
    Bilhetes: num(val(row, 'tf_quantidade_bilhetes_participante.qtd_bilhetes')),
  }));
  window.__nfmExports = window.__nfmExports || {};
  window.__nfmExports['ticket-top-table'] = exportRows;
  const body = exportRows.length ? exportRows.map(row => '<tr><td class="drill" data-drill-menu="participant" data-drill-mode="through" data-value="' + esc(row.Participante) + '">' + esc(row.Participante) + '</td><td>' + esc(row.Nome) + '</td><td class="drill" data-drill-menu="municipality" data-value="' + esc(row.Município) + '">' + esc(row.Município) + '</td><td class="drill" data-drill-menu="region" data-value="' + esc(row['Região fiscal']) + '">' + esc(row['Região fiscal']) + '</td><td class="measure">' + esc(n(row.Bilhetes)) + '</td></tr>').join('') : '<tr><td colspan="5" class="empty">Nenhum registro encontrado.</td></tr>';
  const header = ['Participante', 'Nome', 'Município', 'Região fiscal', 'Quantidade de bilhetes'].map((label, index) => '<th' + (index === 4 ? ' class="measure"' : '') + '>' + esc(label) + '</th>').join('');
  const pager = '<div class="pager"><span>Total: ' + n(totalParticipants) + ' participantes</span><div><button data-ticket-top-page="-1" ' + (page === 0 ? 'disabled' : '') + '>Anterior</button><span>Página ' + (page + 1) + '</span><button data-ticket-top-page="1" ' + (!hasNext ? 'disabled' : '') + '>Próxima</button></div></div>';
  const foot = '<tfoot><tr><th colspan="4">Total (' + n(totalParticipants) + ' participantes)</th><td class="measure">' + esc(n(totalParticipants)) + '</td></tr></tfoot>';
  return '<div class="table-actions backend-table-toolbar"><label class="backend-search">Buscar CPF ou Nome<input id="ticket-top-search" value="' + esc(state.ticketTopSearch) + '" placeholder="Digite CPF ou nome e clique em Buscar"></label><button class="primary" data-ticket-top-search="1">Buscar</button><span class="report-actions"><button class="text-button" data-copy-panel-sql="1">Copiar SQL</button><button class="text-button" data-copy-panel-api="1">Copiar chamada API</button><button class="text-button" data-export="ticket-top-table">Exportar página</button></span></div><div class="table-wrap"><table><thead><tr>' + header + '</tr></thead><tbody>' + body + '</tbody>' + foot + '</table></div>' + pager;
}
function loadTicketTopPaged(loadingOptions = {}) {
  const version = state.version;
  const requestId = ++state.ticketTopRequest;
  const page = state.ticketTopPage;
  const pageSize = state.ticketTopPageSize;
  const offset = page * pageSize;
  const contextKey = ticketTopContextKey();
  const pageQuery = {
    dimensions: ['td_participante.id_participante', 'td_participante.nm_participante', 'td_municipio.ds_municipio_ibge', 'td_regiao_fiscal.nm_regiao_fiscal'],
    measures: ['tf_quantidade_bilhetes_participante.qtd_bilhetes'],
    filters: [...filter('tf_quantidade_bilhetes_participante.sk_bilhetagem', state.bilhetagem), ...(state.ticketTopSearch.trim() ? [{ or: [{ member: 'td_participante.id_participante', operator: 'contains', values: [state.ticketTopSearch.trim()] }, { member: 'td_participante.nm_participante', operator: 'contains', values: [state.ticketTopSearch.trim()] }] }] : [])],
    order: { 'tf_quantidade_bilhetes_participante.qtd_bilhetes': 'desc', 'td_participante.id_participante': 'asc' },
    limit: pageSize + 1,
    offset,
  };
  if (!document.getElementById('ticket-top')) return;
  beginBlockLoading('ticket-top', loadingOptions.selector, loadingOptions.mode);
  const totalsQuery = {
    measures: ['tf_quantidade_bilhetes_participante.count'],
    filters: pageQuery.filters,
  };
  Promise.all([
    loadAwardWinnersPage(state.ticketTopPageCache, contextKey + '|page=' + page, 'participantes com mais bilhetes · página ' + (page + 1), pageQuery),
    loadAwardWinnersCached(state.ticketTopTotalsCache, contextKey, 'total de participantes com mais bilhetes', totalsQuery),
  ])
    .then(([rows, totalsRow]) => {
      if (requestId !== state.ticketTopRequest || version !== state.version) return;
      const hasNext = rows.length > pageSize;
      const totalParticipants = num(val(totalsRow[0], 'tf_quantidade_bilhetes_participante.count'));
      state.resultQueries.set(rows, pageQuery);
      const pagesToPrefetch = [page - 2, page - 1, page + 1, page + 2].filter(candidate => candidate >= 0 && (candidate <= page || hasNext));
      pagesToPrefetch.reduce((chain, candidate) => chain.then(() => loadAwardWinnersPage(state.ticketTopPageCache, contextKey + '|page=' + candidate, 'participantes com mais bilhetes · página ' + (candidate + 1), { ...pageQuery, offset: candidate * pageSize }).catch(() => {})), Promise.resolve());
      setBlock('ticket-top', ticketTopTableHtml(rows.slice(0, pageSize), page, hasNext, totalParticipants));
      bindPanelSql('ticket-top', [rows, totalsRow]);
    })
    .catch(error => {
      if (requestId === state.ticketTopRequest && version === state.version) setBlock('ticket-top', '<div class="empty error">Não foi possível carregar esta seção.<br><small>' + esc(error.message || error) + '</small></div>');
    })
    .finally(() => {
      if (version === state.version) endBlockLoading('ticket-top', loadingOptions.selector, loadingOptions.mode);
    });
}
function loadTicketParticipantDistribution() {
  loadBlock('ticket-participant-distribution', () => [
    query('distribuição de bilhetes por participante', { dimensions: ['tf_quantidade_bilhetes_participante.qtd_bilhetes_participante'], measures: ['tf_quantidade_bilhetes_participante.count'], filters: filter('tf_quantidade_bilhetes_participante.sk_bilhetagem', state.bilhetagem), order: { 'tf_quantidade_bilhetes_participante.qtd_bilhetes_participante': 'asc' }, limit: 10000 }),
    query('maior quantidade de bilhetes por participante', { dimensions: ['tf_quantidade_bilhetes_participante.qtd_bilhetes_participante'], measures: ['tf_quantidade_bilhetes_participante.count'], filters: filter('tf_quantidade_bilhetes_participante.sk_bilhetagem', state.bilhetagem), order: { 'tf_quantidade_bilhetes_participante.qtd_bilhetes_participante': 'desc' }, limit: 1 }),
  ], (rows, maxRows) => {
    const maxTickets = num(val(maxRows[0], 'tf_quantidade_bilhetes_participante.qtd_bilhetes_participante'));
    const counts = new Map(rows.map(row => [num(val(row, 'tf_quantidade_bilhetes_participante.qtd_bilhetes_participante')), num(val(row, 'tf_quantidade_bilhetes_participante.count'))]));
    const data = Array.from({ length: maxTickets }, (_, index) => {
      const quantity = index + 1;
      return { 'Quantidade de bilhetes': quantity, Participantes: counts.get(quantity) || 0 };
    });
    const labels = data.map(row => n(row['Quantidade de bilhetes']) + (row['Quantidade de bilhetes'] === 1 ? ' bilhete' : ' bilhetes'));
    return chart('ticket-participant-distribution-chart', data, { grid: { left: 65, right: 25, bottom: 65 }, xAxis: { type: 'category', data: labels, name: 'Quantidade de bilhetes' }, yAxis: { type: 'value', name: 'Participantes' }, dataZoom: [{ type: 'slider', bottom: 8 }], series: [{ name: 'Participantes', data: data.map(row => row.Participantes), type: 'bar', itemStyle: { color: '#741b79' } }] }, 'Distribuição dos participantes pela quantidade de bilhetes gerados.');
  });
}
function loadTicketParticipantDistributionLegacy() {
  loadBlock('ticket-participant-distribution', () => [query('distribuição de bilhetes por participante', { dimensions: ['tf_quantidade_bilhetes_participante.qtd_bilhetes_participante'], measures: ['tf_quantidade_bilhetes_participante.count'], filters: filter('tf_quantidade_bilhetes_participante.sk_bilhetagem', state.bilhetagem), order: { 'tf_quantidade_bilhetes_participante.qtd_bilhetes_participante': 'asc' }, limit: 500 })], rows => {
    const x = rows.map(row => val(row, 'tf_quantidade_bilhetes_participante.qtd_bilhetes_participante'));
    return chart('ticket-participant-distribution-chart', rows, { grid: { left: 65, right: 25, bottom: 65 }, xAxis: { type: 'category', data: x, name: 'Quantidade de bilhetes' }, yAxis: { type: 'value', name: 'Participantes' }, dataZoom: [{ type: 'slider', bottom: 8 }], series: [{ name: 'Participantes', type: 'bar', data: rows.map(row => num(val(row, 'tf_quantidade_bilhetes_participante.count'))), itemStyle: { color: '#741b79' } }] }, 'Distribuição dos participantes pela quantidade de bilhetes gerados.');
  });
}
function daysUntilLabel(value) {
  const days = daysUntil(value);
  if (days == null) return '—';
  if (days === 0) return 'Hoje';
  if (days === 1) return '1 dia';
  return n(days) + ' dias';
}
function ticketOverviewHtml(recentRows, upcomingRows) {
  const recent = recentRows.map(row => ({
    'Data de bilhetagem': val(row, 'td_bilhetagem.dt_gerar_bilhete'),
    'Período de referência': formatReportDate(val(row, 'td_bilhetagem.dt_inicio_ref_compra')) + ' a ' + formatReportDate(val(row, 'td_bilhetagem.dt_fim_ref_compra')),
    'Tipo de bilhetagem': val(row, 'td_sorteio_tipo.ds_sorteio_tipo'),
    'Bilhetes gerados': num(val(row, 'tf_quantidade_bilhetes_participante.qtd_bilhetes')),
  }));
  const upcoming = upcomingRows
    .filter(row => daysUntil(val(row, 'td_bilhetagem.dt_gerar_bilhete')) >= 0)
    .map(row => ({
      'Data prevista': val(row, 'td_bilhetagem.dt_gerar_bilhete'),
      'Período de referência': formatReportDate(val(row, 'td_bilhetagem.dt_inicio_ref_compra')) + ' a ' + formatReportDate(val(row, 'td_bilhetagem.dt_fim_ref_compra')),
      'Tipo de bilhetagem': val(row, 'td_sorteio_tipo.ds_sorteio_tipo'),
      'Dias faltantes': daysUntilLabel(val(row, 'td_bilhetagem.dt_gerar_bilhete')),
    }))
    .slice(0, 5);
  const recentTable = tableHtml('ticket-recent-table', 'Últimas bilhetagens realizadas', recent, [
    { key: 'Data de bilhetagem', label: 'Data de bilhetagem', format: 'date' },
    { key: 'Período de referência', label: 'Período de referência' },
    { key: 'Tipo de bilhetagem', label: 'Tipo de bilhetagem' },
    { key: 'Bilhetes gerados', label: 'Bilhetes gerados', format: 'number', measure: true },
  ], { sort: 'Data de bilhetagem', direction: 'desc', showFilter: false, showTotal: false });
  const upcomingTable = tableHtml('ticket-upcoming-table', 'Próximas bilhetagens a realizar', upcoming, [
    { key: 'Data prevista', label: 'Data prevista', format: 'date' },
    { key: 'Período de referência', label: 'Período de referência' },
    { key: 'Tipo de bilhetagem', label: 'Tipo de bilhetagem' },
    { key: 'Dias faltantes', label: 'Quantos dias faltam' },
  ], { sort: 'Data prevista', direction: 'asc', showFilter: false, showTotal: false });
  return '<div class="ticket-overview-grid"><section class="ticket-overview-column">' + recentTable + '</section><section class="ticket-overview-column">' + upcomingTable + '</section></div>';
}
function loadTicketOverview() {
  if (state.ticketOverviewCache) {
    setBlock('ticket-overview', ticketOverviewHtml(state.ticketOverviewCache.recent, state.ticketOverviewCache.upcoming));
    bindPanelSql('ticket-overview', [state.ticketOverviewCache.recent, state.ticketOverviewCache.upcoming]);
    return;
  }
  loadTicketOverviewFromApi();
}
function loadTicketOverviewFromApi() {
  loadBlock('ticket-overview', () => [
    query('ultimas bilhetagens realizadas', {
      dimensions: ['tf_quantidade_bilhetes_participante.sk_bilhetagem', 'tf_quantidade_bilhetes_participante.dt_bilhetagem', 'td_bilhetagem.dt_gerar_bilhete', 'td_bilhetagem.dt_inicio_ref_compra', 'td_bilhetagem.dt_fim_ref_compra', 'td_sorteio_tipo.ds_sorteio_tipo'],
      measures: ['tf_quantidade_bilhetes_participante.qtd_bilhetes'],
      filters: dateRangeFilter('tf_quantidade_bilhetes_participante.dt_bilhetagem', START, today),
      order: { 'tf_quantidade_bilhetes_participante.dt_bilhetagem': 'desc' },
      limit: 5,
    }),
    query('agenda de bilhetagens', {
      dimensions: ['td_bilhetagem.sk_bilhetagem', 'td_bilhetagem.dt_gerar_bilhete', 'td_bilhetagem.dt_inicio_ref_compra', 'td_bilhetagem.dt_fim_ref_compra', 'td_sorteio_tipo.ds_sorteio_tipo'],
      measures: ['td_bilhetagem.count'],
      order: { 'td_bilhetagem.dt_gerar_bilhete': 'asc' },
      limit: 1000,
    }),
  ], (recent, upcoming) => {
    state.ticketOverviewCache = { recent, upcoming };
    return ticketOverviewHtml(recent, upcoming);
  });
}
async function loadBilhetagemOptions() {
  const rows = await query('lista de bilhetagens', { dimensions: ['td_bilhetagem.sk_bilhetagem', 'td_bilhetagem.dt_gerar_bilhete', 'td_sorteio_tipo.ds_sorteio_tipo'], measures: ['td_bilhetagem.count'], order: { 'td_bilhetagem.dt_gerar_bilhete': 'desc' }, limit: 1000 });
  if (!state.bilhetagem && rows[0]) state.bilhetagem = val(rows[0], 'td_bilhetagem.sk_bilhetagem');
  const types = [...new Set(rows.map(row => val(row, 'td_sorteio_tipo.ds_sorteio_tipo')).filter(Boolean))];
  const type = document.getElementById('ticket-type'); const select = document.getElementById('ticket-select'); if (!type || !select) return;
  type.innerHTML = '<option value="">Todos os tipos</option>' + types.map(value => '<option value="' + esc(value) + '">' + esc(value) + '</option>').join(''); type.value = state.bilhetagemType;
  const visible = rows.filter(row => !state.bilhetagemType || val(row, 'td_sorteio_tipo.ds_sorteio_tipo') === state.bilhetagemType);
  if (!visible.some(row => String(val(row, 'td_bilhetagem.sk_bilhetagem')) === String(state.bilhetagem))) state.bilhetagem = val(visible[0], 'td_bilhetagem.sk_bilhetagem');
  state.bilhetagemSelectedType = val(visible.find(row => String(val(row, 'td_bilhetagem.sk_bilhetagem')) === String(state.bilhetagem)), 'td_sorteio_tipo.ds_sorteio_tipo');
  if (isStatewideBilhetagem()) document.getElementById('ticket-histogram')?.remove();
  select.innerHTML = visible.map(row => '<option value="' + esc(val(row, 'td_bilhetagem.sk_bilhetagem')) + '">#' + esc(val(row, 'td_bilhetagem.sk_bilhetagem')) + ' · ' + esc(formatReportDate(val(row, 'td_bilhetagem.dt_gerar_bilhete'))) + ' · ' + esc(val(row, 'td_sorteio_tipo.ds_sorteio_tipo')) + '</option>').join(''); select.value = state.bilhetagem;
  if (document.getElementById('ticket-participant-distribution')) loadTicketParticipantDistribution();
  loadTicketBlocks();
}
function ticketFilters() { return filter('tf_bilhetagem_resumo.sk_bilhetagem', state.bilhetagem); }
function loadTicketBlocks() {
  if (!state.bilhetagem) return;
  loadTicketHistogram();
  loadBlock('ticket-summary', () => [query('resumo da bilhetagem', { dimensions: ['td_bilhetagem.dt_gerar_bilhete', 'td_bilhetagem.dt_inicio_ref_compra', 'td_bilhetagem.dt_fim_ref_compra', 'td_sorteio_tipo.ds_sorteio_tipo'], measures: ['tf_bilhetagem_resumo.qtd_participante', 'tf_bilhetagem_resumo.qtd_bilhete', 'tf_bilhetagem_resumo.populacao'], filters: ticketFilters() })], rows => {
    const row = rows[0] || {}; return recordSheet([
      { label: 'Data de geração', value: formatReportDate(val(row, 'td_bilhetagem.dt_gerar_bilhete')) },
      { label: 'Tipo de sorteio', value: val(row, 'td_sorteio_tipo.ds_sorteio_tipo') },
      { label: 'Participantes', value: n(val(row, 'tf_bilhetagem_resumo.qtd_participante')) },
      { label: 'Bilhetes', value: n(val(row, 'tf_bilhetagem_resumo.qtd_bilhete')) },
      { label: 'Período de referência', value: formatReportDate(val(row, 'td_bilhetagem.dt_inicio_ref_compra')) + ' a ' + formatReportDate(val(row, 'td_bilhetagem.dt_fim_ref_compra')) },
    ]);
  });
  loadBlock('ticket-detail', () => [query('detalhamento da bilhetagem', { dimensions: ['tf_bilhetagem_resumo.ds_bilhetagem', 'td_municipio.ds_municipio_ibge', 'td_regiao_fiscal.nm_regiao_fiscal'], measures: ['tf_bilhetagem_resumo.qtd_participante', 'tf_bilhetagem_resumo.qtd_bilhete', 'tf_bilhetagem_resumo.populacao'], filters: ticketFilters(), order: { 'tf_bilhetagem_resumo.qtd_bilhete': 'desc' }, limit: 1000 })], rows => {
    const data = rows.map(row => { const participants = num(val(row, 'tf_bilhetagem_resumo.qtd_participante')); const tickets = num(val(row, 'tf_bilhetagem_resumo.qtd_bilhete')); const population = num(val(row, 'tf_bilhetagem_resumo.populacao')); return { Descrição: val(row, 'tf_bilhetagem_resumo.ds_bilhetagem'), Município: val(row, 'td_municipio.ds_municipio_ibge'), 'Região fiscal': val(row, 'td_regiao_fiscal.nm_regiao_fiscal'), Participantes: participants, Bilhetes: tickets, População: population, 'Bilhetes por participante': tickets / Math.max(1, participants), 'Participantes por mil': participants * 1000 / Math.max(1, population), 'Bilhetes por mil': tickets * 1000 / Math.max(1, population) }; });
    return tableHtml('ticket-detail-table', 'Indicadores da bilhetagem', data, [{ key: 'Descrição', label: 'Descrição' }, { key: 'Município', label: 'Município', drill: 'municipality' }, { key: 'Região fiscal', label: 'Região fiscal', drill: 'region' }, { key: 'Participantes', label: 'Participantes', format: 'number', measure: true }, { key: 'Bilhetes', label: 'Bilhetes', format: 'number', measure: true }, { key: 'População', label: 'População', format: 'compact', measure: true }, { key: 'Bilhetes por participante', label: 'Bilhetes/participante', format: 'number', measure: true }, { key: 'Participantes por mil', label: 'Participantes/1.000', format: 'number', measure: true }, { key: 'Bilhetes por mil', label: 'Bilhetes/1.000', format: 'number', measure: true }], { sort: 'Bilhetes' });
  });
  loadBlock('ticket-top', () => [query('participantes com mais bilhetes', { dimensions: ['td_participante.id_participante', 'td_participante.nm_participante', 'td_municipio.ds_municipio_ibge', 'td_regiao_fiscal.nm_regiao_fiscal'], measures: ['tf_quantidade_bilhetes_participante.qtd_bilhetes'], filters: filter('tf_quantidade_bilhetes_participante.sk_bilhetagem', state.bilhetagem), order: { 'tf_quantidade_bilhetes_participante.qtd_bilhetes': 'desc' } })], rows => tableHtml('ticket-top-table', 'Participantes', rows.map(row => ({ CPF: val(row, 'td_participante.id_participante'), Nome: val(row, 'td_participante.nm_participante'), Município: val(row, 'td_municipio.ds_municipio_ibge'), 'Região fiscal': val(row, 'td_regiao_fiscal.nm_regiao_fiscal'), Bilhetes: num(val(row, 'tf_quantidade_bilhetes_participante.qtd_bilhetes')) })), [{ key: 'CPF', label: 'Participante', drill: 'participant' }, { key: 'Nome', label: 'Nome' }, { key: 'Município', label: 'Município', drill: 'municipality' }, { key: 'Região fiscal', label: 'Região fiscal', drill: 'region' }, { key: 'Bilhetes', label: 'Quantidade de bilhetes', format: 'number', measure: true }], { sort: 'Bilhetes' }));
}

function pageRequests(target) {
  target.innerHTML = pageHeading('Requisições', 'Acompanhamento de requisições de pagamento para participantes e entidades.') + '<div class="grid two">' + card('request-participants', 'Requisições de participantes', 'Status de retorno do pagamento e prêmio associado.') + card('request-entities', 'Requisições de entidades', 'Status de retorno do pagamento e prêmio associado.') + '</div>';
  requestTable('request-participants', 'tf_requisicao_pagamento_participante', 'tf_premiacoes_participantes', ['td_participante.id_participante', 'tf_premiacoes_participantes.sk_sorteio', 'tf_premiacoes_participantes.dt_sorteio', 'tf_premiacoes_participantes.vlr_premio_participante', 'td_pagamento_retorno_status.ds_pagamento_retorno_status'], 'Participante');
  requestTable('request-entities', 'tf_requisicao_pagamento_entidade', 'tf_premiacoes_entidades', ['td_entidade_social.id_entidade_social', 'td_entidade_social.nm_empresarial', 'td_entidade_social.nm_fantasia', 'td_participante.id_participante', 'tf_premiacoes_entidades.sk_sorteio', 'tf_premiacoes_entidades.dt_sorteio', 'tf_premiacoes_entidades.vlr_premio_entidade', 'td_pagamento_retorno_status.ds_pagamento_retorno_status'], 'Entidade');
}
function requestTable(block, cube, prize, dimensions, title) {
  loadBlock(block, () => [query('requisições de ' + title.toLowerCase(), { dimensions, measures: [cube + '.count'], timeDimensions: dateFilter(cube + '.dt_requisicao'), order: { [cube + '.dt_requisicao']: 'desc' }, limit: 1000 })], rows => {
    const data = rows.map(row => ({ Identificador: val(row, dimensions[0]), 'Nome empresarial': dimensions[1] && dimensions[1].includes('empresarial') ? val(row, dimensions[1]) : '', 'Nome fantasia': dimensions[2] && dimensions[2].includes('fantasia') ? val(row, dimensions[2]) : '', 'CPF participante': dimensions.find(item => item === 'td_participante.id_participante') ? val(row, 'td_participante.id_participante') : '', 'Número do sorteio': val(row, prize + '.sk_sorteio'), 'Data do sorteio': val(row, prize + '.dt_sorteio'), 'Valor do prêmio': val(row, prize + (prize.includes('entidades') ? '.vlr_premio_entidade' : '.vlr_premio_participante')), 'Data de requisição': val(row, cube + '.dt_requisicao'), 'Status de retorno': val(row, 'td_pagamento_retorno_status.ds_pagamento_retorno_status'), 'Data de retorno': val(row, cube + '.dt_retorno_proc_pag_grp') }));
    return tableHtml(block + '-table', title + 's', data, Object.keys(data[0] || { Identificador: '' }).map(key => ({ key, label: key, format: key.includes('Data') ? 'date' : key.includes('Valor') ? 'money' : undefined, drill: key === 'Identificador' ? (title === 'Entidade' ? 'entity' : 'participant') : key === 'CPF participante' ? 'participant' : undefined })), { sort: 'Data de requisição', direction: 'desc' });
  });
}

function pageDocuments(target) {
  target.innerHTML = pageHeading('Documentos por dia', 'NFC-e emitidas, com CPF e participantes do programa Nota Fiscal Mineira.') + '<div class="grid two">' + card('docs-line', 'NFC-e NFM por dia', 'Quantidade de documentos fiscais participantes do NFM.') + card('docs-data', 'Dados diários', 'Tabela do gráfico principal.') + '</div>' + card('docs-detail', 'Detalhamento e média móvel', 'Barras para média móvel de 7 dias e linhas para proporções.');
  loadBlock('docs-line', () => [docsQuery()], rows => {
    const data = docRows(rows); return chart('docs-line-chart', data, { grid: { left: 65, right: 25, bottom: 72 }, xAxis: { type: 'category', data: data.map(row => row.Data) }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 10 }], series: [{ name: 'NFC-e NFM', type: 'line', showSymbol: false, data: data.map(row => row['NFCe NFM']) }] }, 'Use o navegador temporal abaixo do eixo X.');
  });
  loadBlock('docs-data', () => [docsQuery()], rows => tableHtml('docs-data-table', 'NFC-e por data', docRows(rows), docColumns(), { sort: 'Data', direction: 'desc' }));
  loadBlock('docs-detail', () => [docsQuery()], rows => {
    const data = docRows(rows); return chart('docs-detail-chart', data, { legend: { top: 5 }, grid: { top: 50, left: 65, right: 65, bottom: 72 }, xAxis: { type: 'category', data: data.map(row => row.Data) }, yAxis: [{ type: 'value', name: 'NFC-e' }, { type: 'value', name: 'Proporção', axisLabel: { formatter: '{value}%' } }], dataZoom: [{ type: 'slider', bottom: 10 }], series: [{ name: 'Média móvel 7d', type: 'bar', data: data.map(row => row['Média móvel 7 dias']) }, { name: '% NFM', type: 'line', yAxisIndex: 1, showSymbol: false, data: data.map(row => row['% NFM'] * 100) }, { name: '% com CPF', type: 'line', yAxisIndex: 1, showSymbol: false, data: data.map(row => row['% CPF'] * 100) }] }, 'As proporções usam o segundo eixo Y.');
  });
}
function docsQuery() { return query('NFC-e por dia', { measures: ['tf_qt_nfce_dia.qt_nfce', 'tf_qt_nfce_dia.qt_nfce_cpf', 'tf_qt_nfce_dia.qt_nfce_nota_mineira'], timeDimensions: dateFilter('tf_qt_nfce_dia.dt_emissao'), filters: regionFilter(), order: { 'tf_qt_nfce_dia.dt_emissao.day': 'asc' }, limit: 5000 }); }
function docRows(rows) {
  const data = rows.map(row => ({ Data: day(val(row, 'tf_qt_nfce_dia.dt_emissao.day')), NFCe: num(val(row, 'tf_qt_nfce_dia.qt_nfce')), 'NFCe com CPF': num(val(row, 'tf_qt_nfce_dia.qt_nfce_cpf')), 'NFCe NFM': num(val(row, 'tf_qt_nfce_dia.qt_nfce_nota_mineira')) }));
  return data.map((row, index) => ({ ...row, '% CPF': row['NFCe com CPF'] / Math.max(1, row.NFCe), '% NFM': row['NFCe NFM'] / Math.max(1, row.NFCe), 'Média móvel 7 dias': data.slice(Math.max(0, index - 6), index + 1).reduce((sum, item) => sum + item.NFCe, 0) / Math.min(7, index + 1) }));
}
function docColumns() { return [{ key: 'Data', label: 'Data de emissão', format: 'date' }, { key: 'NFCe', label: 'Quantidade NFCe', format: 'number', measure: true }, { key: 'NFCe com CPF', label: 'NFCe com CPF', format: 'number', measure: true }, { key: 'NFCe NFM', label: 'NFCe NFM', format: 'number', measure: true }, { key: '% CPF', label: '% CPF', format: 'percent', measure: true }, { key: '% NFM', label: '% NFM', format: 'percent', measure: true }, { key: 'Média móvel 7 dias', label: 'Média móvel 7 dias', format: 'number', measure: true }]; }

function pageExpiring(target) {
  target.innerHTML = pageHeading('Premiações a vencer', 'Participantes com mais documentos fiscais no período selecionado.') + '<div class="grid two">' + card('expiring-total', 'Participantes com mais notas', 'Consolidado do período.') + card('expiring-day', 'Participantes com mais notas por dia', 'Detalhamento diário.') + '</div>';
  loadBlock('expiring-total', () => [query('participantes com mais documentos', { dimensions: ['td_participante.id_participante'], measures: ['tf_notas_participante_dia.qtd_nfce_dia', 'tf_notas_participante_dia.vlr_nfce_total_dia'], timeDimensions: dateFilter('tf_notas_participante_dia.sk_dt_emissao'), filters: regionFilter(), order: { 'tf_notas_participante_dia.qtd_nfce_dia': 'desc' }, limit: 1000 })], rows => tableHtml('expiring-total-table', 'Maior quantidade de documentos', rows.map(row => ({ CPF: val(row, 'td_participante.id_participante'), Documentos: num(val(row, 'tf_notas_participante_dia.qtd_nfce_dia')), Valor: num(val(row, 'tf_notas_participante_dia.vlr_nfce_total_dia')) })), [{ key: 'CPF', label: 'CPF', drill: 'participant' }, { key: 'Documentos', label: 'Documentos fiscais', format: 'number', measure: true }, { key: 'Valor', label: 'Valor', format: 'money', measure: true }], { sort: 'Documentos' }));
  loadBlock('expiring-day', () => [query('documentos por participante e dia', { dimensions: ['td_participante.id_participante'], measures: ['tf_notas_participante_dia.qtd_nfce_dia', 'tf_notas_participante_dia.vlr_nfce_total_dia'], timeDimensions: dateFilter('tf_notas_participante_dia.sk_dt_emissao'), filters: regionFilter(), order: { 'tf_notas_participante_dia.qtd_nfce_dia': 'desc' }, limit: 2000 })], rows => tableHtml('expiring-day-table', 'Documentos por dia', rows.map(row => ({ CPF: val(row, 'td_participante.id_participante'), Data: day(val(row, 'tf_notas_participante_dia.sk_dt_emissao.day')), Documentos: num(val(row, 'tf_notas_participante_dia.qtd_nfce_dia')), Valor: num(val(row, 'tf_notas_participante_dia.vlr_nfce_total_dia')) })), [{ key: 'CPF', label: 'CPF', drill: 'participant' }, { key: 'Data', label: 'Data de emissão', format: 'date' }, { key: 'Documentos', label: 'Documentos fiscais', format: 'number', measure: true }, { key: 'Valor', label: 'Valor', format: 'money', measure: true }], { sort: 'Documentos' }));
}

function pageScore(target) {
  target.innerHTML = pageHeading('Placar NFM', 'Resumo executivo de premiações, entidades, participantes e documentos.') + card('score-kpis', 'Indicadores do programa', 'Premiações e cadastros no período selecionado.') + '<div class="grid two">' + card('score-municipal', 'Indicadores por município', 'Ativos, população e NFC-e.') + card('score-fortnight', 'NFC-e por quinzena', 'Q1 e Q2 de cada mês.') + '</div>';
  loadBlock('score-kpis', () => [
    query('placar de prêmios participantes', { measures: ['tf_premiacoes_participantes.count', 'tf_premiacoes_participantes.vlr_premio_participante'], timeDimensions: dateFilter('tf_premiacoes_participantes.dt_sorteio'), filters: regionFilter() }),
    query('placar de prêmios entidades', { measures: ['tf_premiacoes_entidades.count', 'tf_premiacoes_entidades.vlr_premio_entidade'], timeDimensions: dateFilter('tf_premiacoes_entidades.dt_sorteio'), filters: regionFilter() }),
    query('entidades cadastradas', { measures: ['td_entidade_social.count'], limit: 1 }),
    query('entidades premiadas', { dimensions: ['td_entidade_social.id_entidade_social'], measures: ['tf_premiacoes_entidades.count'], timeDimensions: dateFilter('tf_premiacoes_entidades.dt_sorteio'), filters: regionFilter(), limit: 10000 }),
  ], (part, entity, registered, awarded) => metrics([{ label: 'Total para participantes', value: money(val(part[0], 'tf_premiacoes_participantes.vlr_premio_participante')), note: n(val(part[0], 'tf_premiacoes_participantes.count')) + ' prêmios' }, { label: 'Participantes premiados', value: n(val(part[0], 'tf_premiacoes_participantes.count')), note: 'Prêmios no período' }, { label: 'Entidades cadastradas', value: n(val(registered[0], 'td_entidade_social.count')), note: 'Cadastro total' }, { label: 'Entidades já premiadas', value: n(awarded.length), note: money(val(entity[0], 'tf_premiacoes_entidades.vlr_premio_entidade')) + ' em premiações' }]));
  loadBlock('score-municipal', () => [query('placar municipal NFCe acumulado de ' + rangeLabel(), { dimensions: [ACTIVE_MUNICIPAL_MEMBERS.municipio, ACTIVE_MUNICIPAL_MEMBERS.regiao, ACTIVE_MUNICIPAL_MEMBERS.delegacia], measures: [ACTIVE_MUNICIPAL_FACT_MEMBERS.nfce, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceCpf, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceNfm], filters: [...dateRangeFilter(ACTIVE_MUNICIPAL_FACT_MEMBERS.dateEmission), ...(state.region ? filter(ACTIVE_MUNICIPAL_MEMBERS.regiao, state.region) : [])], order: { [ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceNfm]: 'desc' }, limit: 1000 })], rows => tableHtml('score-municipal-table', 'NFC-e por município no período selecionado', rows.map(row => ({ Município: val(row, ACTIVE_MUNICIPAL_MEMBERS.municipio), 'Região fiscal': val(row, ACTIVE_MUNICIPAL_MEMBERS.regiao), 'DF circunscrição': val(row, ACTIVE_MUNICIPAL_MEMBERS.delegacia), NFCe: num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfce)), 'NFCe com CPF': num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceCpf)), 'NFCe NFM': num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceNfm)), '% CPF': num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceCpf)) / Math.max(1, num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfce))), '% NFM': num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfceNfm)) / Math.max(1, num(val(row, ACTIVE_MUNICIPAL_FACT_MEMBERS.nfce))) })), [{ key: 'Município', label: 'Município', drill: 'municipality' }, { key: 'Região fiscal', label: 'Região fiscal', drill: 'region' }, { key: 'DF circunscrição', label: 'DF circunscrição' }, { key: 'NFCe', label: 'NFCe', format: 'compact', measure: true }, { key: 'NFCe com CPF', label: 'NFCe com CPF', format: 'compact', measure: true }, { key: 'NFCe NFM', label: 'NFCe NFM', format: 'compact', measure: true }, { key: '% CPF', label: '% CPF', format: 'percent', measure: true }, { key: '% NFM', label: '% NFM', format: 'percent', measure: true }], { sort: 'NFCe NFM' }));
  loadBlock('score-fortnight', () => [docsQuery()], rows => {
    const groups = new Map(); docRows(rows).forEach(row => { const key = row.Data.slice(0, 7) + (Number(row.Data.slice(8, 10)) <= 15 ? ' · Q1' : ' · Q2'); const old = groups.get(key) || { Quinzena: key, NFCe: 0, 'NFCe com CPF': 0, 'NFCe NFM': 0 }; old.NFCe += row.NFCe; old['NFCe com CPF'] += row['NFCe com CPF']; old['NFCe NFM'] += row['NFCe NFM']; groups.set(key, old); }); const data = [...groups.values()];
    return chart('score-fortnight-chart', data, { legend: { top: 5 }, grid: { top: 48, left: 65, right: 25, bottom: 85 }, xAxis: { type: 'category', data: data.map(row => row.Quinzena) }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 12 }], series: ['NFCe', 'NFCe com CPF', 'NFCe NFM'].map(name => ({ name, type: 'line', showSymbol: false, data: data.map(row => row[name]) })) }, 'Três linhas: NFC-e, NFC-e com CPF e NFC-e NFM.') + tableHtml('score-fortnight-table', 'Dados por quinzena', data, [{ key: 'Quinzena', label: 'Quinzena' }, { key: 'NFCe', label: 'Quantidade NFCe', format: 'number', measure: true }, { key: 'NFCe com CPF', label: 'NFCe com CPF', format: 'number', measure: true }, { key: 'NFCe NFM', label: 'NFCe NFM', format: 'number', measure: true }], { sort: 'Quinzena', direction: 'desc' });
  });
}

function selector(id, label, selected, options, drill) {
  return '<label>' + esc(label) + '<select id="' + esc(id) + '" data-detail-select="' + esc(drill) + '"><option value="">Selecione…</option>' + options.map(row => '<option value="' + esc(row.value) + '"' + (String(selected) === String(row.value) ? ' selected' : '') + '>' + esc(row.label) + '</option>').join('') + '</select></label>';
}
function pageParticipant(target) {
  target.innerHTML = pageHeading('Página do participante', 'Selecione um participante ou abra a página com o parâmetro participante na URL.') + card('participant-selector', 'Participante', 'O seletor usa CPF e nome.') + '<div id="participant-content"></div>';
  loadBlock('participant-selector', () => [query('seletor de participantes', { dimensions: ['td_participante.id_participante', 'td_participante.nm_participante'], measures: ['td_participante.count'], order: { 'td_participante.nm_participante': 'asc' }, limit: 1000 })], rows => selector('participant-select', 'CPF / nome', state.params.participant, rows.map(row => ({ value: val(row, 'td_participante.id_participante'), label: val(row, 'td_participante.id_participante') + ' · ' + val(row, 'td_participante.nm_participante') })), 'participant'));
  if (state.params.participant) loadParticipantDetail();
}
function loadParticipantDetail() {
  const holder = document.getElementById('participant-content'); if (!holder) return;
  holder.innerHTML = '<div class="grid two">' + card('participant-profile', 'Dados do participante', 'Cadastro e histórico de adesões.') + card('participant-doc-chart', 'Documentos por dia', 'NFC-e do participante selecionado.') + '</div>' + '<div class="grid two">' + card('participant-tickets', 'Histórico de bilhetagem', '') + card('participant-awards', 'Histórico de premiações', '') + '</div>' + card('participant-emitters', 'Documentos fiscais por emitente', 'Disponibilidade do modelo atual.');
  const f = filter('td_participante.id_participante', state.params.participant);
  loadBlock('participant-profile', () => [query('perfil de participante', { dimensions: ['td_participante.id_participante', 'td_participante.nm_participante', 'td_participante.ds_email', 'td_participante.nr_celular', 'td_participante.nr_telefone_fixo'], measures: ['td_participante.count'], filters: f, limit: 1 }), query('adesões do participante', { dimensions: ['tf_participante_adesao.dt_inicio_adesao', 'tf_participante_adesao.dt_fim_adesao', 'tf_participante_adesao.fl_part_ativo'], measures: ['tf_participante_adesao.count'], filters: f, limit: 1000 })], (profile, history) => {
    const row = profile[0] || {};
    return recordSheet([
      { label: 'Nome', value: val(row, 'td_participante.nm_participante') },
      { label: 'CPF', value: val(row, 'td_participante.id_participante') },
      { label: 'E-mail', value: val(row, 'td_participante.ds_email') },
      { label: 'Telefone', value: val(row, 'td_participante.nr_celular') || val(row, 'td_participante.nr_telefone_fixo') },
    ]) + tableHtml('participant-history-table', 'Histórico de adesões', history.map(item => ({ 'Início da adesão': val(item, 'tf_participante_adesao.dt_inicio_adesao'), 'Fim da adesão': val(item, 'tf_participante_adesao.dt_fim_adesao'), Ativo: num(val(item, 'tf_participante_adesao.fl_part_ativo')) ? 'Sim' : 'Não' })), [{ key: 'Início da adesão', label: 'Início', format: 'date' }, { key: 'Fim da adesão', label: 'Fim', format: 'date' }, { key: 'Ativo', label: 'Ativo' }], { sort: 'Início da adesão', direction: 'desc' });
  });
  loadBlock('participant-doc-chart', () => [query('documentos do participante por dia', { measures: ['tf_notas_participante_dia.qtd_nfce_dia'], timeDimensions: dateFilter('tf_notas_participante_dia.sk_dt_emissao'), filters: f, order: { 'tf_notas_participante_dia.sk_dt_emissao.day': 'asc' }, limit: 5000 })], rows => chart('participant-documents-chart', rows, { grid: { left: 60, right: 25, bottom: 70 }, xAxis: { type: 'category', data: rows.map(row => day(val(row, 'tf_notas_participante_dia.sk_dt_emissao.day'))) }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 10 }], series: [{ type: 'line', showSymbol: false, data: rows.map(row => num(val(row, 'tf_notas_participante_dia.qtd_nfce_dia'))) }] }, 'Quantidade diária de documentos fiscais.'));
  loadBlock('participant-tickets', () => [query('bilhetagens do participante', { dimensions: ['td_bilhetagem.sk_bilhetagem', 'td_bilhetagem.dt_gerar_bilhete', 'td_sorteio_tipo.ds_sorteio_tipo'], measures: ['tf_quantidade_bilhetes_participante.qtd_bilhetes'], filters: f, order: { 'td_bilhetagem.dt_gerar_bilhete': 'desc' }, limit: 1000 })], rows => tableHtml('participant-tickets-table', 'Bilhetagens', rows.map(row => ({ ID: val(row, 'td_bilhetagem.sk_bilhetagem'), Tipo: val(row, 'td_sorteio_tipo.ds_sorteio_tipo'), 'Data de bilhetagem': val(row, 'td_bilhetagem.dt_gerar_bilhete'), Bilhetes: num(val(row, 'tf_quantidade_bilhetes_participante.qtd_bilhetes')) })), [{ key: 'ID', label: 'ID da bilhetagem' }, { key: 'Tipo', label: 'Tipo de sorteio' }, { key: 'Data de bilhetagem', label: 'Data', format: 'date' }, { key: 'Bilhetes', label: 'Bilhetes', format: 'number', measure: true }], { sort: 'Data de bilhetagem', direction: 'desc' }));
  loadBlock('participant-awards', () => [query('premiações do participante', { dimensions: ['td_sorteio.sk_sorteio', 'td_sorteio.ds_sorteio', 'td_premio_status.ds_premio_status'], measures: ['tf_premiacoes_participantes.vlr_premio_participante'], timeDimensions: dateFilter('tf_premiacoes_participantes.dt_sorteio'), filters: f, order: { 'tf_premiacoes_participantes.dt_sorteio.day': 'desc' }, limit: 1000 })], rows => tableHtml('participant-awards-table', 'Premiações', rows.map(row => ({ Sorteio: val(row, 'td_sorteio.sk_sorteio'), Data: day(val(row, 'tf_premiacoes_participantes.dt_sorteio.day')), Descrição: val(row, 'td_sorteio.ds_sorteio'), Valor: num(val(row, 'tf_premiacoes_participantes.vlr_premio_participante')), Status: val(row, 'td_premio_status.ds_premio_status') })), [{ key: 'Sorteio', label: 'Número do sorteio' }, { key: 'Data', label: 'Data', format: 'date' }, { key: 'Descrição', label: 'Descrição' }, { key: 'Valor', label: 'Valor', format: 'money', measure: true }, { key: 'Status', label: 'Status' }], { sort: 'Data', direction: 'desc' }));
  setBlock('participant-emitters', '<div class="empty">O modelo atual não expõe CNPJ ou nome do emitente em <code>TF_NOTAS_PARTICIPANTE_DIA</code>. A recomendação de modelo descreve o campo necessário para disponibilizar esta tabela.</div>');
}

function pageEntity(target) {
  target.innerHTML = pageHeading('Página da entidade', 'Selecione uma entidade ou abra a página com o parâmetro entidade na URL.') + card('entity-selector', 'Entidade social', 'O seletor usa CNPJ e nome fantasia.') + '<div id="entity-content"></div>';
  loadBlock('entity-selector', () => [query('seletor de entidades', { dimensions: ['td_entidade_social.id_entidade_social', 'td_entidade_social.nm_fantasia'], measures: ['td_entidade_social.count'], order: { 'td_entidade_social.nm_fantasia': 'asc' }, limit: 1000 })], rows => selector('entity-select', 'CNPJ / nome fantasia', state.params.entity, rows.map(row => ({ value: val(row, 'td_entidade_social.id_entidade_social'), label: val(row, 'td_entidade_social.id_entidade_social') + ' · ' + val(row, 'td_entidade_social.nm_fantasia') })), 'entity'));
  if (state.params.entity) loadEntityDetail();
}
function loadEntityDetail() {
  const holder = document.getElementById('entity-content'); if (!holder) return;
  holder.innerHTML = '<div class="grid two">' + card('entity-profile', 'Dados da entidade', 'Cadastro da entidade social.') + card('entity-indications-chart', 'Evolução de indicações', 'Quantidade diária de indicações.') + '</div><div class="grid two">' + card('entity-awards-chart', 'Histórico de premiações', 'Quantidade por status de premiação.') + card('entity-indications', 'Indicações', 'Participantes que indicaram a entidade.') + '</div>' + card('entity-awards', 'Premiações da entidade', 'Sorteio, participante e situação do prêmio.');
  const f = filter('td_entidade_social.id_entidade_social', state.params.entity);
  loadBlock('entity-profile', () => [query('perfil de entidade', { dimensions: ['td_entidade_social.id_entidade_social', 'td_entidade_social.nm_fantasia', 'td_entidade_social.nm_empresarial', 'td_entidade_social.nm_responsavel', 'td_entidade_social.ds_email', 'td_entidade_social.nr_telefone', 'td_entidade_social.nm_logradouro', 'td_entidade_social.nr_endereco'], measures: ['td_entidade_social.count'], filters: f, limit: 1 })], rows => {
    const row = rows[0] || {};
    return recordSheet([
      { label: 'Nome fantasia', value: val(row, 'td_entidade_social.nm_fantasia') },
      { label: 'Razão social', value: val(row, 'td_entidade_social.nm_empresarial') },
      { label: 'CNPJ', value: val(row, 'td_entidade_social.id_entidade_social') },
      { label: 'Responsável', value: val(row, 'td_entidade_social.nm_responsavel') },
      { label: 'E-mail', value: val(row, 'td_entidade_social.ds_email') },
      { label: 'Telefone', value: val(row, 'td_entidade_social.nr_telefone') },
      { label: 'Endereço', value: [val(row, 'td_entidade_social.nm_logradouro'), val(row, 'td_entidade_social.nr_endereco')].filter(Boolean).join(', ') },
    ]);
  });
  loadBlock('entity-indications-chart', () => [query('indicações por dia da entidade', { measures: ['tf_partic_ent_indicacoes.qtd_indicacoes'], timeDimensions: dateFilter('tf_partic_ent_indicacoes.data'), filters: f, order: { 'tf_partic_ent_indicacoes.data.day': 'asc' }, limit: 5000 })], rows => chart('entity-indications-line', rows, { grid: { left: 60, right: 25, bottom: 70 }, xAxis: { type: 'category', data: rows.map(row => day(val(row, 'tf_partic_ent_indicacoes.data.day'))) }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 10 }], series: [{ type: 'line', showSymbol: false, data: rows.map(row => num(val(row, 'tf_partic_ent_indicacoes.qtd_indicacoes'))) }] }, 'Evolução diária de indicações.'));
  loadBlock('entity-awards-chart', () => [query('status de premiação da entidade', { dimensions: ['td_premio_status.ds_premio_status'], measures: ['tf_premiacoes_entidades.count'], timeDimensions: dateFilter('tf_premiacoes_entidades.dt_sorteio'), filters: f, limit: 100 })], rows => chart('entity-awards-donut', rows, { tooltip: { trigger: 'item' }, legend: { bottom: 0 }, series: [{ type: 'pie', radius: ['42%', '72%'], data: rows.map(row => ({ name: val(row, 'td_premio_status.ds_premio_status'), value: num(val(row, 'tf_premiacoes_entidades.count')) })) }] }, 'Altere a visão geral de premiações para consultar valor total.'));
  loadBlock('entity-indications', () => [query('indicações da entidade', { dimensions: ['td_participante.id_participante', 'td_participante.nm_participante', 'td_regiao_fiscal_participante.nm_regiao_fiscal'], measures: ['tf_partic_ent_indicacoes.qtd_indicacoes'], timeDimensions: dateFilter('tf_partic_ent_indicacoes.data'), filters: f, order: { 'tf_partic_ent_indicacoes.data.day': 'desc' }, limit: 1000 })], rows => tableHtml('entity-indications-table', 'Participantes que indicaram a entidade', rows.map(row => ({ CPF: val(row, 'td_participante.id_participante'), Nome: val(row, 'td_participante.nm_participante'), 'Região fiscal': val(row, 'td_regiao_fiscal_participante.nm_regiao_fiscal'), Indicações: num(val(row, 'tf_partic_ent_indicacoes.qtd_indicacoes')) })), [{ key: 'CPF', label: 'CPF', drill: 'participant' }, { key: 'Nome', label: 'Nome' }, { key: 'Região fiscal', label: 'Região fiscal', drill: 'region' }, { key: 'Indicações', label: 'Indicações', format: 'number', measure: true }], { sort: 'Indicações' }));
  loadBlock('entity-awards', () => [query('premiações da entidade', { dimensions: ['td_sorteio.sk_sorteio', 'td_participante.id_participante', 'td_premio_status.ds_premio_status', 'tf_premiacoes_entidades.fl_entidade_indicada'], measures: ['tf_premiacoes_entidades.vlr_premio_entidade'], timeDimensions: dateFilter('tf_premiacoes_entidades.dt_sorteio'), filters: f, order: { 'tf_premiacoes_entidades.dt_sorteio.day': 'desc' }, limit: 1000 })], rows => tableHtml('entity-awards-table', 'Premiações', rows.map(row => ({ Sorteio: val(row, 'td_sorteio.sk_sorteio'), Data: day(val(row, 'tf_premiacoes_entidades.dt_sorteio.day')), CPF: val(row, 'td_participante.id_participante'), Valor: num(val(row, 'tf_premiacoes_entidades.vlr_premio_entidade')), Indicada: num(val(row, 'tf_premiacoes_entidades.fl_entidade_indicada')) ? 'Sim' : 'Não', Status: val(row, 'td_premio_status.ds_premio_status') })), [{ key: 'Sorteio', label: 'Sorteio' }, { key: 'Data', label: 'Data', format: 'date' }, { key: 'CPF', label: 'CPF do participante', drill: 'participant' }, { key: 'Valor', label: 'Valor', format: 'money', measure: true }, { key: 'Indicada', label: 'Indicada' }, { key: 'Status', label: 'Status' }], { sort: 'Data', direction: 'desc' }));
}

function geographicPage(target, kind) {
  const isRegion = kind === 'region'; const title = isRegion ? 'Página da região fiscal' : 'Página do município'; const param = isRegion ? 'regionDetail' : 'municipality'; const cube = isRegion ? 'td_regiao_fiscal' : 'td_municipio'; const label = isRegion ? 'Região fiscal' : 'Município';
  target.innerHTML = pageHeading(title, 'Selecione ' + (isRegion ? 'uma região fiscal' : 'um município') + ' ou abra a página com parâmetro na URL.') + card(kind + '-selector', label, 'Seleção para a visão detalhada.') + '<div id="' + kind + '-content"></div>';
  const dimension = isRegion ? 'td_regiao_fiscal.nm_regiao_fiscal' : 'td_municipio.ds_municipio_ibge';
  loadBlock(kind + '-selector', () => [query('seletor de ' + label.toLowerCase(), { dimensions: [dimension], measures: [cube + '.count'], order: { [dimension]: 'asc' }, limit: 1000 })], rows => selector(kind + '-select', label, state.params[param], rows.map(row => ({ value: val(row, dimension), label: val(row, dimension) })), kind));
  if (state.params[param]) loadGeographicDetail(kind);
}
function pageMunicipality(target) { geographicPage(target, 'municipality'); }
function pageRegion(target) { geographicPage(target, 'region'); }
function loadGeographicDetail(kind) {
  const isRegion = kind === 'region'; const member = isRegion ? 'td_regiao_fiscal.nm_regiao_fiscal' : 'td_municipio.ds_municipio_ibge'; const value = state.params[isRegion ? 'regionDetail' : 'municipality']; const holder = document.getElementById(kind + '-content'); if (!holder) return;
  holder.innerHTML = '<div class="grid two">' + card(kind + '-profile', 'Dados de ' + (isRegion ? 'região fiscal' : 'município'), 'Indicadores disponíveis no modelo.') + card(kind + '-trend', 'Evolução de participantes ativos', 'Série diária de participantes ativos.') + '</div><div class="grid two">' + card(kind + '-tickets', 'Dados de bilhetagem', 'Bilhetagens relacionadas à localização.') + card(kind + '-awards', 'Participantes premiados', 'Premiações na localização selecionada.') + '</div>';
  const f = filter(member, value);
  loadBlock(kind + '-profile', () => [query('perfil geográfico', { dimensions: isRegion ? [member] : [member, 'td_municipio.ds_df_circunscricao'], measures: [cubeMeasure(kind, 'populacao'), cubeMeasure(kind, 'count')], filters: f, limit: 1000 }), query('ativos geográficos', { measures: ['tf_participante_adesao.count_actives'], timeDimensions: activeSnapshotFilter(), filters: f })], (rows, active) => {
    const row = rows[0] || {};
    return recordSheet([
      { label: isRegion ? 'Região fiscal' : 'Município', value },
      ...(isRegion ? [] : [{ label: 'DF circunscrição', value: val(row, 'td_municipio.ds_df_circunscricao') }]),
      { label: 'População', value: n(val(row, cubeMeasure(kind, 'populacao'))) },
      { label: 'Participantes ativos', value: n(val(active[0], 'tf_participante_adesao.count_actives')) },
    ]);
  });
  loadBlock(kind + '-trend', () => [query('evolução geográfica de ativos', { measures: ['tf_participante_adesao.count_actives'], timeDimensions: dateFilter('tf_participante_adesao.sk_dt_adesao'), filters: f, order: { 'tf_participante_adesao.sk_dt_adesao.day': 'asc' }, limit: 5000 })], rows => chart(kind + '-trend-chart', rows, { grid: { left: 60, right: 25, bottom: 70 }, xAxis: { type: 'category', data: rows.map(row => day(val(row, 'tf_participante_adesao.sk_dt_adesao.day'))) }, yAxis: { type: 'value' }, dataZoom: [{ type: 'slider', bottom: 10 }], series: [{ type: 'line', areaStyle: {}, showSymbol: false, data: rows.map(row => num(val(row, 'tf_participante_adesao.count_actives'))) }] }, 'Participantes ativos por data.'));
  loadBlock(kind + '-tickets', () => [query('bilhetagens geográficas', { dimensions: ['td_bilhetagem.sk_bilhetagem', 'td_bilhetagem.dt_gerar_bilhete'], measures: ['tf_bilhetagem_resumo.qtd_participante', 'tf_bilhetagem_resumo.qtd_bilhete'], filters: f, order: { 'td_bilhetagem.dt_gerar_bilhete': 'desc' }, limit: 1000 })], rows => tableHtml(kind + '-tickets-table', 'Bilhetagens', rows.map(row => ({ ID: val(row, 'td_bilhetagem.sk_bilhetagem'), 'Data de geração': val(row, 'td_bilhetagem.dt_gerar_bilhete'), Participantes: num(val(row, 'tf_bilhetagem_resumo.qtd_participante')), Bilhetes: num(val(row, 'tf_bilhetagem_resumo.qtd_bilhete')) })), [{ key: 'ID', label: 'ID' }, { key: 'Data de geração', label: 'Data de geração', format: 'date' }, { key: 'Participantes', label: 'Participantes', format: 'number', measure: true }, { key: 'Bilhetes', label: 'Bilhetes', format: 'number', measure: true }], { sort: 'Data de geração', direction: 'desc' }));
  loadBlock(kind + '-awards', () => [query('premiações geográficas', { dimensions: ['td_participante.id_participante', 'td_sorteio_tipo.ds_sorteio_tipo', 'td_premio_status.ds_premio_status'], measures: ['tf_premiacoes_participantes.vlr_premio_participante'], timeDimensions: dateFilter('tf_premiacoes_participantes.dt_sorteio'), filters: f, order: { 'tf_premiacoes_participantes.dt_sorteio.day': 'desc' }, limit: 1000 })], rows => tableHtml(kind + '-awards-table', 'Participantes premiados', rows.map(row => ({ CPF: val(row, 'td_participante.id_participante'), Data: day(val(row, 'tf_premiacoes_participantes.dt_sorteio.day')), Tipo: val(row, 'td_sorteio_tipo.ds_sorteio_tipo'), Valor: num(val(row, 'tf_premiacoes_participantes.vlr_premio_participante')), Status: val(row, 'td_premio_status.ds_premio_status') })), [{ key: 'CPF', label: 'CPF', drill: 'participant' }, { key: 'Data', label: 'Data do sorteio', format: 'date' }, { key: 'Tipo', label: 'Tipo de sorteio' }, { key: 'Valor', label: 'Valor do prêmio', format: 'money', measure: true }, { key: 'Status', label: 'Status' }], { sort: 'Data', direction: 'desc' }));
}
function cubeMeasure(kind, field) { return (kind === 'region' ? 'td_regiao_fiscal.' : 'td_municipio.') + field; }

function formatSql(statement) {
  try {
    return sqlFormatter.format(String(statement).trim(), {
      indent: '  ',
      uppercase: true,
      linesBetweenQueries: 1,
    });
  } catch (_) {
    return String(statement);
  }
}
function generatedSql(body) {
  const result = Array.isArray(body) ? body[0] : body;
  const sqlQuery = result && result.sql && result.sql.sql ? result.sql : result;
  const statement = Array.isArray(sqlQuery && sqlQuery.sql) ? sqlQuery.sql[0] : sqlQuery && sqlQuery.sql;
  const values = Array.isArray(sqlQuery && sqlQuery.sql) ? sqlQuery.sql[1] : sqlQuery && sqlQuery.values;
  if (!statement) throw new Error('A API não retornou o SQL compilado.');
  if (!Array.isArray(values) || !values.length) return formatSql(statement);
  let position = 0;
  const executable = String(statement).replace(/\?/g, () => {
    if (position >= values.length) return '?';
    const value = values[position++];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    const text = String(value);
    const netezzaTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(text) ? text.replace('T', ' ').replace(/Z$/, '') : text;
    return '\'' + netezzaTimestamp.replace(/'/g, "''") + '\'';
  });
  if (position !== values.length) throw new Error('A quantidade de parâmetros retornada pela API não corresponde ao SQL compilado.');
  return '-- SQL executável no Netezza; os parâmetros do Cube foram aplicados abaixo.\n' + formatSql(executable) + '\n\n-- Parâmetros originais: ' + JSON.stringify(values);
}
async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); return; }
  const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select();
  const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error('O navegador bloqueou a cópia para a área de transferência.');
}
async function copyGeneratedSql(callId) {
  const call = state.calls.find(item => item.id === callId);
  if (!call || !call.query) { showToast('Esta chamada não possui uma consulta Cube para converter em SQL.', true); return; }
  try {
    const body = await request('SQL gerado · ' + call.label, sqlUrl(), { method: 'POST', body: JSON.stringify({ query: call.query }) }, call.query);
    const sql = generatedSql(body);
    call.generatedSql = sql;
    await copyText(sql);
    showToast('SQL executável copiado para a área de transferência.');
    renderCalls();
  } catch (error) {
    showToast('Não foi possível gerar o SQL: ' + error.message, true);
  }
}
async function copyPanelSql(button) {
  const panel = button.closest('.panel, .standalone-metrics');
  if (!panel) { showToast('Não foi possível identificar a consulta deste componente.', true); return; }
  let queries;
  try { queries = JSON.parse(panel.dataset.sqlQueries || '[]'); } catch (_) { queries = []; }
  if (!queries.length) { showToast('Esta visualização não possui uma consulta Cube associada.', true); return; }

  const previousLabel = button.textContent;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Gerando SQL…';
  try {
    const statements = [];
    for (let index = 0; index < queries.length; index += 1) {
      const queryObject = queries[index];
      const body = await request('SQL gerado · componente', sqlUrl(), { method: 'POST', body: JSON.stringify({ query: queryObject }) }, queryObject);
      statements.push('-- Consulta ' + (index + 1) + ' de ' + queries.length + '\n' + generatedSql(body));
    }
    await copyText(statements.join('\n\n\n'));
    showToast(queries.length === 1 ? 'SQL executável copiado para a área de transferência.' : queries.length + ' SQLs executáveis copiados para a área de transferência.');
  } catch (error) {
    showToast('Não foi possível gerar o SQL: ' + error.message, true);
  } finally {
    if (button.isConnected) { button.removeAttribute('aria-busy'); button.textContent = previousLabel; }
  }
}
function apiRequestDescriptor(method, url, queryObject) {
  return { method, url, body: { query: queryObject } };
}
async function copyPanelApiCall(button) {
  const panel = button.closest('.panel, .standalone-metrics');
  if (!panel) { showToast('Não foi possível identificar a chamada deste componente.', true); return; }
  let queries;
  try { queries = JSON.parse(panel.dataset.sqlQueries || '[]'); } catch (_) { queries = []; }
  if (!queries.length) { showToast('Esta visualização não possui uma chamada API associada.', true); return; }
  const requests = queries.map(queryObject => apiRequestDescriptor('POST', loadUrl(), queryObject));
  await copyText(JSON.stringify(requests.length === 1 ? requests[0] : requests, null, 2));
  showToast(requests.length === 1 ? 'Chamada da API copiada para a área de transferência.' : requests.length + ' chamadas da API copiadas para a área de transferência.');
}
async function copyApiCall(callId) {
  const call = state.calls.find(item => item.id === callId);
  if (!call || !call.query) { showToast('Esta chamada não possui uma consulta Cube para copiar.', true); return; }
  await copyText(JSON.stringify(apiRequestDescriptor(call.method, call.url, call.query), null, 2));
  showToast('Chamada da API copiada para a área de transferência.');
}
function closeModal(name) {
  const modal = document.getElementById(name + '-modal');
  if (!modal) return;
  modal.hidden = true;
  if (name === 'calls') stopCallsTimer();
}
function openModal(name) {
  ['calls', 'connection'].forEach(item => {
    if (item !== name) closeModal(item);
  });
  const modal = document.getElementById(name + '-modal');
  if (modal) modal.hidden = false;
}
function stopCallsTimer() {
  if (!callsTimer) return;
  window.clearInterval(callsTimer);
  callsTimer = 0;
}
function updatePendingCallTimers() {
  const modal = document.getElementById('calls-modal');
  if (!modal || modal.hidden) { stopCallsTimer(); return; }
  const now = performance.now();
  modal.querySelectorAll('[data-call-elapsed]').forEach(node => {
    const call = state.calls.find(item => item.id === node.dataset.callElapsed);
    if (!call || call.status !== 'pending') return;
    node.textContent = 'em andamento · ' + ms(now - call.startedAt);
  });
}
function syncCallsTimer() {
  const modal = document.getElementById('calls-modal');
  const pending = state.calls.some(call => call.status === 'pending');
  if (!modal || modal.hidden || !pending) { stopCallsTimer(); return; }
  if (!callsTimer) callsTimer = window.setInterval(updatePendingCallTimers, 250);
  updatePendingCallTimers();
}
function renderCalls() {
  const count = document.getElementById('call-count'); if (count) count.textContent = state.calls.length;
  const modal = document.getElementById('calls-modal');
  if (!modal || modal.hidden) { stopCallsTimer(); return; }
  const successful = state.calls.filter(call => call.status === 'sucesso');
  const average = successful.length ? successful.reduce((sum, call) => sum + call.duration, 0) / successful.length : 0;
  const callItems = state.calls.map(call => {
    const kind = call.status === 'sucesso' ? 'success' : call.status === 'pending' ? 'pending' : 'error';
    const status = call.status === 'pending' ? 'aguardando resposta' : call.status;
    const duration = call.status === 'pending' ? performance.now() - call.startedAt : call.duration;
    const timing = call.status === 'pending'
      ? '<small data-call-elapsed="' + esc(call.id) + '">em andamento · ' + ms(duration) + '</small>'
      : '<small>' + ms(duration) + ' · ' + n(call.rows) + ' linhas</small>';
    return '<details class="call-' + kind + '"><summary><span class="call-status">' + esc(status) + '</span><strong>' + esc(call.label) + '</strong>' + timing + '</summary><div class="call-details">' + (call.query ? '<button class="text-button sql-copy" data-copy-sql="' + esc(call.id) + '">Copiar SQL gerado</button>' : '') + '<pre>' + esc(JSON.stringify({ consulta: call.query, requestId: call.requestId, resposta: call.response && call.response.error ? call.response.error : undefined }, null, 2)) + '</pre>' + (call.generatedSql ? '<pre class="generated-sql">' + esc(call.generatedSql) + '</pre>' : '') + '</div></details>';
  }).join('');
  const pendingCount = state.calls.filter(call => call.status === 'pending').length;
  modal.innerHTML = '<div class="modal-card wide"><div class="modal-head"><div><h2>Chamadas da API do Cube</h2><p>' + state.calls.length + ' chamadas · ' + pendingCount + ' aguardando resposta · latência média ' + (average ? ms(average) : '—') + ' · ' + n(successful.reduce((sum, call) => sum + call.rows, 0)) + ' linhas retornadas</p></div><button data-close-modal="calls">×</button></div><div class="call-list">' + callItems + '</div><button class="text-button" data-export-calls="1">Exportar diagnóstico JSON</button></div>';
  modal.querySelectorAll('[data-copy-sql]').forEach(button => {
    button.insertAdjacentHTML('afterend', '<button class="text-button sql-copy" data-copy-api-call="' + esc(button.dataset.copySql) + '">Copiar chamada API</button>');
  });
  syncCallsTimer();
}
function connectionModal() {
  openModal('connection');
  const modal = document.getElementById('connection-modal');
  modal.innerHTML = '<div class="modal-card"><div class="modal-head"><div><h2>Entrar no relatório</h2><p>A conexão do datamart já está definida pelo projeto.</p></div><button data-close-modal="connection">×</button></div><div class="connection-section"><h3>Suas credenciais</h3><p>Informe somente seu login e senha. A senha é usada para abrir uma sessão temporária e não é salva pelo painel.</p><div class="connection-grid"><label>Login<input id="session-user" autocomplete="username" autofocus></label><label>Senha<input id="session-password" type="password" autocomplete="current-password"></label></div><button id="open-session" class="primary">Entrar</button></div></div>';
}
async function openDatamartSession() {
  const user = document.getElementById('session-user').value.trim();
  const password = document.getElementById('session-password').value;
  if (!user || !password) { showToast('Informe seu login e sua senha.', true); return; }
  const button = document.getElementById('open-session'); button.disabled = true; button.textContent = 'Abrindo sessão…';
  state.token = '';
  localStorage.removeItem('nfm-api-token');
  try {
    await request('abrir sessão do datamart', endpoint('/playground/datamarts/' + DATAMART + '/session'), { method: 'POST', body: JSON.stringify({ credentials: { CUBEJS_DB_USER: user, CUBEJS_DB_PASS: password } }) });
    document.getElementById('session-password').value = '';
    closeModal('connection');
    await initialize(true);
  } catch (error) {
    showToast('Não foi possível abrir a sessão: ' + error.message, true);
  } finally {
    if (button.isConnected) { button.disabled = false; button.textContent = 'Abrir sessão'; }
  }
}

app.addEventListener('click', event => {
  if (event.target.classList?.contains('modal')) {
    closeModal(event.target.id.replace(/-modal$/, ''));
    return;
  }
  const menu = document.getElementById('drill-menu');
  const menuWasOpen = menu && !menu.hidden;
  if (menuWasOpen && !event.target.closest('#drill-menu')) closeDrillMenu();
  const target = event.target.closest('button, td'); if (!target) return;
  if (target.dataset.page) { state.page = target.dataset.page; if (state.page !== 'ativos') { state.activeDrillRegion = ''; state.activeDrillMunicipality = ''; } renderShell(); renderCurrentPage(); return; }
  if (target.id === 'refresh') { initialize(true); return; }
  if (target.id === 'active-drill-clear') { state.activeDrillRegion = ''; state.activeDrillMunicipality = ''; renderCurrentPage(); return; }
  if (target.id === 'active-drill-back') { state.activeDrillMunicipality = ''; renderCurrentPage(); return; }
  if (target.dataset.drillMenuClose) { closeDrillMenu(); return; }
  if (target.dataset.drillAction) { applyDrillAction(target.dataset.drillAction, target.dataset.drillKind, target.dataset.drillValue); return; }
  if (target.dataset.activeGroup) { switchActiveGroup(target.dataset.activeGroup); return; }
  if (target.dataset.modal === 'calls') { openModal('calls'); renderCalls(); return; }
  if (target.dataset.modal === 'connection') { connectionModal(); return; }
  if (target.dataset.closeModal) {
    closeModal(target.dataset.closeModal);
    return;
  }
  if (target.id === 'save-connection') { state.origin = document.getElementById('api-origin').value.trim(); state.token = document.getElementById('api-token').value.trim(); localStorage.setItem('nfm-api-origin', state.origin); localStorage.setItem('nfm-api-token', state.token); closeModal('connection'); initialize(true); return; }
  if (target.id === 'open-session') { openDatamartSession(); return; }
  if (target.dataset.awardType) { state.awardType = target.dataset.awardType; renderCurrentPage(); return; }
  if (target.dataset.awardMetric) {
    state.awardMetric = target.dataset.awardMetric;
    document.querySelectorAll('[data-award-metric]').forEach(button => button.classList.toggle('selected', button.dataset.awardMetric === state.awardMetric));
    loadAwardCharts();
    return;
  }
  if (target.dataset.ticketHistogramMetric) {
    state.ticketHistogramMetric = target.dataset.ticketHistogramMetric;
    document.querySelectorAll('[data-ticket-histogram-metric]').forEach(button => button.classList.toggle('selected', button.dataset.ticketHistogramMetric === state.ticketHistogramMetric));
    if (document.getElementById('ticket-histogram-chart')) { setBlock('ticket-histogram', ticketHistogramChart()); flashBlockLoading('ticket-histogram'); }
    return;
  }
  if (target.dataset.awardWinnersSearch) {
    state.awardWinnersSearch = document.getElementById('award-winners-search')?.value.trim() || '';
    clearAwardWinnersCache();
    state.awardWinnersPage = 0;
    loadAwardWinnersPaged();
    return;
  }
  if (target.dataset.awardWinnersSort) {
    if (state.awardWinnersSort === target.dataset.awardWinnersSort) state.awardWinnersDirection = state.awardWinnersDirection === 'asc' ? 'desc' : 'asc';
    else { state.awardWinnersSort = target.dataset.awardWinnersSort; state.awardWinnersDirection = 'desc'; }
    clearAwardWinnersCache();
    state.awardWinnersPage = 0;
    loadAwardWinnersPaged();
    return;
  }
  if (target.dataset.awardMatrixPage) { state.awardMatrixPage += Number(target.dataset.awardMatrixPage); renderAwardMatrix(); flashBlockLoading('award-matrix'); return; }
  if (target.dataset.awardWinnersPage) { state.awardWinnersPage += Number(target.dataset.awardWinnersPage); loadAwardWinnersPaged(); return; }
  if (target.dataset.ticketTopSearch) { state.ticketTopSearch = document.getElementById('ticket-top-search')?.value.trim() || ''; state.ticketTopPage = 0; clearTicketTopCache(); loadTicketTopPaged({ selector: '.table-wrap', mode: 'table' }); return; }
  if (target.dataset.ticketTopPage) { state.ticketTopPage += Number(target.dataset.ticketTopPage); loadTicketTopPaged({ selector: '.table-wrap', mode: 'table' }); return; }
  if (target.dataset.ticketShift) { const select = document.getElementById('ticket-select'); if (select) { select.selectedIndex = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + Number(target.dataset.ticketShift))); state.bilhetagem = select.value; state.ticketTopPage = 0; clearTicketTopCache(); renderCurrentPage(); } return; }
  if (target.dataset.export) { exportExcel(target.dataset.export, (window.__nfmExports || {})[target.dataset.export] || []); return; }
  if (target.dataset.exportTable) { const source = state.tables.get(target.dataset.exportTable); if (source) exportExcel(target.dataset.exportTable, source.rows, source.columns); return; }
  if (target.dataset.exportCalls) { const blob = new Blob([JSON.stringify(state.calls, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'nota-mineira-chamadas-api.json'; link.click(); URL.revokeObjectURL(link.href); return; }
  if (target.dataset.copySql) { copyGeneratedSql(target.dataset.copySql); return; }
  if (target.dataset.copyApiCall) { copyApiCall(target.dataset.copyApiCall); return; }
  if (target.dataset.copyPanelSql) { copyPanelSql(target); return; }
  if (target.dataset.copyPanelApi) { copyPanelApiCall(target); return; }
  if (target.dataset.tableSort) { const source = state.tables.get(target.dataset.tableSort); source.direction = source.sort === target.dataset.key ? (source.direction === 'asc' ? 'desc' : 'asc') : 'desc'; source.sort = target.dataset.key; renderTable(target.dataset.tableSort); flashTableLoading(target.dataset.tableSort); return; }
  if (target.dataset.tablePage) { const source = state.tables.get(target.dataset.tablePage); source.page += Number(target.dataset.direction); renderTable(target.dataset.tablePage); flashTableLoading(target.dataset.tablePage); return; }
  if (target.dataset.drillMenu) { openDrillMenu(target.dataset.drillMenu, target.dataset.value, 'table', event, target.dataset.drillMode); return; }
  if (target.dataset.drill) { const mapping = { participant: ['participante', 'participant'], entity: ['entidade', 'entity'], municipality: ['municipio', 'municipality'], region: ['regiao', 'regionDetail'] }; const item = mapping[target.dataset.drill]; if (item) { state.page = item[0]; state.params[item[1]] = target.dataset.value; renderShell(); renderCurrentPage(); } }
});

app.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.target.id !== 'award-winners-search') return;
  event.preventDefault();
  document.querySelector('[data-award-winners-search]')?.click();
});
app.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.target.id !== 'ticket-top-search') return;
  event.preventDefault();
  document.querySelector('[data-ticket-top-search]')?.click();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDrillMenu();
});
app.addEventListener('input', event => {
  if (event.target.id === 'award-overview-date-range-from' || event.target.id === 'award-overview-date-range-to') { updateAwardDatePreview('overview'); return; }
  if (event.target.id === 'award-winners-date-range-from' || event.target.id === 'award-winners-date-range-to') { updateAwardDatePreview('winners'); return; }
  if (event.target.id === 'award-table-date-range-from' || event.target.id === 'award-table-date-range-to') { updateAwardTableDatePreview(); return; }
  if (event.target.id === 'active-date-range-from' || event.target.id === 'active-date-range-to') { updateActiveTableDatePreview(); return; }
  if (event.target.id === 'date-range-from' || event.target.id === 'date-range-to') { updateDateRangePreview(); return; }
  if (event.target.dataset.tableFilter) { const source = state.tables.get(event.target.dataset.tableFilter); source.search = event.target.value; source.page = 0; renderTable(event.target.dataset.tableFilter); flashTableLoading(event.target.dataset.tableFilter); }
});
app.addEventListener('change', event => {
  if (event.target.id === 'award-overview-date-range-from' || event.target.id === 'award-overview-date-range-to') { commitAwardDateFilter('overview'); return; }
  if (event.target.id === 'award-winners-date-range-from' || event.target.id === 'award-winners-date-range-to') { commitAwardDateFilter('winners'); return; }
  if (event.target.id === 'active-churn-start' || event.target.id === 'active-churn-end') {
    if (event.target.id === 'active-churn-start') state.activeChurn.showStart = event.target.checked;
    if (event.target.id === 'active-churn-end') state.activeChurn.showEnd = event.target.checked;
    updateActiveChurnChart(); return;
  }
  if (event.target.id === 'active-date-range-from' || event.target.id === 'active-date-range-to') {
    const from = Number(document.getElementById('active-date-range-from').value); const to = Number(document.getElementById('active-date-range-to').value);
    state.activeTableFrom = new Date(Math.min(from, to) * 86400000).toISOString().slice(0, 10); state.activeTableTo = new Date(Math.max(from, to) * 86400000).toISOString().slice(0, 10);
    setupActiveTableFilters(); loadActiveMunicipalBlock(); return;
  }
  if (event.target.id === 'award-table-date-range-from' || event.target.id === 'award-table-date-range-to') {
    const from = Number(document.getElementById('award-table-date-range-from').value); const to = Number(document.getElementById('award-table-date-range-to').value);
    state.awardTableFrom = new Date(Math.min(from, to) * 86400000).toISOString().slice(0, 10); state.awardTableTo = new Date(Math.max(from, to) * 86400000).toISOString().slice(0, 10);
    state.awardMatrixPage = 0; setupAwardTableFilters(); loadAwardMatrix(); return;
  }
  if (event.target.id === 'date-range-from' || event.target.id === 'date-range-to') { const from = Number(document.getElementById('date-range-from').value); const to = Number(document.getElementById('date-range-to').value); state.from = new Date(Math.min(from, to) * 86400000).toISOString().slice(0, 10); state.to = new Date(Math.max(from, to) * 86400000).toISOString().slice(0, 10); setupFilters(); renderCurrentPage(); return; }
  if (event.target.id === 'active-group') {
    switchActiveGroup(event.target.value);
    return;
  }
  if (event.target.id === 'global-region') { state.region = event.target.value; state.activeDrillRegion = ''; state.activeDrillMunicipality = ''; renderCurrentPage(); return; }
  if (event.target.id === 'ticket-type') { state.bilhetagemType = event.target.value; state.bilhetagem = ''; state.ticketTopPage = 0; clearTicketTopCache(); renderCurrentPage(); return; }
  if (event.target.id === 'ticket-select') { state.bilhetagem = event.target.value; state.ticketTopPage = 0; clearTicketTopCache(); renderCurrentPage(); return; }
  if (event.target.dataset.detailSelect) { const map = { participant: ['participante', 'participant'], entity: ['entidade', 'entity'], municipality: ['municipio', 'municipality'], region: ['regiao', 'regionDetail'] }; const item = map[event.target.dataset.detailSelect]; state.params[item[1]] = event.target.value; state.page = item[0]; renderShell(); renderCurrentPage(); }
});

async function verifyDatamartSession() {
  const metadata = await request('verificar sessão do datamart', metaUrl(), {}, null);
  if (!Array.isArray(metadata.cubes)) throw new Error('A API não retornou os metadados do datamart.');
  const cube = metadata.cubes.find(item => item.name === 'tf_participante_adesao' || item.config?.name === 'tf_participante_adesao');
  const config = cube?.config || cube;
  const hierarchy = config?.hierarchies?.find(item => item.name === 'localizacao_fiscal');
  if (hierarchy && Array.isArray(hierarchy.levels)) state.activeHierarchy = hierarchy;
}
function isMissingDatamartSession(error) {
  return /Datamart credentials are required|Datamart session is missing or expired|401|Unauthorized/i.test(error?.message || String(error));
}
async function initialize(showMessage) {
  if (showMessage) {
    state.cache.clear();
    state.activeMunicipalCache.clear();
    state.ticketOverviewCache = null;
  }
  renderShell();
  try {
    await verifyDatamartSession();
  } catch (error) {
    if (isMissingDatamartSession(error)) {
      connectionModal();
      showToast('Informe suas credenciais para acessar o relatório.');
    } else {
      showToast('Falha ao carregar o modelo do relatório: ' + (error?.message || String(error)), true);
    }
    return;
  }
  const [regions, snapshots] = await Promise.all([
    query('regiões fiscais', { dimensions: ['td_regiao_fiscal.nm_regiao_fiscal'], measures: ['td_regiao_fiscal.count'], order: { 'td_regiao_fiscal.nm_regiao_fiscal': 'asc' }, limit: 1000 }),
    query('último retrato de adesões', { measures: ['tf_participante_adesao.count'], timeDimensions: [{ dimension: 'tf_participante_adesao.sk_dt_adesao', granularity: 'day' }], order: { 'tf_participante_adesao.sk_dt_adesao.day': 'desc' }, limit: 1 }),
  ]);
  state.snapshot = day(val(snapshots[0], 'tf_participante_adesao.sk_dt_adesao.day'));
  populateRegions(regions);
  renderCurrentPage();
  if (showMessage) showToast('Conexão atualizada.');
}

initialize();
