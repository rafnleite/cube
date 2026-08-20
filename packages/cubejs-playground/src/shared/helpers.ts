export function notEmpty<T>(value: T | null | undefined): value is T {
  return value != null;
}

export function ucfirst(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

export async function responseErrorMessage(response: Response, includeDetails = true): Promise<string> {
  const body = await response.text();
  try {
    const payload = JSON.parse(body);
    const messages = includeDetails ? [payload.error, payload.details] : [payload.error];
    return messages.filter(Boolean).join('\n') || body;
  } catch (_e) {
    return body || `Erro HTTP ${response.status}`;
  }
}

let datamartSessionRecoveryStarted = false;

export function recoverExpiredDatamartSession(errorText: string) {
  if (
    datamartSessionRecoveryStarted
    || !/Datamart session is missing or expired|Datamart credentials are required/i.test(errorText)
  ) {
    return;
  }

  datamartSessionRecoveryStarted = true;
  void fetch('playground/datamarts/session', { method: 'DELETE' })
    .catch(() => undefined)
    .finally(() => window.location.reload());
}

export function playgroundFetch(url, options: any = {}) {
  const { retries = 0, recoverSession = true, ...restOptions } = options;

  return fetch(url, restOptions)
    .then(async (r) => {
      if (recoverSession && (r.status === 401 || r.status === 500)) {
        let errorText = await r.clone().text();
        try {
          const json = JSON.parse(errorText);
          errorText = [json.error, json.details].filter(Boolean).join('\n') || errorText;
        } catch (e: any) {
          // Nothing
        }
        recoverExpiredDatamartSession(errorText);
      }
      if (r.status === 500) {
        let errorText = await r.text();
        try {
          const json = JSON.parse(errorText);
          errorText = json.error || errorText;
        } catch (e: any) {
          // Nothing
        }
        throw errorText;
      }
      return r;
    })
    .catch((e) => {
      if (e.message === 'Network request failed' && retries > 0) {
        return playgroundFetch(url, { ...restOptions, recoverSession, retries: retries - 1 });
      }
      throw e;
    });
}


type OpenWindowOptions = {
  url: string;
  width?: number;
  height?: number;
  title?: string;
};

export function openWindow({
  url,
  title = '',
  width = 640,
  height = 720,
}: OpenWindowOptions) {
  const dualScreenLeft =
    window.screenLeft !== undefined ? window.screenLeft : window.screenX;
  const dualScreenTop =
    window.screenTop !== undefined ? window.screenTop : window.screenY;

  const w = window.innerWidth
    ? window.innerWidth
    : document.documentElement.clientWidth
    ? document.documentElement.clientWidth
    : screen.width;
  const h = window.innerHeight
    ? window.innerHeight
    : document.documentElement.clientHeight
    ? document.documentElement.clientHeight
    : screen.height;

  const systemZoom = w / window.screen.availWidth;
  const left = (w - width) / 2 / systemZoom + dualScreenLeft;
  const top = (h - height) / 2 / systemZoom + dualScreenTop;

  const newWindow = window.open(
    url,
    title,
    `
      scrollbars=yes,
      width=${width / systemZoom},
      height=${height / systemZoom},
      top=${top},
      left=${left}
    `
  );

  newWindow?.focus?.();

  return newWindow;
}
