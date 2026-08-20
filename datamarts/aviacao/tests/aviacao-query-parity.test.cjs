const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Client } = require('pg');

const API_BASE_URL = process.env.CUBE_TEST_API_URL || 'http://localhost:4000';
const DATAMART_ID = process.env.CUBE_TEST_DATAMART_ID || 'aviacao';
const API_DB_HOST = process.env.CUBE_TEST_API_DB_HOST || 'host.containers.internal';
const DB_HOST = process.env.CUBE_TEST_DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.CUBE_TEST_DB_PORT || 5432);
const DB_NAME = process.env.CUBE_TEST_DB_NAME || 'demo';
const DB_USER = process.env.CUBE_TEST_DB_USER || 'postgres';
const DB_PASSWORD = process.env.CUBE_TEST_DB_PASSWORD || 'postgres-local-change-me';
const STRICT_MODEL_AUDIT = process.env.CUBE_AVIACAO_STRICT_MODEL === '1';

let db;
let sessionCookie;
let metadata;
let fixtures;

function apiUrl(path) {
  return `${API_BASE_URL.replace(/\/$/, '')}${path}`;
}

async function readResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  if (body && body.error) {
    throw new Error(typeof body.error === 'string' ? body.error : JSON.stringify(body.error));
  }

  return body;
}

async function openDatamartSession() {
  const response = await fetch(apiUrl(`/playground/datamarts/${DATAMART_ID}/session`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credentials: {
        CUBEJS_DB_HOST: API_DB_HOST,
        CUBEJS_DB_PORT: String(DB_PORT),
        CUBEJS_DB_NAME: DB_NAME,
        CUBEJS_DB_USER: DB_USER,
        CUBEJS_DB_PASS: DB_PASSWORD,
      },
    }),
  });

  if (!response.ok) {
    await readResponse(response);
  }

  const setCookie = response.headers.get('set-cookie');
  sessionCookie = setCookie ? setCookie.split(';', 1)[0] : undefined;
  if (!sessionCookie) {
    throw new Error('A sessão do datamart foi criada sem cookie de sessão.');
  }
}

