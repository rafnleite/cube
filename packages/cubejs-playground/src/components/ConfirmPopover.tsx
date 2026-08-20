import React from 'react';
import { Popconfirm } from 'antd';
import { createGlobalStyle } from 'styled-components';

const CONFIRM_POPOVER_CLASS = 'playground-confirm-popover';

const ConfirmPopoverStyles = createGlobalStyle`
  .${CONFIRM_POPOVER_CLASS} .ant-popover-inner-content {
    box-sizing: border-box;
    min-width: 190px;
    padding: 14px 16px 12px;
  }

  .${CONFIRM_POPOVER_CLASS} .ant-popover-message {
    padding: 0 0 12px;
  }

  .${CONFIRM_POPOVER_CLASS} .ant-popover-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin: 0;
  }

  .${CONFIRM_POPOVER_CLASS} .ant-popover-buttons button {
    margin-left: 0;
  }
`;

export type ConfirmPopoverProps = React.ComponentProps<typeof Popconfirm>;

export function ConfirmPopover({
  children,
  overlayClassName,
  okText = 'Confirmar',
  cancelText = 'Cancelar',
  ...props
}: ConfirmPopoverProps) {
  const className = [CONFIRM_POPOVER_CLASS, overlayClassName].filter(Boolean).join(' ');

  return (
    <>
      <ConfirmPopoverStyles />
      <Popconfirm
        {...props}
        overlayClassName={className}
        okText={okText}
        cancelText={cancelText}
      >
        {children}
      </Popconfirm>
    </>
  );
}
