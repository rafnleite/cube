import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Radio, Spin, Table, Typography } from 'antd';
import { ReloadOutlined } from '../../shared/icons/FontAwesomeIcons';

import { playgroundFetch, responseErrorMessage } from '../../shared/helpers';

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

  const loadData = useCallback(async () => {
    if (!visible || !cubeName) return;
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const response = await playgroundFetch('playground/schema/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, mode }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const rawData = await response.json();
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
      setError(loadError?.message || String(loadError));
    } finally {
      setLoading(false);
    }
  }, [columnTypes, cubeName, mode, visible]);

  const loadCount = useCallback(async () => {
    if (!visible || !cubeName) return;
    setTotalCount(null);
    try {
      const response = await playgroundFetch('playground/schema/sample/count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, mode }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const result = await response.json();
      setTotalCount(String(result.total ?? '0'));
    } catch (_error) {
      // The sample remains useful even when the optional total count fails.
      setTotalCount(null);
    }
  }, [cubeName, mode, visible]);

  useEffect(() => {
    void loadData();
    void loadCount();
  }, [loadCount, loadData]);

  const refresh = useCallback(() => {
    void loadData();
    void loadCount();
  }, [loadCount, loadData]);

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
          {totalCount !== null && data ? (
            <>Mostrando {shownCount} de <strong>{formatTotalCount(totalCount)}</strong> registros</>
          ) : 'Mostrando 25 registros'}
        </Text>
        <Button style={{ marginLeft: 'auto' }} icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
          Gerar nova amostra
        </Button>
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
          scroll={{ x: 'max-content', y: 'calc(100vh - 230px)' }}
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