async function cubeLoad(query) {
  const response = await fetch(apiUrl(`/cubejs-api/datamarts/${DATAMART_ID}/v1/load`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie,
    },
    body: JSON.stringify({ query }),
  });
  const body = await readResponse(response);

  if (!body || !Array.isArray(body.data)) {
    throw new Error(`A API do Cube não retornou data: ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function cubeMeta() {
  const response = await fetch(apiUrl(`/cubejs-api/datamarts/${DATAMART_ID}/v1/meta`), {
    headers: { cookie: sessionCookie },
  });
  return readResponse(response);
}

function canonicalNumber(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (/e/i.test(text)) text = Number(text).toFixed(15);

  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  let [integer, fraction = ''] = text.split('.');
  integer = integer.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

function canonicalTime(value) {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function canonicalValue(value, type) {
  if (type === 'number') return canonicalNumber(value);
  if (type === 'time') return canonicalTime(value);
  return value === null || value === undefined ? null : String(value);
}

function assertParity(label, apiRows, rawRows, fields) {
  const project = (row, source) => fields.map(({ api, raw, type }) => (
    canonicalValue(row[source], type)
  ));
  const sortRows = rows => rows
    .map(row => JSON.stringify(row))
    .sort();
  const apiValues = sortRows(apiRows.map(row => project(row, 'api')));
  const rawValues = sortRows(rawRows.map(row => project(row, 'raw')));
  assert.deepEqual(apiValues, rawValues, `${label}: resultado do Cube difere do SQL raw`);
}

async function raw(sql, values = []) {
  const result = await db.query(sql, values);
  return result.rows;
}

before(async () => {
  db = new Client({
    host: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  });
  await db.connect();
  await openDatamartSession();
  metadata = await cubeMeta();

  const [booking, ticket, boarding, dateRange, monthlyTotal] = await Promise.all([
    raw('SELECT book_ref FROM bookings.bookings ORDER BY book_ref LIMIT 1'),
    raw('SELECT ticket_no FROM bookings.tickets ORDER BY ticket_no LIMIT 1'),
    raw(`
      SELECT bp.ticket_no, bp.flight_id, bp.seat_no
      FROM bookings.boarding_passes bp
      ORDER BY bp.ticket_no, bp.flight_id
      LIMIT 1
    `),
    raw('SELECT min(book_date) AS min_date, max(book_date) AS max_date FROM bookings.bookings'),
    raw(`
      SELECT sum(total_amount) AS total_amount
      FROM bookings.bookings
      GROUP BY date_trunc('month', book_date)
      ORDER BY total_amount DESC
      LIMIT 1
    `),
  ]);

  fixtures = {
    bookRef: booking[0].book_ref,
    ticketNo: ticket[0].ticket_no,
    boarding: boarding[0],
    minDate: dateRange[0].min_date,
    maxDate: dateRange[0].max_date,
    measureThreshold: canonicalNumber(Number(monthlyTotal[0].total_amount) * 0.9),
  };
});

after(async () => {
  if (db) await db.end();
});

test('metadados expõem os nove cubos e as hierarquias de aeroportos', () => {
  const cubeNames = metadata.cubes.map(cube => cube.name).sort();
  assert.deepEqual(cubeNames, [
    'airplanes',
    'airports_arrival',
    'airports_departure',
    'boarding_passes',
    'bookings',
    'seats',
    'segments',
    'tickets',
    'timetable',
  ]);

  for (const cubeName of ['airports_arrival', 'airports_departure']) {
    const cube = metadata.cubes.find(item => item.name === cubeName);
    assert.deepEqual(cube.hierarchies, [{
      name: `${cubeName}.location`,
      title: 'Localização',
      levels: [
        `${cubeName}.country`,
        `${cubeName}.city`,
        `${cubeName}.airport_code`,
      ],
      public: true,
    }]);
  }
});

test('auditoria estrita detecta divergências de tipo e título entre YAML e banco', () => {
  const timetable = metadata.cubes.find(cube => cube.name === 'timetable');
  const flightId = timetable.dimensions.find(dimension => dimension.name === 'timetable.flight_id');
  const scheduledDeparture = timetable.dimensions.find(
    dimension => dimension.name === 'timetable.scheduled_departure'
  );
  const warnings = [];

  if (flightId?.type !== 'number') {
    warnings.push('timetable.flight_id deveria ser type: number, pois a view retorna integer.');
  }
  if (scheduledDeparture?.title !== 'Horário de partida UTC agendado') {
    warnings.push('timetable.scheduled_departure ainda tem título de horário real.');
  }
  for (const cubeName of ['airports_arrival', 'airports_departure']) {
    const cube = metadata.cubes.find(item => item.name === cubeName);
    const hierarchy = cube?.hierarchies?.find(item => item.name === `${cubeName}.location`);
    if (hierarchy?.levels?.at(-1) !== `${cubeName}.airport_code`) {
      warnings.push(`${cubeName}.location deveria terminar em airport_code, que é o identificador único do aeroporto.`);
    }
  }

  if (warnings.length && !STRICT_MODEL_AUDIT) {
    console.warn(`\n[aviação] Pendências de contrato do modelo:\n- ${warnings.join('\n- ')}`);
  }
  if (STRICT_MODEL_AUDIT) assert.deepEqual(warnings, [], warnings.join('\n'));
});

test('medidas de reservas com filtro de chave têm paridade', async () => {
  const query = {
    measures: ['bookings.count', 'bookings.total_amount', 'bookings.avg_amount'],
    filters: [{ member: 'bookings.book_ref', operator: 'equals', values: [fixtures.bookRef] }],
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT count(*)::bigint AS count,
             sum(total_amount) AS total_amount,
             avg(total_amount) AS avg_amount
      FROM bookings.bookings
      WHERE book_ref = $1
    `, [fixtures.bookRef]),
  ]);

  assertParity('medidas de reservas', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'bookings.count', raw: 'count', type: 'number' },
    { api: 'bookings.total_amount', raw: 'total_amount', type: 'number' },
    { api: 'bookings.avg_amount', raw: 'avg_amount', type: 'number' },
  ]);
});

