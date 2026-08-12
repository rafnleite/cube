import { CubeApi, Query, TransformedQuery } from '@cubejs-client/core';
import { AvailableMembers } from '@cubejs-client/react';
import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

import { useToggle } from '../hooks';
import { SchemaFormat } from '../types';
import { RollupDesignerModal } from './components/RollupDesignerModal';

type RollupDesignerContextValue = {
  error: Error | null;
  isLoading: boolean;
  isModalOpen: boolean;
  toggleModal: (isOpen?: boolean) => void;
  memberTypeCubeMap: AvailableMembers;
  query: Query | null;
  setQuery: (query: Query | null) => void;
  transformedQuery: TransformedQuery | null;
  setTransformedQuery: (transformedQuery: TransformedQuery | null) => void;
  defaultSchemaFormat: SchemaFormat
};

export const Context = createContext<RollupDesignerContextValue>(
  {} as RollupDesignerContextValue
);

type ContextProps = {
  apiUrl: string;
  children: ReactNode;
  cubeApi?: CubeApi;
  token?: string;
  defaultSchemaFormat?: SchemaFormat
};

export function RollupDesignerContext({
  cubeApi,
  children,
  ...props
}: ContextProps) {
  const [isModalOpen, toggleModal] = useToggle();
  const [error, setError] = useState<Error | null>(null);
  const [query, setQuery] = useState<Query | null>(null);
  const [transformedQuery, setTransformedQuery] =
    useState<TransformedQuery | null>(null);
  const [isMetaLoading, setMetaLoading] = useState<boolean>(false);
  const [isDryRunLoading, setDryRunLoading] = useState<boolean>(false);
  const [memberTypeCubeMap, setMemberTypeCubeMap] = useState<AvailableMembers>({
    measures: [],
    dimensions: [],
    segments: [],
    timeDimensions: [],
  });

  useEffect(() => {
    let active = true;

    if (!isModalOpen || !cubeApi) {
      return () => {
        active = false;
      };
    }

    setMetaLoading(true);
    setError(null);

    cubeApi
      .meta()
      .then((response: any) => {
        if (!active) {
          return;
        }

        setMemberTypeCubeMap(response.membersGroupedByCube());
      })
      .catch((e: Error) => {
        if (active) {
          setError(e);
        }
      })
      .finally(() => {
        if (active) {
          setMetaLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [isModalOpen, cubeApi]);

  useEffect(() => {
    let active = true;

    if (!isModalOpen || !query || !cubeApi) {
      return () => {
        active = false;
      };
    }

    setDryRunLoading(true);

    cubeApi
      .dryRun(query)
      .then((response: any) => {
        if (!active) {
          return;
        }

        setTransformedQuery(response?.transformedQueries?.[0] || null);
      })
      .catch((e: Error) => {
        if (active) {
          setError(e);
        }
      })
      .finally(() => {
        if (active) {
          setDryRunLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [isModalOpen, query, cubeApi]);

  function reset() {
    setTransformedQuery(null);
    setError(null);
  }

  return (
    <Context.Provider
      value={{
        isLoading: isMetaLoading || isDryRunLoading,
        isModalOpen,
        toggleModal,
        query,
        setQuery,
        transformedQuery,
        setTransformedQuery,
        memberTypeCubeMap,
        error,
        defaultSchemaFormat: props.defaultSchemaFormat || SchemaFormat.js
      }}
    >
      {children}

      <RollupDesignerModal apiUrl={props.apiUrl} token={props.token} onAfterClose={reset} />
    </Context.Provider>
  );
}

export function useRollupDesignerContext() {
  return useContext(Context);
}
