import { useMemo } from 'react';
import cubejs, { HttpTransport } from '@cubejs-client/core';
import { recoverExpiredDatamartSession } from '../shared/helpers';

class SessionAwareTransport extends HttpTransport {
  request(apiMethod: string, params: Record<string, unknown>) {
    const response = super.request(apiMethod, params);
    return {
      ...response,
      subscribe: (callback) => response.subscribe(async (result, resubscribe) => {
        const responseResult = result as Response | undefined;
        if (
          responseResult
          && (responseResult.status === 401 || responseResult.status === 500)
          && typeof responseResult.clone === 'function'
        ) {
          recoverExpiredDatamartSession(await responseResult.clone().text());
        }
        return callback(result, resubscribe);
      }),
    };
  }
}

export function useCubejsApi(apiUrl: string | null, token: string | null) {
  return useMemo(() => {
    if (!token || !apiUrl || token === 'undefined') {
      return null;
    }

    return cubejs(token, {
      apiUrl,
      transport: new SessionAwareTransport({
        apiUrl,
        authorization: token,
        credentials: 'same-origin',
      }),
    });
  }, [apiUrl, token]);
}