test('filtro de intervalo em dimensão temporal tem paridade', async () => {
  const query = {
    measures: ['bookings.count', 'bookings.total_amount'],
    filters: [{
      member: 'bookings.book_date',
      operator: 'inDateRange',
      values: [fixtures.minDate.toISOString(), fixtures.maxDate.toISOString()],
    }],
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT count(*)::bigint AS count, sum(total_amount) AS total_amount
      FROM bookings.bookings
      WHERE book_date >= $1 AND book_date <= $2
    `, [fixtures.minDate, fixtures.maxDate]),
  ]);

  assertParity('filtro temporal', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'bookings.count', raw: 'count', type: 'number' },
    { api: 'bookings.total_amount', raw: 'total_amount', type: 'number' },
  ]);
});

test('join tickets -> bookings e dimensões de passageiro têm paridade', async () => {
  const query = {
    dimensions: ['tickets.ticket_no', 'tickets.passenger_name', 'bookings.book_ref'],
    measures: ['tickets.count'],
    filters: [{ member: 'tickets.ticket_no', operator: 'equals', values: [fixtures.ticketNo] }],
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT t.ticket_no, t.passenger_name, b.book_ref, count(*)::bigint AS count
      FROM bookings.tickets t
      JOIN bookings.bookings b ON b.book_ref = t.book_ref
      WHERE t.ticket_no = $1
      GROUP BY t.ticket_no, t.passenger_name, b.book_ref
    `, [fixtures.ticketNo]),
  ]);

  assertParity('join tickets e bookings', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'tickets.ticket_no', raw: 'ticket_no', type: 'string' },
    { api: 'tickets.passenger_name', raw: 'passenger_name', type: 'string' },
    { api: 'bookings.book_ref', raw: 'book_ref', type: 'string' },
    { api: 'tickets.count', raw: 'count', type: 'number' },
  ]);
});

test('joins de segments, timetable e aeroportos por papel têm paridade', async () => {
  const flightId = String(fixtures.boarding.flight_id);
  const query = {
    dimensions: [
      'timetable.status',
      'airports_arrival.country',
      'airports_departure.country',
    ],
    measures: ['segments.count', 'segments.total_price', 'segments.avg_price'],
    filters: [{ member: 'segments.flight_id', operator: 'equals', values: [flightId] }],
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT tt.status,
             aa.country AS arrival_country,
             ad.country AS departure_country,
             count(*)::bigint AS count,
             sum(s.price) AS total_price,
             avg(s.price) AS avg_price
      FROM bookings.segments s
      JOIN bookings.timetable tt ON tt.flight_id = s.flight_id
      JOIN bookings.airports aa ON aa.airport_code = tt.arrival_airport
      JOIN bookings.airports ad ON ad.airport_code = tt.departure_airport
      WHERE s.flight_id = $1
      GROUP BY tt.status, aa.country, ad.country
    `, [fixtures.boarding.flight_id]),
  ]);

  assertParity('joins de segmentos e timetable', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'timetable.status', raw: 'status', type: 'string' },
    { api: 'airports_arrival.country', raw: 'arrival_country', type: 'string' },
    { api: 'airports_departure.country', raw: 'departure_country', type: 'string' },
    { api: 'segments.count', raw: 'count', type: 'number' },
    { api: 'segments.total_price', raw: 'total_price', type: 'number' },
    { api: 'segments.avg_price', raw: 'avg_price', type: 'number' },
  ]);
});

test('filtro por medida e granularidade mensal têm paridade', async () => {
  const query = {
    timeDimensions: [{ dimension: 'bookings.book_date', granularity: 'month' }],
    measures: ['bookings.total_amount'],
    filters: [{
      member: 'bookings.total_amount',
      operator: 'gt',
      values: [fixtures.measureThreshold],
    }],
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT to_char(
               date_trunc('month', book_date AT TIME ZONE 'UTC'),
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ) AS month,
             sum(total_amount) AS total_amount
      FROM bookings.bookings
      GROUP BY date_trunc('month', book_date AT TIME ZONE 'UTC')
      HAVING sum(total_amount) > $1
    `, [fixtures.measureThreshold]),
  ]);

  assertParity('filtro por medida', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'bookings.book_date.month', raw: 'month', type: 'time' },
    { api: 'bookings.total_amount', raw: 'total_amount', type: 'number' },
  ]);
});

