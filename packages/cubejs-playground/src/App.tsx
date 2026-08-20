/* eslint-disable no-undef,react/jsx-no-target-blank */
import '@ant-design/compatible/assets/index.css';
import { Alert, Layout } from 'antd';
import { Component, PropsWithChildren, useEffect } from 'react';
import { RouteComponentProps, withRouter } from 'react-router-dom';
import styled from 'styled-components';
import { Root } from '@cube-dev/ui-kit';

import { CubeLoader } from './atoms';
import { AppContextConsumer, PlaygroundContext } from './components/AppContext';
import GlobalStyles from './components/GlobalStyles';
import Header from './components/Header/Header';
import { LivePreviewContextProvider } from './components/LivePreviewContext/LivePreviewContextProvider';
import {
  event,
  setAnonymousId,
  setTelemetry,
  setTracker,
  trackImpl,
} from './events';
import { useAppContext } from './hooks';
import { QUERY_BUILDER_COLOR_TOKENS } from './QueryBuilderV2';
import { DatamartSelector } from './components/DatamartSelector/DatamartSelector';
import { recoverExpiredDatamartSession, responseErrorMessage } from './shared/helpers';

const StyledLayoutContent = styled(Layout.Content)`
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  display: flex;

  > * {
    width: 100%;
    min-width: 0;
    flex: 1 1 auto;
  }
`;

type AppState = {
  fatalError: Error | null;
  context: PlaygroundContext | null;
  showLoader: boolean;
  isAppContextSet: boolean;
};

const ROOT_STYLES = {
  height: '100vh',
  minHeight: '100vh',
  overflow: 'hidden',
  display: 'grid',
  gridTemplateRows: 'min-content 1fr',
  ...QUERY_BUILDER_COLOR_TOKENS,
};

class App extends Component<PropsWithChildren<RouteComponentProps>, AppState> {
  static getDerivedStateFromError(error) {
    return { fatalError: error };
  }

  state: AppState = {
    fatalError: null,
    context: null,
    showLoader: false,
    isAppContextSet: false,
  };

  private datamartSessionMonitor: number | null = null;

  async loadContext() {
    const res = await fetch('playground/context');
    if (!res.ok) {
      const errorText = await responseErrorMessage(res);
      if (/Datamart session is missing or expired|Datamart credentials are required/i.test(errorText)) {
        recoverExpiredDatamartSession(errorText);
        return;
      }
      throw new Error(errorText || `Falha ao carregar o contexto (${res.status})`);
    }
    const context = await res.json();

    setTelemetry(context.telemetry);
    setTracker(trackImpl);
    setAnonymousId(context.anonymousId, {
      coreServerVersion: context.coreServerVersion,
      projectFingerprint: context.projectFingerprint,
      isDocker: Boolean(context.isDocker),
      dockerVersion: context.dockerVersion,
    });

    this.setState({ context, isAppContextSet: false });
  }

  async componentDidMount() {
    setTimeout(() => this.setState({ showLoader: true }), 700);

    window.addEventListener('unhandledrejection', (promiseRejectionEvent) => {
      const error = promiseRejectionEvent.reason;
      console.log(error);
      const e = (error.stack || error).toString();
      event('Playground Error', {
        error: e,
      });
    });

    await this.loadContext();
    this.datamartSessionMonitor = window.setInterval(() => {
      void this.checkDatamartSession();
    }, 30000);
  }

  componentWillUnmount() {
    if (this.datamartSessionMonitor !== null) {
      window.clearInterval(this.datamartSessionMonitor);
      this.datamartSessionMonitor = null;
    }
  }

  async checkDatamartSession() {
    if (!this.state.context?.multiDatamart?.enabled || !this.state.context.multiDatamart.activeDatamart) {
      return;
    }

    try {
      const response = await fetch('playground/context', { cache: 'no-store' });
      if (!response.ok) {
        const errorText = await responseErrorMessage(response);
        recoverExpiredDatamartSession(errorText);
        return;
      }
      const context = await response.json();
      if (!context.multiDatamart?.activeDatamart) {
        recoverExpiredDatamartSession('Datamart session is missing or expired');
      }
    } catch (_e) {
      // A temporary context request failure must not interrupt the playground.
    }
  }

  componentDidCatch(error, info) {
    event('Playground Error', {
      error: (error.stack || error).toString(),
      info: info.toString(),
    });
  }

  render() {
    const { location, children } = this.props;
    const { context, fatalError, isAppContextSet, showLoader } = this.state;

    if (context?.multiDatamart?.enabled && !context.multiDatamart.activeDatamart) {
      return <DatamartSelector onReady={() => this.loadContext()} />;
    }

    if (context != null && !isAppContextSet) {
      return (
        <>
          <ContextSetter context={context} />
          <AppContextConsumer
            onReady={() => this.setState({ isAppContextSet: true })}
          />
        </>
      );
    }

    if (context == null && !isAppContextSet) {
      return showLoader ? <CubeLoader /> : null;
    }

    if (fatalError) {
      console.log(fatalError.stack);
    }

    return (
      <LivePreviewContextProvider
        disabled={!context?.livePreview}
      >
        <Root publicUrl="." styles={ROOT_STYLES}>
          <GlobalStyles />

          <Header selectedKeys={[location.pathname]} />

          <StyledLayoutContent>
            {fatalError ? (
              <Alert
                message="Ocorreu um erro ao renderizar a página"
                description={fatalError.stack || ''}
                type="error"
              />
            ) : (
              children
            )}
          </StyledLayoutContent>
        </Root>
      </LivePreviewContextProvider>
    );
  }
}

type ContextSetterProps = {
  context: PlaygroundContext;
};

function ContextSetter({ context }: ContextSetterProps) {
  const { setContext } = useAppContext();

  useEffect(() => {
    if (context !== null) {
      setContext({
        ready: true,
        playgroundContext: {
          ...context,
          isCloud: false,
        },
        identifier: context.identifier,
      });
    }
  }, [context]);

  return null;
}

export default withRouter(App);
