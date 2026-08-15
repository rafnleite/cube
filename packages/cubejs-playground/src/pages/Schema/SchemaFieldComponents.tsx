import styled from 'styled-components';

const FIELD_LABEL_WIDTH = 180;

export const SchemaFieldTable = styled.div`
  width: 100%;
`;

export const SchemaFieldRow = styled.div`
  display: grid;
  grid-template-columns: ${FIELD_LABEL_WIDTH}px minmax(0, 1fr) 36px;
  width: 100%;
  margin-top: -1px;
`;

export const SchemaFieldCell = styled.div`
  position: relative;
  display: flex;
  align-items: stretch;
  min-width: 0;
  min-height: 32px;
  margin-left: -1px;
  padding: 0;
  border: 1px solid #d9d9d9;
  background: #fff;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &:focus-within {
    z-index: 2;
    border-color: #7568d8;
    box-shadow: 0 0 0 1px #7568d8, 0 3px 10px rgba(75, 70, 119, 0.16);
  }

  & > .ant-input,
  & > .ant-input-affix-wrapper,
  & > .ant-input-number,
  & > .ant-select,
  & > .ant-auto-complete {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
  }

  & .ant-input,
  & .ant-input-affix-wrapper,
  & .ant-input-number,
  & .ant-select-selector,
  & .ant-auto-complete .ant-input {
    height: 100%;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  & .ant-input-textarea textarea {
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  & .ant-select-selection-item,
  & .ant-select-selection-placeholder {
    color: rgba(0, 0, 0, 0.65) !important;
    font-size: 13px;
  }

  & > .ant-select .ant-select-selector {
    flex: 1;
    width: 100%;
    background: inherit !important;
    cursor: pointer;
  }

  & .ant-select-arrow {
    color: rgba(0, 0, 0, 0.45);
  }
`;

export const SchemaFieldLabel = styled(SchemaFieldCell)`
  align-items: center;
  margin-left: 0;
  padding: 5px 11px;
  color: rgba(0, 0, 0, 0.65);
  background: #fafafa;
  font-size: 13px;
`;

export const SchemaFieldInputCell = styled(SchemaFieldCell)`
  align-items: stretch;
`;

export const SchemaFieldHelp = styled(SchemaFieldCell)`
  justify-content: center;
  align-items: center;
  color: rgba(0, 0, 0, 0.45);
  cursor: help;
`;