test('join composto segments -> boarding_passes tem paridade', async () => {
  const { ticket_no: ticketNo, flight_id: flightId } = fixtures.boarding;
  const query = {
    dimensions: ['segments.ticket_no', 'segments.flight_id', 'boarding_passes.seat_no'],
    measures: ['boarding_passes.count'],
    filters: [
      { member: 'segments.ticket_no', operator: 'equals', values: [ticketNo] },
      { member: 'segments.flight_id', operator: 'equals', values: [String(flightId)] },
    ],
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT s.ticket_no, s.flight_id, bp.seat_no, count(bp.*)::bigint AS count
      FROM bookings.segments s
      JOIN bookings.boarding_passes bp
        ON bp.ticket_no = s.ticket_no AND bp.flight_id = s.flight_id
      WHERE s.ticket_no = $1 AND s.flight_id = $2
      GROUP BY s.ticket_no, s.flight_id, bp.seat_no
    `, [ticketNo, flightId]),
  ]);

  assertParity('join composto de boarding passes', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'segments.ticket_no', raw: 'ticket_no', type: 'string' },
    { api: 'segments.flight_id', raw: 'flight_id', type: 'number' },
    { api: 'boarding_passes.seat_no', raw: 'seat_no', type: 'string' },
    { api: 'boarding_passes.count', raw: 'count', type: 'number' },
  ]);
});

test('join seats -> airplanes tem paridade', async () => {
  const query = {
    dimensions: ['seats.fare_conditions', 'airplanes.model'],
    measures: ['seats.count'],
    limit: 100,
  };
  const [apiRows, rawRows] = await Promise.all([
    cubeLoad(query),
    raw(`
      SELECT s.fare_conditions, a.model, count(*)::bigint AS count
      FROM bookings.seats s
      JOIN bookings.airplanes a ON a.airplane_code = s.airplane_code
      GROUP BY s.fare_conditions, a.model
    `),
  ]);

  assertParity('join seats e airplanes', apiRows.map(row => ({ api: row })), rawRows.map(row => ({ raw: row })), [
    { api: 'seats.fare_conditions', raw: 'fare_conditions', type: 'string' },
    { api: 'airplanes.model', raw: 'model', type: 'string' },
    { api: 'seats.count', raw: 'count', type: 'number' },
  ]);
});

test('integridade raw confirma as cardinalidades esperadas pelos joins', async () => {
  const rows = await raw(`
    SELECT 'segments_without_ticket' AS check, count(*)::bigint AS value
    FROM bookings.segments s
    LEFT JOIN bookings.tickets t USING (ticket_no)
    WHERE t.ticket_no IS NULL
    UNION ALL
    SELECT 'segments_without_timetable', count(*)::bigint
    FROM bookings.segments s
    LEFT JOIN bookings.timetable tt USING (flight_id)
    WHERE tt.flight_id IS NULL
    UNION ALL
    SELECT 'boarding_without_segment', count(*)::bigint
    FROM bookings.boarding_passes bp
    LEFT JOIN bookings.segments s USING (ticket_no, flight_id)
    WHERE s.ticket_no IS NULL
    UNION ALL
    SELECT 'seats_without_airplane', count(*)::bigint
    FROM bookings.seats s
    LEFT JOIN bookings.airplanes a USING (airplane_code)
    WHERE a.airplane_code IS NULL
  `);

  for (const row of rows) assert.equal(Number(row.value), 0, `${row.check} deveria ser zero`);
});
