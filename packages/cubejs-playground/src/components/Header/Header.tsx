import {
  ArrowRightOutlined,
  FileFilled,
  MenuOutlined,
} from '@ant-design/icons';
import { Dropdown, Layout, Menu, message } from 'antd';
import { useState } from 'react';
import { useMediaQuery } from 'react-responsive';
import { Link } from 'react-router-dom';
import styled from 'styled-components';

import { StyledMenu, StyledMenuButton, StyledMenuItem } from './Menu';
import { ConfirmPopover } from '../ConfirmPopover';
import { usePlaygroundContext } from '../../hooks';

const StyledHeader = styled(Layout.Header)`
  && {
    background-color: var(--dark-02-color);
    color: white;
    padding: 0 16px;
    line-height: 44px;
    height: 48px;
  }
`;

type Props = {
  selectedKeys: string[];
};

async function leaveActiveProject() {
  const response = await fetch('playground/datamarts/session', { method: 'DELETE' });
  if (!response.ok) {
    throw new Error('Não foi possível sair do projeto');
  }

  window.location.reload();
}

function LeaveProjectAction({ mobile = false }: { mobile?: boolean }) {
  const [leaving, setLeaving] = useState(false);

  async function handleConfirm() {
    setLeaving(true);
    try {
      await leaveActiveProject();
    } catch (error) {
      setLeaving(false);
      message.error(error instanceof Error ? error.message : 'Não foi possível sair do projeto');
    }
  }

  const action = mobile ? (
    <span>
      <ArrowRightOutlined />
      Sair do projeto
    </span>
  ) : (
    <StyledMenuButton
      as="button"
      type="button"
      noMargin
      disabled={leaving}
      aria-label="Sair do projeto ativo"
    >
      <ArrowRightOutlined />
      Sair do projeto
    </StyledMenuButton>
  );

  return (
    <ConfirmPopover
      title="Sair do projeto ativo?"
      onConfirm={handleConfirm}
      okButtonProps={{ loading: leaving }}
    >
      {action}
    </ConfirmPopover>
  );
}

export default function Header({ selectedKeys }: Props) {
  const playgroundContext = usePlaygroundContext();
  const isDesktopOrLaptop = useMediaQuery({
    query: '(min-width: 992px)',
  });

  const isMobileOrTable = useMediaQuery({
    query: '(max-width: 991px)',
  });

  const hasActiveProject = Boolean(
    playgroundContext.multiDatamart?.enabled
    && playgroundContext.multiDatamart.activeDatamart
  );

  return (
    <StyledHeader>
      <div style={{ float: 'left' }}>
        <img
          src="./cube-core-logo-adapted_for_dark_bg.svg"
          style={{ height: 28, marginRight: 28 }}
          alt=""
        />
      </div>

      {isDesktopOrLaptop && (
        <StyledMenu theme="light" mode="horizontal" selectedKeys={selectedKeys}>
          <StyledMenuItem key="/build">
            <Link to="/build">Consultas</Link>
          </StyledMenuItem>

          <StyledMenuItem key="/schema">
            <Link to="/schema">Modelo de dados</Link>
          </StyledMenuItem>

          <StyledMenuItem key="/frontend-integrations">
            <Link to="/frontend-integrations">Integrações frontend</Link>
          </StyledMenuItem>

          <StyledMenuItem key="/cube-bi">
            <Link to="/cube-bi">Cube BI</Link>
          </StyledMenuItem>

          {hasActiveProject && <LeaveProjectAction />}

          <StyledMenuButton
            key="docs"
            href="https://cube.dev/docs/introduction"
            target="_blank"
          >
            <FileFilled />
            Documentação
          </StyledMenuButton>
        </StyledMenu>
      )}

      {isMobileOrTable && (
        <div style={{ float: 'right' }}>
          <Dropdown
            overlay={
              <Menu>
                <Menu.Item key="/build">
                  <Link to="/build">Consultas</Link>
                </Menu.Item>

                <Menu.Item key="/schema">
                  <Link to="/schema">Modelo de dados</Link>
                </Menu.Item>

                {hasActiveProject && (
                  <Menu.Item key="leave-project">
                    <LeaveProjectAction mobile />
                  </Menu.Item>
                )}
              </Menu>
            }
          >
            <MenuOutlined />
          </Dropdown>
        </div>
      )}
    </StyledHeader>
  );
}
