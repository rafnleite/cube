import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Radio, Spin, Table, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { format as formatSql } from 'sql-formatter';
import { ReloadOutlined } from '../../shared/icons/FontAwesomeIcons';

import { playgroundFetch, responseErrorMessage } from '../../shared/helpers';
import { copyToClipboard } from '../../utils';

const { Text } = Typography;
const EMPTY_COLUMN_TYPES: Record<string, string | undefined> = {};

type SampleMode = 'cube' | 'raw';

type SampleData = {
  columns: { key: string; label: string; type?: string }[];
  rows: Record<string, unknown>[];
};

type Props = {
  visible: boolean;
  cubeName: string | null;
  title?: string;
  columnTypes?: Record<string, string | undefined>;
  onClose: () => void;
};

function sampleValue(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function sampleColumnWidth(column: { key: string; label: string }, rows: Record<string, unknown>[]): number {
  const longestValue = Math.max(
    column.label.length,
    ...rows.map(row => sampleValue(row[column.key]).length),
  );
  return Math.min(420, Math.max(120, longestValue * 8 + 32));
}

function formatTotalCount(value: string | number): string {
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? new Intl.NumberFormat('pt-BR').format(numericValue)
    : String(value);
}

function extractSql(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error || '');
  const marker = 'SQL gerado:\n';
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const sqlStart = start + marker.length;
  const end = text.indexOf('\nErro do driver:', sqlStart);
  return text.slice(sqlStart, end >= 0 ? end : undefined).trim() || null;
}

function formatSampleSql(sql: string): string {
  try {
    return formatSql(sql);
  } catch (_error) {
    return sql
      .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|JOIN|ON)\s+/gi, '\n$1\n  ')
      .replace(/,\s*/g, ',\n  ');
  }
}

export function CubeSampleDataModal({
  visible,
  cubeName,
  title,
  columnTypes = EMPTY_COLUMN_TYPES,
  onClose,
}: Props) {
  const [mode, setMode] = useState<SampleMode>('cube');
  const [data, setData] = useState<SampleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState<string | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [sampleSql, setSampleSql] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!visible || !cubeName) return;
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const response = await playgroundFetch('playground/schema/sample', {
        method: 'POST',
        recoverSession: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, mode }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const rawData = await response.json();
      if (rawData.sql) setSampleSql(rawData.sql);
      setData({
        columns: rawData.columns.map((column: string) => ({
          key: column,
          label: rawData.columnLabels?.[column.toLowerCase()] || column,
          type: rawData.columnTypes?.[column.toLowerCase()]
            || (mode === 'cube'
              ? columnTypes[column.toLowerCase()]
                || columnTypes[column.split('__').pop()?.toLowerCase() || '']
              : undefined),
        })),
        rows: rawData.rows,
      });
    } catch (loadError: any) {
      const generatedSql = extractSql(loadError);
      if (generatedSql) setSampleSql(generatedSql);
      setError(loadError?.message || String(loadError));
    } finally {
      setLoading(false);
    }
  }, [columnTypes, cubeName, mode, visible]);

  const loadCount = useCallback(async () => {
    if (!visible || !cubeName) return;
    setTotalCount(null);
    setCountError(null);
    try {
      const response = await playgroundFetch('playground/schema/sample/count', {
        method: 'POST',
        recoverSession: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, mode }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const result = await response.json();
      setTotalCount(String(result.total ?? '0'));
    } catch (loadError: any) {
      setCountError(loadError?.message || String(loadError));
      setTotalCount(null);
    }
  }, [cubeName, mode, visible]);

  const loadSql = useCallback(async () => {
    if (!visible || !cubeName) return;
    setSampleSql(null);
    try {
      const response = await playgroundFetch('playground/schema/sample', {
        method: 'POST',
        recoverSession: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, mode, queryOnly: true }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const result = await response.json();
      if (result.sql) setSampleSql(result.sql);
    } catch (_error) {
      // The data request can still provide the generated SQL on failure.
    }
  }, [cubeName, mode, visible]);

  useEffect(() => {
    void loadData();
    void loadCount();
    void loadSql();
  }, [loadCount, loadData, loadSql]);

  const refresh = useCallback(() => {
    void loadData();
    void loadCount();
    void loadSql();
  }, [loadCount, loadData, loadSql]);

  const copySql = useCallback(() => {
    if (!sampleSql) return;
    void copyToClipboard(formatSampleSql(sampleSql), 'Consulta copiada');
  }, [sampleSql]);

  const shownCount = data?.rows.length ?? 25;

  return (
    <Modal
      title={`Amostra de dados — ${title || cubeName || ''}`}
      visible={visible}
      onCancel={onClose}
      maskClosable={false}
      destroyOnClose
      className="cube-modal-wide"
      footer={null}
    >
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', marginBottom: 16, gap: 8 }}>
        <Radio.Group
          value={mode}
          onChange={(event) => setMode(event.target.value as SampleMode)}
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="cube">Cubo configurado</Radio.Button>
          <Radio.Button value="raw">Tabela crua do banco</Radio.Button>
        </Radio.Group>
        <Text type="secondary">
          {!data ? null : countError ? (
            <span title={countError}>Contagem indisponível</span>
          ) : totalCount !== null && data ? (
            Number(totalCount) <= 25
              ? <>Mostrando {formatTotalCount(totalCount)} Registros</>
              : <>Mostrando {shownCount} de <strong>{formatTotalCount(totalCount)}</strong> registros</>
          ) : <>Mostrando {shownCount} registros</>}
        </Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
            Gerar nova amostra
          </Button>
          <Button icon={<CopyOutlined />} onClick={copySql} disabled={!sampleSql}>
            Copiar consulta
          </Button>
        </div>
      </div>
      {error ? (
        <Alert type="error" showIcon message="Não foi possível carregar a amostra" description={error} />
      ) : loading ? (
        <div style={{ minHeight: 180, display: 'grid', placeItems: 'center' }}>
          <Spin tip="Consultando dados..." />
        </div>
      ) : data ? (
        <Table
          size="small"
          bordered
          pagination={false}
          scroll={{ x: 'max-content' }}
          rowKey={(_row, index) => String(index)}
          dataSource={data.rows}
          columns={data.columns.map(column => ({
            title: (
              <div style={{ lineHeight: 1.2 }}>
                <div>{column.label}</div>
                {column.type ? (
                  <Text type="secondary" style={{ display: 'block', marginTop: 3, fontSize: 11, fontWeight: 400 }}>
                    {column.type}
                  </Text>
                ) : null}
              </div>
            ),
            dataIndex: column.key,
            key: column.key,
            width: sampleColumnWidth(column, data.rows),
            onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
            render: (value: unknown) => sampleValue(value),
          }))}
        />
      ) : null}
    </Modal>
  );
}
