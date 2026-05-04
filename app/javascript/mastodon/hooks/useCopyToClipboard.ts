import { useCallback, useState } from 'react';

import { useIntl } from 'react-intl';

import { showAlert } from 'mastodon/actions/alerts';
import { useAppDispatch } from 'mastodon/store';

export function useCopyToClipboard(text: string | null | undefined) {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const [wasCopied, setWasCopied] = useState(false);

  const copyToClipboard = useCallback(() => {
    if (text) {
      void navigator.clipboard.writeText(text);
      setWasCopied(true);
      dispatch(
        showAlert({
          message: intl.formatMessage({
            id: 'copy_icon_button.copied',
            defaultMessage: 'Copied to clipboard',
          }),
        }),
      );
      setTimeout(() => {
        setWasCopied(false);
      }, 1000);
    }
  }, [dispatch, text, intl]);

  return { wasCopied, copyToClipboard };
}
